// Render an Event as a one-VEVENT VCALENDAR string.
//
// CalDAV and Etebase both want a complete RFC 5545 calendar object per
// resource (one VEVENT per resource is the conventional shape and
// matches what Radicale, Apple Calendar Server, and EteSync all
// expect). This module keeps that serialisation in one place so
// timezone handling, all-day quirks, and field mapping aren't
// scattered across the writers.
//
// Hand-rolled rather than via `ical-generator`: our spec surface is
// tiny (less than a dozen properties, no recurrence on our side,
// always UTC) and a dedicated dep would still need a wrapper just to
// pin output byte-for-byte for tests. The fewer moving parts that
// touch user-visible calendar bytes the better.

import { caldavUid, type Event } from "../models.js";

export const PRODID = "-//a-asen//ete-look-sync//EN";

const CRLF = "\r\n";
// RFC 5545 §3.1: lines SHOULD NOT exceed 75 octets including the CRLF.
// Continuation lines start with a single space, so subsequent
// segments have 74 octets of room for content.
const MAX_LINE_OCTETS = 75;

export interface RenderOptions {
  /** Override DTSTAMP. Tests should always set this; production omits to use real "now". */
  now?: Date;
}

/** Return a VCALENDAR containing exactly one VEVENT for `event`. */
export function renderEvent(event: Event, opts: RenderOptions = {}): string {
  return wrapCalendar(veventLines(event, opts));
}

/**
 * Return a single VCALENDAR with one VEVENT per event in `events`.
 *
 * Suitable for a backup ICS file: every calendar application can
 * import it and all events land in one place.
 */
export function renderAllEvents(events: readonly Event[], opts: RenderOptions = {}): string {
  const inner: string[] = [];
  for (const event of events) inner.push(...veventLines(event, opts));
  return wrapCalendar(inner);
}

// ---------- internals ----------

function wrapCalendar(inner: readonly string[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    `PRODID:${PRODID}`,
    "VERSION:2.0",
    ...inner,
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

function veventLines(event: Event, opts: RenderOptions): string[] {
  const out: string[] = [];
  out.push("BEGIN:VEVENT");
  out.push(`UID:${caldavUid(event)}`);
  out.push(`SUMMARY:${escapeText(event.subject || "(no subject)")}`);

  if (event.isAllDay) {
    out.push(`DTSTART;VALUE=DATE:${formatDateCompact(event.startIso)}`);
    out.push(`DTEND;VALUE=DATE:${formatDateCompact(event.endIso)}`);
  } else {
    out.push(`DTSTART:${formatDateTimeUtc(parseIsoToDate(event.startIso))}`);
    out.push(`DTEND:${formatDateTimeUtc(parseIsoToDate(event.endIso))}`);
  }

  if (event.location) out.push(`LOCATION:${escapeText(event.location)}`);
  if (event.bodyText) out.push(`DESCRIPTION:${escapeText(event.bodyText)}`);

  if (event.organizerEmail) {
    if (event.organizerName) {
      out.push(
        `ORGANIZER;CN=${escapeParamValue(event.organizerName)}:mailto:${event.organizerEmail}`,
      );
    } else {
      out.push(`ORGANIZER:mailto:${event.organizerEmail}`);
    }
  }

  for (const email of event.attendees) {
    out.push(`ATTENDEE:mailto:${email}`);
  }

  if (event.isCancelled) out.push("STATUS:CANCELLED");

  const lastMod = tryParseIsoToDate(event.lastModifiedIso);
  if (lastMod !== null) out.push(`LAST-MODIFIED:${formatDateTimeUtc(lastMod)}`);

  // DTSTAMP is required (RFC 5545 §3.6.1) and conventionally tracks
  // the moment the object was serialised. Using "now" gives clients a
  // monotonic update ordering even if Exchange doesn't move
  // LastModifiedTime for every change.
  out.push(`DTSTAMP:${formatDateTimeUtc(opts.now ?? new Date())}`);

  out.push("END:VEVENT");
  return out;
}

// ---------- ISO parsing / formatting ----------

// OWA emits times in two shapes depending on Exchange version: with
// trailing Z or naive ("2026-05-13T08:00:00" — interpreted as UTC
// because our request set TimeZoneContext=UTC). Both parse here
// without branching downstream.
function parseIsoToDate(iso: string): Date {
  const trimmed = iso.endsWith("Z") ? iso.slice(0, -1) : iso;
  const noFraction = trimmed.split(".")[0]!;
  const d = new Date(noFraction + "Z");
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO datetime: ${JSON.stringify(iso)}`);
  }
  return d;
}

function tryParseIsoToDate(iso: string): Date | null {
  if (!iso) return null;
  try {
    return parseIsoToDate(iso);
  } catch {
    return null;
  }
}

function formatDateTimeUtc(d: Date): string {
  // toISOString() → "2026-05-13T08:00:00.000Z"
  // → strip "-", ":", and the ".sss" fraction → "20260513T080000Z"
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function formatDateCompact(iso: string): string {
  const datePart = iso.split("T")[0] ?? "";
  return datePart.replace(/-/g, "");
}

// ---------- RFC 5545 escaping & folding ----------

// RFC 5545 §3.3.11: TEXT properties escape `\`, `;`, `,`, and newlines.
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

// RFC 5545 §3.2: parameter values containing colon, semicolon, or
// comma MUST be DQUOTE-wrapped. DQUOTE itself is forbidden inside the
// quoted value — we strip it rather than fail.
function escapeParamValue(s: string): string {
  const stripped = s.replace(/"/g, "");
  return /[,;:]/.test(stripped) ? `"${stripped}"` : stripped;
}

// RFC 5545 §3.1 line folding: a logical line longer than 75 octets is
// split into multiple physical lines separated by CRLF + a single
// linear-white-space character (we use SP). UTF-8 multi-byte
// sequences must not be split across folds, so we step back to a
// codepoint boundary before cutting.
function foldLine(line: string): string {
  const buf = Buffer.from(line, "utf8");
  if (buf.length <= MAX_LINE_OCTETS) return line;

  const segments: string[] = [];
  let start = 0;
  let budget = MAX_LINE_OCTETS;
  while (start < buf.length) {
    let end = Math.min(start + budget, buf.length);
    // Step back if we'd land inside a UTF-8 continuation byte
    // (0b10xxxxxx). Codepoint boundary check.
    while (end > start && end < buf.length && (buf[end]! & 0xc0) === 0x80) {
      end--;
    }
    segments.push(buf.slice(start, end).toString("utf8"));
    start = end;
    // Continuation lines start with one SP, leaving 74 octets of
    // room for content.
    budget = MAX_LINE_OCTETS - 1;
  }
  return segments.join(CRLF + " ");
}
