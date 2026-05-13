// One OWA CalendarItem JSON dict → normalised `Event`.
//
// OWA returns events in a nested `__type`-tagged JSON dialect; every
// quirk of that shape is encapsulated here so the rest of the codebase
// can treat events as flat data.
//
// Parity note: `Event.bodyText` and `Event.attendees` participate in
// `contentHash`, which must agree byte-for-byte with the Python
// predecessor (see src/models.ts). The HTML-to-text pipeline below is
// a literal port of Python's `parse._body_to_text`, including the
// `<br>`/block-tag → newline step, the entity decode, the `\xa0`
// folding, and the whitespace collapse — in that order.

import type { Event } from "../models.js";

const BLOCK_TAG_RE = /<(?:br\s*\/?\s*|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /[ \t]+/g;
const EXCESS_NEWLINES_RE = /\n{3,}/g;

export function parseEvent(raw: Record<string, unknown>): Event {
  const itemId = asObject(raw["ItemId"]);
  const location = asObject(raw["Location"]);
  const body = asObject(raw["Body"]);
  const organizerMailbox = asObject(asObject(raw["Organizer"])["Mailbox"]);

  return {
    itemId: stringField(itemId["Id"]),
    changeKey: stringField(itemId["ChangeKey"]),
    subject: stringField(raw["Subject"]),
    startIso: stringField(raw["Start"]),
    endIso: stringField(raw["End"]),
    isAllDay: Boolean(raw["IsAllDayEvent"]),
    location: stringField(location["DisplayName"]),
    bodyText: bodyToText(body),
    organizerEmail: stringField(organizerMailbox["EmailAddress"]),
    organizerName: stringField(organizerMailbox["Name"]),
    attendees: collectAttendees(raw),
    isRecurring: Boolean(raw["IsRecurring"]),
    isCancelled: Boolean(raw["IsCancelled"]),
    lastModifiedIso: stringField(raw["LastModifiedTime"]),
    webLink: stringField(raw["WebClientReadFormQueryString"]),
    raw,
  };
}

// Returns the plain-text rendering of an OWA Body dict.
//
// OWA either says `BodyType=Text` (Value is verbatim) or `BodyType=HTML`.
// For HTML, block-level closing tags and `<br>` become newlines BEFORE
// remaining tags are stripped, so paragraph and line-break structure is
// preserved in the eventual CalDAV/ICS DESCRIPTION field.
export function bodyToText(body: Record<string, unknown>): string {
  let value = stringField(body["Value"]);
  const bodyType = stringField(body["BodyType"]).toLowerCase();
  if (bodyType === "html") {
    value = value.replace(BLOCK_TAG_RE, "\n");
    value = decodeEntities(value.replace(TAG_RE, ""));
  }
  value = value.replace(/\u00a0/g, " ");
  value = value.replace(WHITESPACE_RE, " ");
  value = value
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  value = value.replace(EXCESS_NEWLINES_RE, "\n\n");
  return value.trim();
}

// Merge required + optional + resource attendees into a deduplicated,
// lower-cased, lexicographically-sorted email list.
//
// Sorting is load-bearing: `contentHash` treats the tuple as ordered,
// and OWA's response order is not stable across reloads.
export function collectAttendees(raw: Record<string, unknown>): readonly string[] {
  const emails = new Set<string>();
  for (const key of ["RequiredAttendees", "OptionalAttendees", "Resources"] as const) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const mailbox = asObject(asObject(entry)["Mailbox"]);
      const email = stringField(mailbox["EmailAddress"]).trim().toLowerCase();
      if (email) emails.add(email);
    }
  }
  return [...emails].sort();
}

// ---------- internals ----------

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Minimal HTML entity decoder.
//
// OWA's HTML bodies are produced by Outlook/Word and in practice use
// only `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, plus
// occasional numeric (`&#NNN;` / `&#xHH;`) entities. Python's
// `html.unescape` decodes the full HTML5 named-entity set, so any
// exotic entity in a real event would diverge from Python and produce
// a one-time spurious update. That's preferable to importing a 100KB
// entity table for a code path that almost never sees one.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, match) : match;
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? safeFromCodePoint(cp, match) : match;
    }
    const decoded = NAMED_ENTITIES[body];
    return decoded ?? match;
  });
}

function safeFromCodePoint(cp: number, fallback: string): string {
  if (cp < 0 || cp > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}
