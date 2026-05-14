// Calendar fetch via OWA's FindItem + GetItem actions over service.svc.
//
// Two-phase fetch:
//   1. FindItem with CalendarPageView pages over the date window and
//      returns item IDs. OWA does not include body content in FindItem
//      results even when explicitly requested — this is standard
//      Exchange behaviour.
//   2. GetItem in batches of `GETITEM_BATCH_SIZE` fetches the full
//      event data (including `item:Body`) for each item ID collected
//      above.
//
// Callers see a single flat array of Events.

import { callService, type Session } from "../auth/session.js";
import type { Config } from "../config.js";
import { getLogger } from "../log.js";
import type { Event } from "../models.js";
import { parseEvent } from "./parse.js";

const log = getLogger("fetch/owa");

// OWA returns up to MaxEntriesReturned items per FindItem call.
export const PAGE_SIZE = 1000;

// Exchange limits GetItem batch size; 100 is well within all known limits.
export const GETITEM_BATCH_SIZE = 100;

// Exchange's CalendarPageView silently returns 0 items for windows
// wider than ~2 years. Chunk large requests into at most this many
// days each.
export const CHUNK_DAYS = 365;

// Full property set requested in GetItem. Body is only returned here,
// not in FindItem — hence the two-phase design.
const EVENT_PROPERTIES = [
  "item:Subject",
  "item:Body",
  "item:DateTimeCreated",
  "item:LastModifiedTime",
  "item:WebClientReadFormQueryString",
  "calendar:Start",
  "calendar:End",
  "calendar:IsAllDayEvent",
  "calendar:Location",
  "calendar:Organizer",
  "calendar:RequiredAttendees",
  "calendar:OptionalAttendees",
  "calendar:Resources",
  "calendar:IsRecurring",
  "calendar:IsCancelled",
  "calendar:LegacyFreeBusyStatus",
  "calendar:TimeZone",
] as const;

/** Raised when service.svc returns a non-2xx or a JSON-shaped error. */
export class FetchError extends Error {
  override readonly name = "FetchError";
}

/** Per-action POST closure — lets tests inject a fake without going through real HTTP. */
export type ServiceCaller = (action: string, body: unknown) => Promise<Response>;

interface ItemIdRef {
  Id: string;
  ChangeKey: string;
}

/**
 * Return all events whose start falls in `[start, end)`.
 *
 * Transparently chunks windows wider than `CHUNK_DAYS` into multiple
 * FindItem calls to work around Exchange's CalendarPageView limit.
 *
 * Phase 1: paginated FindItem per chunk to collect ItemIds.
 * Phase 2: batched GetItem across all collected IDs.
 */
export async function fetchCalendarView(
  session: Session,
  cfg: Config,
  start: Date,
  end: Date,
): Promise<Event[]> {
  // Wrap any callService failure (DNS, TLS handshake, undici
  // `fetch failed` TypeErrors) in FetchError so the orchestrator's
  // catch block records it in SyncSummary.errors instead of letting
  // a TypeError bubble out as a crash.
  return fetchCalendarViewWith(
    async (action, body) => {
      try {
        return await callService(session, cfg, action, body);
      } catch (err) {
        if (err instanceof FetchError) throw err;
        throw new FetchError(
          `${action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    start,
    end,
  );
}

/** Same as `fetchCalendarView` but with an injected service caller. Exported for tests. */
export async function fetchCalendarViewWith(
  call: ServiceCaller,
  start: Date,
  end: Date,
): Promise<Event[]> {
  const chunks = splitWindow(start, end);

  // Keyed by item Id to deduplicate across chunk boundaries.
  const allIds = new Map<string, ItemIdRef>();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (chunks.length > 1) {
      log.info(
        `[fetch] chunk ${i + 1}/${chunks.length}: ${dateOnly(chunk[0])} → ${dateOnly(chunk[1])}`,
      );
    }
    for (const ref of await findItemIds(call, chunk[0], chunk[1])) {
      allIds.set(ref.Id, ref);
    }
  }

  if (allIds.size === 0) return [];

  const events: Event[] = [];
  const idList = [...allIds.values()];
  const totalBatches = Math.ceil(idList.length / GETITEM_BATCH_SIZE);
  for (let i = 0, batchNum = 1; i < idList.length; i += GETITEM_BATCH_SIZE, batchNum++) {
    const batch = idList.slice(i, i + GETITEM_BATCH_SIZE);
    log.debug(`[fetch] GetItem batch ${batchNum}/${totalBatches} (${batch.length} IDs)`);
    events.push(...await getItemsBatch(call, batch));
  }
  return events;
}

export function splitWindow(start: Date, end: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  let chunkStart = start;
  const chunkMillis = CHUNK_DAYS * 24 * 60 * 60 * 1000;
  while (chunkStart.getTime() < end.getTime()) {
    const candidateEnd = new Date(chunkStart.getTime() + chunkMillis);
    const chunkEnd = candidateEnd.getTime() < end.getTime() ? candidateEnd : end;
    out.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd;
  }
  return out;
}

// ---------------------------------------------------------------------
// Phase 1: collect item IDs via FindItem
// ---------------------------------------------------------------------

async function findItemIds(
  call: ServiceCaller,
  start: Date,
  end: Date,
): Promise<ItemIdRef[]> {
  const ids: ItemIdRef[] = [];
  let offset = 0;
  while (true) {
    const body = buildFindItemBody(start, end, offset, PAGE_SIZE);
    const resp = await call("FindItem", body);
    if (resp.status !== 200) {
      const text = (await resp.text()).slice(0, 400);
      throw new FetchError(`FindItem returned HTTP ${resp.status}: ${JSON.stringify(text)}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const [pageItems, lastInRange] = extractFindPage(data);
    log.debug(
      `[fetch] FindItem offset=${offset} → ${pageItems.length} items (last=${lastInRange})`,
    );
    for (const item of pageItems) {
      const itemId = asObject(item["ItemId"]);
      const id = stringField(itemId["Id"]);
      if (id) {
        ids.push({ Id: id, ChangeKey: stringField(itemId["ChangeKey"]) });
      }
    }
    if (lastInRange || pageItems.length === 0) break;
    offset += pageItems.length;
  }
  return ids;
}

function buildFindItemBody(
  start: Date,
  end: Date,
  offset: number,
  pageSize: number,
): Record<string, unknown> {
  // FindItem with IdOnly shape — we only need the IDs here; body comes from GetItem.
  return {
    __type: "FindItemJsonRequest:#Exchange",
    Header: {
      __type: "JsonRequestHeaders:#Exchange",
      RequestServerVersion: "Exchange2013",
      TimeZoneContext: {
        __type: "TimeZoneContext:#Exchange",
        TimeZoneDefinition: {
          __type: "TimeZoneDefinitionType:#Exchange",
          Id: "UTC",
        },
      },
    },
    Body: {
      __type: "FindItemRequest:#Exchange",
      ItemShape: {
        __type: "ItemResponseShapeType:#Exchange",
        BaseShape: "IdOnly",
      },
      ParentFolderIds: [
        { __type: "DistinguishedFolderId:#Exchange", Id: "calendar" },
      ],
      Traversal: "Shallow",
      Paging: {
        __type: "CalendarPageView:#Exchange",
        StartDate: isoUtc(start),
        EndDate: isoUtc(end),
        MaxEntriesReturned: pageSize,
        Offset: offset,
      },
    },
  };
}

function extractFindPage(data: Record<string, unknown>): [Array<Record<string, unknown>>, boolean] {
  const body = asObject(data["Body"]);
  const responseMessages = asObject(body["ResponseMessages"]);
  const msgs = asArray(responseMessages["Items"]);
  if (msgs.length > 0) {
    const root = asObject(asObject(msgs[0])["RootFolder"]);
    const items = asArray(root["Items"]).filter(isObject);
    // OWA omits IncludesLastItemInRange in some responses — default
    // to true to avoid an infinite loop in the paging caller.
    const lastRaw = root["IncludesLastItemInRange"];
    const last = lastRaw === undefined ? true : Boolean(lastRaw);
    return [items, last];
  }
  return [asArray(body["Items"]).filter(isObject), true];
}

// ---------------------------------------------------------------------
// Phase 2: fetch full event data via GetItem
// ---------------------------------------------------------------------

async function getItemsBatch(
  call: ServiceCaller,
  itemIds: ItemIdRef[],
): Promise<Event[]> {
  const body = buildGetItemBody(itemIds);
  const resp = await call("GetItem", body);
  if (resp.status !== 200) {
    const text = (await resp.text()).slice(0, 400);
    throw new FetchError(`GetItem returned HTTP ${resp.status}: ${JSON.stringify(text)}`);
  }
  const data = (await resp.json()) as Record<string, unknown>;
  return extractGetItems(data).map(parseEvent);
}

function buildGetItemBody(itemIds: ItemIdRef[]): Record<string, unknown> {
  return {
    __type: "GetItemJsonRequest:#Exchange",
    Header: {
      __type: "JsonRequestHeaders:#Exchange",
      RequestServerVersion: "Exchange2013",
      TimeZoneContext: {
        __type: "TimeZoneContext:#Exchange",
        TimeZoneDefinition: {
          __type: "TimeZoneDefinitionType:#Exchange",
          Id: "UTC",
        },
      },
    },
    Body: {
      __type: "GetItemRequest:#Exchange",
      ItemShape: {
        __type: "ItemResponseShapeType:#Exchange",
        BaseShape: "IdOnly",
        AdditionalProperties: EVENT_PROPERTIES.map((uri) => ({
          __type: "PropertyUri:#Exchange",
          FieldURI: uri,
        })),
      },
      ItemIds: itemIds.map((ref) => ({
        __type: "ItemId:#Exchange",
        Id: ref.Id,
        ChangeKey: ref.ChangeKey,
      })),
    },
  };
}

function extractGetItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = asObject(data["Body"]);
  const responseMessages = asObject(body["ResponseMessages"]);
  const msgs = asArray(responseMessages["Items"]);
  const items: Array<Record<string, unknown>> = [];
  for (const msg of msgs) {
    for (const item of asArray(asObject(msg)["Items"])) {
      if (isObject(item)) items.push(item);
    }
  }
  return items;
}

// ---------- internals ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Milliseconds-precision UTC, the shape OWA expects.
function isoUtc(dt: Date): string {
  return dt.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function dateOnly(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
