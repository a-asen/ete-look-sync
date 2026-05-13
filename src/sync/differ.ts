// Compute the (create, update, delete, unchanged) plan for one sync run.
//
// Given the fresh list of events from fetch/owa and what the store
// already knows, produce four sets:
//
//   - creates    — events new since last run, in window, not in the past
//   - updates    — contentHash changed, paired with the existing row so
//                  the writer can target the right remote resource
//   - deletes    — stored rows whose itemId no longer appears upstream,
//                  scoped to the fetch window (otherwise we cannot tell
//                  "deleted" from "outside what we asked for")
//   - unchanged  — same hash, used to bump last_seen_at
//
// A hard cutoff (default today − 2 days, UTC) excludes any past event
// from all of the above. The two-day grace exists because Exchange
// occasionally backdates last-minute changes and we'd rather miss the
// rare retroactive edit than rewrite history every run.
//
// Pure logic — no I/O, no deps beyond models.

import { contentHash, type Event } from "../models.js";
import type { StoredRow } from "../store.js";

// How many days of past events we keep eligible for update/delete.
// Beyond this all changes are absorbed silently — the user explicitly
// asked for a frozen past so accidental mass-rewrites are impossible.
export const PAST_GRACE_DAYS = 2;

export interface Diff {
  creates: Event[];
  updates: Array<{ event: Event; row: StoredRow }>;
  deletes: StoredRow[];
  unchanged: string[];
  /** Counter for events whose start is before the cutoff. Logging only. */
  frozenPast: number;
  /** Counter for rows outside the fetch window. Logging only. */
  outOfWindow: number;
}

export interface DiffOptions {
  fetchStart: Date;
  fetchEnd: Date;
  /** Override today − PAST_GRACE_DAYS. Tests should always set this. */
  cutoff?: Date;
}

/**
 * Diff `freshEvents` against `storedRows` and return the write plan.
 *
 * `fetchStart`/`fetchEnd` must be the bounds we just queried — they
 * scope the "delete" decision so a stored event outside the window
 * cannot be wrongly classified as deleted upstream.
 */
export function computeDiff(
  freshEvents: readonly Event[],
  storedRows: readonly StoredRow[],
  opts: DiffOptions,
): Diff {
  const cutoffDate = opts.cutoff ?? defaultCutoff();
  // "YYYY-MM-DD" sorts lexicographically before any same-day ISO
  // datetime ("YYYY-MM-DDTHH:MM:SSZ"), so event.startIso < cutoffIso
  // correctly excludes only events that start on a date strictly
  // before the cutoff date.
  const cutoffIso = dateOnly(cutoffDate);
  const windowStartIso = isoSecondsUtc(opts.fetchStart);
  const windowEndIso = isoSecondsUtc(opts.fetchEnd);

  const creates: Event[] = [];
  const updates: Array<{ event: Event; row: StoredRow }> = [];
  const unchanged: string[] = [];
  let frozenPast = 0;

  const storedById = new Map<string, StoredRow>();
  for (const row of storedRows) storedById.set(row.itemId, row);

  const freshIds = new Set<string>();
  for (const event of freshEvents) {
    if (!event.itemId) continue;
    freshIds.add(event.itemId);
    if (event.startIso < cutoffIso) {
      frozenPast++;
      continue;
    }
    const existing = storedById.get(event.itemId);
    if (existing === undefined) {
      creates.push(event);
    } else if (existing.pushError !== null) {
      // Previous push failed — re-attempt with fresh data from Exchange.
      creates.push(event);
    } else if (existing.contentHash !== contentHash(event)) {
      updates.push({ event, row: existing });
    } else {
      unchanged.push(event.itemId);
    }
  }

  const deletes: StoredRow[] = [];
  let outOfWindow = 0;
  for (const row of storedRows) {
    if (freshIds.has(row.itemId)) continue;
    if (row.startIso < cutoffIso) {
      // Past events are frozen — never delete them even if they
      // vanished upstream. Users want their historical record of
      // what they actually attended to be untouched.
      continue;
    }
    if (row.startIso < windowStartIso || row.startIso >= windowEndIso) {
      // We didn't ask Exchange about this event this run, so we
      // can't tell whether it was deleted or simply outside the
      // window — leave it alone.
      outOfWindow++;
      continue;
    }
    deletes.push(row);
  }

  return { creates, updates, deletes, unchanged, frozenPast, outOfWindow };
}

// ---------- internals ----------

function defaultCutoff(): Date {
  const now = new Date();
  return new Date(now.getTime() - PAST_GRACE_DAYS * 86400_000);
}

function dateOnly(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

// Matches the Python differ's window-bound format: no fractional
// seconds and no `Z` suffix. The lack of a trailing `Z` is deliberate:
// `event.startIso` ("…Z") sorts strictly greater than this prefix at
// the same wall-clock instant, so a row at exactly the window start
// is not falsely classified as out-of-window.
function isoSecondsUtc(dt: Date): string {
  return dt.toISOString().slice(0, 19);
}
