import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  CHUNK_DAYS,
  FetchError,
  GETITEM_BATCH_SIZE,
  PAGE_SIZE,
  fetchCalendarViewWith,
  splitWindow,
  type ServiceCaller,
} from "./owa.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

// Build a FindItem response that says "n items, includesLastItemInRange=last".
function findItemResponse(
  items: Array<{ id: string; changeKey?: string }>,
  last = true,
): Response {
  return jsonResponse({
    Body: {
      ResponseMessages: {
        Items: [
          {
            RootFolder: {
              Items: items.map((it) => ({
                ItemId: { Id: it.id, ChangeKey: it.changeKey ?? "ck" },
              })),
              IncludesLastItemInRange: last,
            },
          },
        ],
      },
    },
  });
}

// Build a GetItem response wrapping the given OWA CalendarItem dicts.
function getItemResponse(items: Array<Record<string, unknown>>): Response {
  return jsonResponse({
    Body: {
      ResponseMessages: {
        Items: items.map((it) => ({ Items: [it] })),
      },
    },
  });
}

function calendarItem(id: string, subject: string): Record<string, unknown> {
  return {
    ItemId: { Id: id, ChangeKey: "ck-" + id },
    Subject: subject,
    Start: "2026-05-13T08:00:00Z",
    End: "2026-05-13T09:00:00Z",
  };
}

interface CallRecord {
  action: string;
  body: Record<string, unknown>;
}

function recorder(responses: Response[]): {
  call: ServiceCaller;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let idx = 0;
  const call: ServiceCaller = async (action, body) => {
    calls.push({ action, body: body as Record<string, unknown> });
    const resp = responses[idx++];
    if (!resp) throw new Error(`No mock response queued for call #${idx} (${action})`);
    return resp;
  };
  return { call, calls };
}

test("splitWindow returns a single chunk for a small window", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-02-01T00:00:00Z");
  const chunks = splitWindow(start, end);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]![0].toISOString(), start.toISOString());
  assert.equal(chunks[0]![1].toISOString(), end.toISOString());
});

test("splitWindow chunks windows wider than CHUNK_DAYS", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date(start.getTime() + (CHUNK_DAYS * 2 + 5) * 86400_000);
  const chunks = splitWindow(start, end);
  assert.equal(chunks.length, 3);
  // Chunks must be contiguous and cover the whole range.
  assert.equal(chunks[0]![0].toISOString(), start.toISOString());
  assert.equal(chunks[2]![1].toISOString(), end.toISOString());
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i]![0].toISOString(), chunks[i - 1]![1].toISOString());
  }
});

test("splitWindow returns empty array when end <= start", () => {
  const t = new Date("2026-01-01T00:00:00Z");
  assert.deepEqual(splitWindow(t, t), []);
});

test("fetchCalendarViewWith returns [] when no items found", async () => {
  const { call, calls } = recorder([findItemResponse([])]);
  const events = await fetchCalendarViewWith(call, new Date("2026-01-01Z"), new Date("2026-02-01Z"));
  assert.deepEqual(events, []);
  // Only FindItem was called — no GetItem since the result was empty.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, "FindItem");
});

test("fetchCalendarViewWith parses GetItem results into Events", async () => {
  const { call, calls } = recorder([
    findItemResponse([{ id: "id-a" }, { id: "id-b" }]),
    getItemResponse([calendarItem("id-a", "A"), calendarItem("id-b", "B")]),
  ]);
  const events = await fetchCalendarViewWith(
    call,
    new Date("2026-01-01Z"),
    new Date("2026-02-01Z"),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]!.itemId, "id-a");
  assert.equal(events[0]!.subject, "A");
  assert.equal(events[1]!.itemId, "id-b");
  assert.equal(events[1]!.subject, "B");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.action, "GetItem");
});

test("FindItem paging follows IncludesLastItemInRange=false", async () => {
  const firstPage = Array.from({ length: 3 }, (_, i) => ({ id: `id-${i}` }));
  const secondPage = [{ id: "id-3" }];
  const { call, calls } = recorder([
    findItemResponse(firstPage, false),
    findItemResponse(secondPage, true),
    getItemResponse([
      calendarItem("id-0", "A"),
      calendarItem("id-1", "B"),
      calendarItem("id-2", "C"),
      calendarItem("id-3", "D"),
    ]),
  ]);
  const events = await fetchCalendarViewWith(
    call,
    new Date("2026-01-01Z"),
    new Date("2026-02-01Z"),
  );
  assert.equal(events.length, 4);
  // Each FindItem call carries an incremented Offset.
  const findCalls = calls.filter((c) => c.action === "FindItem");
  assert.equal(findCalls.length, 2);
  const offset0 = (((findCalls[0]!.body["Body"] as Record<string, unknown>)["Paging"] as Record<string, unknown>)["Offset"]) as number;
  const offset1 = (((findCalls[1]!.body["Body"] as Record<string, unknown>)["Paging"] as Record<string, unknown>)["Offset"]) as number;
  assert.equal(offset0, 0);
  assert.equal(offset1, 3);
});

test("FindItem requests page size = PAGE_SIZE", async () => {
  const { call, calls } = recorder([findItemResponse([])]);
  await fetchCalendarViewWith(call, new Date("2026-01-01Z"), new Date("2026-02-01Z"));
  const paging = (calls[0]!.body["Body"] as Record<string, unknown>)["Paging"] as Record<string, unknown>;
  assert.equal(paging["MaxEntriesReturned"], PAGE_SIZE);
});

test("FindItem stops if a page returns zero items", async () => {
  const { call, calls } = recorder([
    findItemResponse([], false), // empty page, server lies about last=false
  ]);
  const events = await fetchCalendarViewWith(
    call,
    new Date("2026-01-01Z"),
    new Date("2026-02-01Z"),
  );
  assert.deepEqual(events, []);
  assert.equal(calls.length, 1);
});

test("Events are deduped across chunk boundaries", async () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date(start.getTime() + (CHUNK_DAYS + 30) * 86400_000);
  // Two chunks. Each returns the same id; the second adds a new one.
  const { call } = recorder([
    findItemResponse([{ id: "shared" }]),
    findItemResponse([{ id: "shared" }, { id: "only-second" }]),
    getItemResponse([
      calendarItem("shared", "S"),
      calendarItem("only-second", "T"),
    ]),
  ]);
  const events = await fetchCalendarViewWith(call, start, end);
  assert.equal(events.length, 2);
  const ids = events.map((e) => e.itemId).sort();
  assert.deepEqual(ids, ["only-second", "shared"]);
});

test("GetItem batches respect GETITEM_BATCH_SIZE", async () => {
  const totalIds = GETITEM_BATCH_SIZE + 5;
  const ids = Array.from({ length: totalIds }, (_, i) => ({ id: `id-${i}` }));
  // Two GetItem batches: 100 + 5
  const { call, calls } = recorder([
    findItemResponse(ids),
    getItemResponse(ids.slice(0, GETITEM_BATCH_SIZE).map((r) => calendarItem(r.id, "x"))),
    getItemResponse(ids.slice(GETITEM_BATCH_SIZE).map((r) => calendarItem(r.id, "x"))),
  ]);
  const events = await fetchCalendarViewWith(
    call,
    new Date("2026-01-01Z"),
    new Date("2026-02-01Z"),
  );
  assert.equal(events.length, totalIds);
  const getCalls = calls.filter((c) => c.action === "GetItem");
  assert.equal(getCalls.length, 2);
  const itemIds0 = (getCalls[0]!.body["Body"] as Record<string, unknown>)["ItemIds"] as unknown[];
  const itemIds1 = (getCalls[1]!.body["Body"] as Record<string, unknown>)["ItemIds"] as unknown[];
  assert.equal(itemIds0.length, GETITEM_BATCH_SIZE);
  assert.equal(itemIds1.length, 5);
});

test("FetchError is thrown on non-200 from FindItem", async () => {
  const { call } = recorder([new Response("bad", { status: 500 })]);
  await assert.rejects(
    () => fetchCalendarViewWith(call, new Date("2026-01-01Z"), new Date("2026-02-01Z")),
    FetchError,
  );
});

test("FetchError is thrown on non-200 from GetItem", async () => {
  const { call } = recorder([
    findItemResponse([{ id: "id-a" }]),
    new Response("nope", { status: 503 }),
  ]);
  await assert.rejects(
    () => fetchCalendarViewWith(call, new Date("2026-01-01Z"), new Date("2026-02-01Z")),
    FetchError,
  );
});

test("FindItem request body shape matches the OWA contract", async () => {
  const { call, calls } = recorder([findItemResponse([])]);
  const start = new Date("2026-01-15T00:00:00Z");
  const end = new Date("2026-01-20T00:00:00Z");
  await fetchCalendarViewWith(call, start, end);
  const body = calls[0]!.body;
  assert.equal(body["__type"], "FindItemJsonRequest:#Exchange");
  const findBody = body["Body"] as Record<string, unknown>;
  const paging = findBody["Paging"] as Record<string, unknown>;
  assert.equal(paging["__type"], "CalendarPageView:#Exchange");
  assert.equal(paging["StartDate"], "2026-01-15T00:00:00.000Z");
  assert.equal(paging["EndDate"], "2026-01-20T00:00:00.000Z");
});

test("GetItem request body includes all expected property URIs", async () => {
  const { call, calls } = recorder([
    findItemResponse([{ id: "id-a" }]),
    getItemResponse([calendarItem("id-a", "A")]),
  ]);
  await fetchCalendarViewWith(call, new Date("2026-01-01Z"), new Date("2026-02-01Z"));
  const getBody = calls[1]!.body["Body"] as Record<string, unknown>;
  const shape = getBody["ItemShape"] as Record<string, unknown>;
  const props = shape["AdditionalProperties"] as Array<{ FieldURI: string }>;
  const uris = props.map((p) => p.FieldURI);
  for (const required of [
    "item:Subject",
    "item:Body",
    "calendar:Start",
    "calendar:End",
    "calendar:IsAllDayEvent",
    "calendar:Organizer",
  ]) {
    assert.ok(uris.includes(required), `missing FieldURI ${required}`);
  }
});
