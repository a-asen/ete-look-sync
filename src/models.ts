// Shared data types passed between fetch, store, differ, and backend layers.
//
// Keeping `Event` here (not inside `fetch/`) avoids an import cycle later:
// the differ and backends need an Event type but neither should know how
// OWA serialises one.

import { createHash } from "node:crypto";

/**
 * Calendar event, normalised away from OWA's JSON quirks.
 *
 * Field set is the union of what:
 *   - the differ needs to detect change (`contentHash` covers these),
 *   - backends need to render an RFC 5545 VEVENT,
 *   - the store needs to evaluate the past-event cutoff (`startIso`).
 *
 * Anything OWA-specific kept for forensics lives in `raw` and never
 * participates in the hash.
 */
export interface Event {
  itemId: string;          // Exchange ImmutableId — primary key everywhere downstream
  changeKey: string;       // Exchange-side change marker
  subject: string;
  startIso: string;        // ISO datetime, kept as string to avoid timezone-parse bugs at the boundary
  endIso: string;
  isAllDay: boolean;
  location: string;        // Human-readable string only; structured data goes in raw
  bodyText: string;        // Plain text body. HTML-stripped at parse time.
  organizerEmail: string;
  organizerName: string;
  attendees: readonly string[];   // Email addresses, sorted, for stable hashing
  isRecurring: boolean;
  isCancelled: boolean;
  lastModifiedIso: string;
  webLink: string;
  raw?: Record<string, unknown>;
}

/**
 * Stable SHA-256 over the user-visible fields of an event.
 *
 * Excludes `changeKey` (Exchange-internal version stamp) and `raw`
 * (kitchen-sink dict whose key order can drift). Including them would
 * make every harmless server-side touch register as a spurious update.
 *
 * The serialisation shape (sorted keys, `, ` / `: ` separators, UTF-8
 * input) is pinned by `models.test.ts` so future changes to the
 * payload can't silently break the differ.
 */
export function contentHash(event: Event): string {
  const payload = {
    subject: event.subject,
    start: event.startIso,
    end: event.endIso,
    all_day: event.isAllDay,
    location: event.location,
    body: event.bodyText,
    organizer: [event.organizerEmail, event.organizerName],
    attendees: [...event.attendees],
    recurring: event.isRecurring,
    cancelled: event.isCancelled,
  };
  return createHash("sha256")
    .update(stableStringify(payload), "utf8")
    .digest("hex");
}

/**
 * Deterministic ICS UID derived from the Exchange item id.
 *
 * Stable across runs (so re-syncs don't duplicate) and short enough
 * that CalDAV servers don't truncate it. The `@ete-look-sync` suffix
 * follows RFC 5545 by giving the UID a clear domain-style scope; the
 * CalDAV backend's tombstone-retry logic relies on it being present.
 */
export function caldavUid(event: Event): string {
  const h = createHash("sha256")
    .update(event.itemId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `ocs-${h}@ete-look-sync`;
}

// Mirrors Python's `json.dumps(payload, sort_keys=True, ensure_ascii=False)`:
//   - keys sorted lexicographically at every nesting level,
//   - `, ` between array/object items,
//   - `: ` between object key and value,
//   - non-ASCII characters emitted as-is (TextEncoder/Buffer handles UTF-8).
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}: ${stableStringify(obj[k])}`,
    );
    return `{${parts.join(", ")}}`;
  }
  throw new TypeError(`stableStringify: unsupported type ${typeof value}`);
}
