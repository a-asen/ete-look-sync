// Content signature for remote-aware deduplication.
//
// The differ matches Outlook events against the LOCAL store by Exchange
// itemId. That's blind to what's actually on the calendar, so a wiped /
// relocated store — or a push that committed server-side but reported
// failure — makes the next run re-create everything as fresh items.
//
// A signature keys an event by what a human means by "the same event":
// name + duration. It is computed identically from a fresh `Event` and
// from a remote item's ICS, so the sync can ask "is this already there?"
// against the real collection instead of trusting local bookkeeping.
//
// Body/description is deliberately NOT part of the key: the same event
// arriving from Outlook (HTML→text, with mutating Teams/RSVP footers)
// vs. from another source rarely has byte-identical text, so requiring
// it to match would reintroduce duplicates.

import { type Event } from "../models.js";
import { formatDateCompact, formatDateTimeUtc, parseIsoToDate } from "./ics.js";

// Field delimiter for the joined "name start end" key. A plain space is
// safe: the start/end fields are fixed-shape timestamps with no spaces,
// so two different (name, start, end) tuples can't collide. Signatures
// are only ever compared/keyed whole, never split back into fields.
export const SEP = " ";

/** ICS UID suffix the tool stamps on every item it creates. */
export const TOOL_UID_SUFFIX = "@ete-look-sync";

/** Stable name+start+end key for a fresh event. */
export function eventSignature(event: Event): string {
  const name = normalizeName(event.subject || "(no subject)");
  const start = event.isAllDay
    ? formatDateCompact(event.startIso)
    : formatDateTimeUtc(parseIsoToDate(event.startIso));
  const end = event.isAllDay
    ? formatDateCompact(event.endIso)
    : formatDateTimeUtc(parseIsoToDate(event.endIso));
  return `${name}${SEP}${start}${SEP}${end}`;
}

export interface IcsSignature {
  uid: string | null;
  signature: string | null;
  /** True when the UID carries the tool's suffix — i.e. we created it. */
  isToolItem: boolean;
}

/** Parse UID + name+start+end signature out of a single-VEVENT ICS. */
export function icsSignature(content: string): IcsSignature {
  const unfolded = unfold(content);
  const uid = matchProp(unfolded, "UID")?.value ?? null;
  const summary = matchProp(unfolded, "SUMMARY");
  const dtstart = matchProp(unfolded, "DTSTART");
  const dtend = matchProp(unfolded, "DTEND");

  let signature: string | null = null;
  if (summary && dtstart && dtend) {
    const name = normalizeName(unescapeText(summary.value));
    signature = `${name}${SEP}${normalizeIcsTime(dtstart)}${SEP}${normalizeIcsTime(dtend)}`;
  }
  return {
    uid,
    signature,
    isToolItem: uid !== null && uid.endsWith(TOOL_UID_SUFFIX),
  };
}

// ---------- internals ----------

// Trim only: the same event from two sources reliably agrees on the
// trimmed subject, but collapsing internal whitespace risks merging
// genuinely distinct events, so we leave the interior alone.
function normalizeName(s: string): string {
  return s.trim();
}

interface Prop {
  params: string; // raw param segment incl. leading ";" (may be "")
  value: string;
}

function matchProp(text: string, name: string): Prop | null {
  // Property line: NAME(;params)?:value — anchored at line start.
  const re = new RegExp(`^${name}((?:;[^:\\r\\n]*))?:(.*)$`, "m");
  const m = re.exec(text);
  if (!m) return null;
  return { params: m[1] ?? "", value: m[2] ?? "" };
}

// Canonicalise an ICS date/datetime to the same shape eventSignature
// emits: "YYYYMMDD" for all-day (VALUE=DATE) and "YYYYMMDDTHHMMSSZ"
// for timed. Values already in those forms (everything this tool
// writes) pass through unchanged. TZID-qualified local times can't be
// converted without a tz database, so they're keyed by their literal
// value as a best effort — a minority case for non-tool source items.
function normalizeIcsTime(prop: Prop): string {
  const v = prop.value.trim();
  if (/VALUE=DATE(;|$)/.test(prop.params) || /^\d{8}$/.test(v)) {
    return v.slice(0, 8);
  }
  if (/^\d{8}T\d{6}Z$/.test(v)) return v; // already canonical UTC
  if (/^\d{8}T\d{6}$/.test(v) && !/TZID=/.test(prop.params)) return `${v}Z`; // naive UTC
  return v; // TZID or unexpected shape — best-effort literal key
}

// RFC 5545 §3.1 line unfolding: a CRLF (or lone LF) followed by a
// single space or tab continues the previous logical line.
function unfold(content: string): string {
  return content.replace(/\r\n[ \t]|\n[ \t]/g, "");
}

// Reverse of ics.ts escapeText. Order matters: decode "\\" last so an
// escaped backslash doesn't get re-interpreted as an escape lead-in.
function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}
