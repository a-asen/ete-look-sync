// CalDAV implementation of the Backend interface.
//
// Wraps a thin `DavOps` adapter around tsdav so the rest of the codebase
// deals in Event objects and never touches PROPFIND, hrefs, or REPORT
// bodies. Two URL shapes are supported, mirroring the Python tool:
//
//   1. cfg.caldavUrl points at a calendar directly (what etesync-dav
//      exposes per calendar). We bind straight to it — no discovery.
//
//   2. cfg.caldavUrl points at a server/principal AND
//      cfg.caldavCalendarName is set. We discover the matching
//      calendar by display name.
//
// Path #1 is preferred because etesync-dav's principal discovery is
// not always wired and the PROPFIND round-trips add latency for every
// run.

// tsdav ships a CJS-default build that tsx hoists into a default
// export at runtime, while its .d.ts advertises named exports. Use
// the default + destructure pattern so both tsx (tests) and tsc-built
// dist (production) see the same set of functions without paying for
// a per-call interop dance.
import tsdav, { type DAVCalendar } from "tsdav";
const { createCalendarObject, createDAVClient, deleteCalendarObject, updateCalendarObject } = tsdav;

import type { Config } from "../../config.js";
import { getLogger } from "../../log.js";
import { caldavUid, type Event } from "../../models.js";
import { renderEvent } from "../ics.js";
import { type Backend, BackendConfigError, type PushResult, type UpsertOptions } from "../backend.js";

const log = getLogger("backends/caldav");

export interface DavResult {
  /** HTTP status of the request. */
  status: number;
  /** ETag header from the response, or empty string when absent. */
  etag: string;
  /** Resolved absolute URL of the resource (post-Location/Redirect). */
  url: string;
}

/**
 * Minimal slice of CalDAV operations the backend depends on.
 * Production binds these to tsdav; tests provide a fake.
 */
export interface DavOps {
  /** PUT a new resource into the calendar collection. */
  createObject(args: {
    calendarUrl: string;
    iCalString: string;
    filename: string;
  }): Promise<DavResult>;
  /** PUT to update an existing resource. `etag` enables If-Match when set. */
  updateObject(args: {
    url: string;
    iCalString: string;
    etag?: string;
  }): Promise<DavResult>;
  /** DELETE a resource. Servers may return 404 on already-gone resources. */
  deleteObject(args: { url: string; etag?: string }): Promise<DavResult>;
}

export class CalDAVBackend implements Backend {
  constructor(
    private readonly ops: DavOps,
    private readonly calendarUrl: string,
  ) {}

  /** Build a tsdav-backed CalDAVBackend from a Config. */
  static async open(cfg: Config): Promise<CalDAVBackend> {
    if (!cfg.caldavUrl) {
      throw new BackendConfigError(
        "caldav.url is unset; cannot push events. Point it at an " +
          "etesync-dav calendar URL or any CalDAV server's principal.",
      );
    }

    const credentials: { username?: string; password?: string } = {};
    if (cfg.caldavUsername) credentials.username = cfg.caldavUsername;
    if (cfg.caldavPassword) credentials.password = cfg.caldavPassword;

    const calendarUrl = cfg.caldavCalendarName
      ? await discoverCalendarUrl(cfg.caldavUrl, credentials, cfg.caldavCalendarName)
      : cfg.caldavUrl;

    const ops = tsdavOps({ url: calendarUrl, credentials });
    return new CalDAVBackend(ops, calendarUrl);
  }

  async upsert(event: Event, opts: UpsertOptions = {}): Promise<PushResult> {
    const ics = renderEvent(event);

    if (opts.existingId) {
      try {
        const updated = await this.ops.updateObject({
          url: opts.existingId,
          iCalString: ics,
        });
        if (updated.status < 400) {
          return { remoteId: updated.url, remoteEtag: updated.etag };
        }
        log.debug(
          `[caldav] update on ${opts.existingId} returned HTTP ${updated.status}; falling through to recreate`,
        );
      } catch (err) {
        // The server may have GC'd the resource; fall through to
        // recreate via the canonical filename below.
        log.debug(`[caldav] update on ${opts.existingId} threw ${describeError(err)}; recreating`);
      }
    }

    return this.createWithTombstoneRetry(event, ics);
  }

  async delete(remoteId: string): Promise<void> {
    // Swallow "already gone" errors so a partial-run retry does the
    // right thing instead of raising.
    try {
      const result = await this.ops.deleteObject({ url: remoteId });
      if (result.status >= 400 && result.status !== 404) {
        log.debug(`[caldav] delete on ${remoteId} returned HTTP ${result.status}; ignoring`);
      }
    } catch (err) {
      log.debug(`[caldav] delete on ${remoteId} threw ${describeError(err)}; ignoring`);
    }
  }

  // tsdav doesn't expose a session close — the underlying fetch is
  // stateless. Implement to satisfy the interface.
  close(): void {}

  private async createWithTombstoneRetry(
    event: Event,
    ics: string,
  ): Promise<PushResult> {
    const canonicalUid = caldavUid(event);
    const filename = filenameFromUid(canonicalUid);
    try {
      const result = await this.ops.createObject({
        calendarUrl: this.calendarUrl,
        iCalString: ics,
        filename,
      });
      if (result.status < 500) {
        if (result.status >= 400) {
          throw new Error(`createObject returned HTTP ${result.status}`);
        }
        return { remoteId: result.url, remoteEtag: result.etag };
      }
      // Fall through to the alt-UID retry below.
      throw new Error(`createObject returned HTTP ${result.status}`);
    } catch (firstErr) {
      // HTTP 500 on a brand-new resource almost always means an
      // EteSync tombstone: the server refuses to re-use a UID it
      // previously held. Retry once with a "-r2" suffix that has no
      // tombstone. The resulting href is persisted normally so future
      // updates use the direct-href fast path and never re-encounter
      // this issue.
      if (!isFiveHundred(firstErr)) throw firstErr;

      const altUid = canonicalUid.replace("@ete-look-sync", "-r2@ete-look-sync");
      const altIcs = ics.replace(`UID:${canonicalUid}`, `UID:${altUid}`);
      const altFilename = filenameFromUid(altUid);
      log.warn(`[caldav] 500 on ${event.subject || "(no subject)"} — tombstone conflict; retrying with alt UID`);

      try {
        const retry = await this.ops.createObject({
          calendarUrl: this.calendarUrl,
          iCalString: altIcs,
          filename: altFilename,
        });
        if (retry.status >= 400) {
          throw new Error(`alt-UID createObject returned HTTP ${retry.status}`);
        }
        return { remoteId: retry.url, remoteEtag: retry.etag };
      } catch (retryErr) {
        const firstMsg = describeError(firstErr);
        const retryMsg = describeError(retryErr);
        throw new Error(
          `CalDAV PUT failed on both canonical and alt UID: ${firstMsg}; alt: ${retryMsg}`,
        );
      }
    }
  }
}

// ---------- tsdav binding ----------

interface TsdavBinding {
  url: string;
  credentials: { username?: string; password?: string };
}

function tsdavOps(binding: TsdavBinding): DavOps {
  const headers = basicAuthHeaders(binding.credentials);
  // tsdav's createCalendarObject/updateCalendarObject/deleteCalendarObject
  // all want a DAVCalendar/DAVCalendarObject shape. For a direct
  // calendar URL we only need the `url` field populated; the rest of
  // the type is optional.
  const calendar = { url: binding.url } as DAVCalendar;

  return {
    async createObject({ calendarUrl, iCalString, filename }) {
      // tsdav builds the request URL by concatenating the calendar
      // URL and the filename, so we capture it before sending and use
      // it as the canonical resource URL regardless of what the
      // server echoes back in Location.
      const targetUrl = joinUrl(calendarUrl, filename);
      const resp = await createCalendarObject({
        calendar: { ...calendar, url: calendarUrl },
        iCalString,
        filename,
        headers,
      });
      return readResult(resp, targetUrl);
    },
    async updateObject({ url, iCalString, etag }) {
      const resp = await updateCalendarObject({
        calendarObject: { url, data: iCalString, etag: etag ?? "" },
        headers,
      });
      return readResult(resp, url);
    },
    async deleteObject({ url, etag }) {
      const resp = await deleteCalendarObject({
        calendarObject: { url, etag: etag ?? "" },
        headers,
      });
      return readResult(resp, url);
    },
  };
}

async function discoverCalendarUrl(
  serverUrl: string,
  credentials: { username?: string; password?: string },
  name: string,
): Promise<string> {
  const client = await createDAVClient({
    serverUrl,
    credentials,
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  const calendars = await client.fetchCalendars();
  const needle = name.toLowerCase();
  const match =
    calendars.find((c) => displayName(c) === name) ??
    calendars.find((c) => displayName(c).toLowerCase() === needle);
  if (!match) {
    const available = calendars.map((c) => `"${displayName(c)}"`).join(", ") || "(none)";
    throw new BackendConfigError(
      `No calendar named ${JSON.stringify(name)} on this principal. Available: ${available}`,
    );
  }
  return match.url;
}

function displayName(c: DAVCalendar): string {
  const dn = c.displayName;
  if (typeof dn === "string") return dn;
  if (dn && typeof dn === "object" && "_cdata" in dn) {
    const cdata = (dn as { _cdata?: unknown })._cdata;
    return typeof cdata === "string" ? cdata : "";
  }
  return "";
}

function readResult(resp: Response, fallbackUrl: string): DavResult {
  const location = resp.headers.get("location");
  const etag = resp.headers.get("etag") ?? "";
  const url = location ? new URL(location, fallbackUrl).toString() : fallbackUrl;
  return { status: resp.status, etag, url };
}

function basicAuthHeaders(creds: { username?: string; password?: string }): Record<string, string> {
  if (!creds.username || !creds.password) return {};
  const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

// ---------- internals ----------

function filenameFromUid(uid: string): string {
  // Strip the `@ete-look-sync` suffix and any unsafe path chars
  // before appending `.ics`. The UID itself is hex-ish + ASCII so
  // this only ever rewrites the suffix in practice.
  const stem = uid.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${stem}.ics`;
}

function joinUrl(base: string, segment: string): string {
  return base.endsWith("/") ? base + segment : base + "/" + segment;
}

function isFiveHundred(err: unknown): boolean {
  const msg = describeError(err);
  return /\b5\d\d\b/.test(msg);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
