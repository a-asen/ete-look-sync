import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, type Event } from "../models.js";
import { PRODID, renderAllEvents, renderEvent } from "./ics.js";

const FIXED_DTSTAMP = new Date("2026-05-13T12:00:00.000Z");

function makeEvent(overrides: Partial<Event> = {}): Event {
  const base: Event = {
    itemId: "evt-1",
    changeKey: "ck",
    subject: "Standup",
    startIso: "2026-05-13T08:00:00Z",
    endIso: "2026-05-13T08:30:00Z",
    isAllDay: false,
    location: "",
    bodyText: "",
    organizerEmail: "",
    organizerName: "",
    attendees: [],
    isRecurring: false,
    isCancelled: false,
    lastModifiedIso: "",
    webLink: "",
  };
  return { ...base, ...overrides };
}

function lines(ics: string): string[] {
  // CRLF per RFC 5545 — split and drop the trailing empty so callers
  // can use `.includes` without padding.
  const parts = ics.split("\r\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

test("renderEvent emits a complete VCALENDAR shell", () => {
  const out = renderEvent(makeEvent(), { now: FIXED_DTSTAMP });
  const ls = lines(out);
  assert.equal(ls[0], "BEGIN:VCALENDAR");
  assert.equal(ls[ls.length - 1], "END:VCALENDAR");
  assert.ok(ls.includes(`PRODID:${PRODID}`));
  assert.ok(ls.includes("VERSION:2.0"));
  assert.ok(ls.includes("BEGIN:VEVENT"));
  assert.ok(ls.includes("END:VEVENT"));
});

test("renderEvent ends with CRLF", () => {
  const out = renderEvent(makeEvent(), { now: FIXED_DTSTAMP });
  assert.ok(out.endsWith("\r\n"));
});

test("UID is derived from caldavUid(event)", () => {
  const event = makeEvent({ itemId: "abc-123" });
  const out = renderEvent(event, { now: FIXED_DTSTAMP });
  assert.ok(lines(out).includes(`UID:${caldavUid(event)}`));
});

test("Timed event uses compact UTC DTSTART/DTEND", () => {
  const out = renderEvent(
    makeEvent({
      startIso: "2026-05-13T08:00:00Z",
      endIso: "2026-05-13T09:30:00Z",
    }),
    { now: FIXED_DTSTAMP },
  );
  const ls = lines(out);
  assert.ok(ls.includes("DTSTART:20260513T080000Z"));
  assert.ok(ls.includes("DTEND:20260513T093000Z"));
});

test("All-day event uses VALUE=DATE form", () => {
  const out = renderEvent(
    makeEvent({
      isAllDay: true,
      startIso: "2026-05-13T00:00:00Z",
      endIso: "2026-05-14T00:00:00Z",
    }),
    { now: FIXED_DTSTAMP },
  );
  const ls = lines(out);
  assert.ok(ls.includes("DTSTART;VALUE=DATE:20260513"));
  assert.ok(ls.includes("DTEND;VALUE=DATE:20260514"));
});

test("Parses fractional-second and bare ISO formats", () => {
  // Exchange has been seen to emit both forms; the renderer should
  // accept either without complaint.
  const out = renderEvent(
    makeEvent({
      startIso: "2026-05-13T08:00:00.123Z",
      endIso: "2026-05-13T09:00:00",
    }),
    { now: FIXED_DTSTAMP },
  );
  const ls = lines(out);
  assert.ok(ls.includes("DTSTART:20260513T080000Z"));
  assert.ok(ls.includes("DTEND:20260513T090000Z"));
});

test("Empty subject falls back to (no subject)", () => {
  const out = renderEvent(makeEvent({ subject: "" }), { now: FIXED_DTSTAMP });
  assert.ok(lines(out).includes("SUMMARY:(no subject)"));
});

test("LOCATION and DESCRIPTION omitted when empty", () => {
  const out = renderEvent(makeEvent(), { now: FIXED_DTSTAMP });
  assert.ok(!out.includes("LOCATION"));
  assert.ok(!out.includes("DESCRIPTION"));
});

test("LOCATION and DESCRIPTION included when set, with escaping", () => {
  const out = renderEvent(
    makeEvent({
      location: "Room 1, building B; floor 2",
      bodyText: "Hello\nworld; with, special: chars and a backslash \\.",
    }),
    { now: FIXED_DTSTAMP },
  );
  const ls = lines(out);
  // TEXT escape: \ → \\ ; → \;  , → \,  newline → \n
  assert.ok(ls.some((l) => l.startsWith("LOCATION:Room 1\\, building B\\; floor 2")));
  assert.ok(
    ls.some((l) =>
      l.startsWith("DESCRIPTION:Hello\\nworld\\; with\\, special: chars and a backslash \\\\."),
    ),
  );
});

test("ORGANIZER with name uses CN parameter", () => {
  const out = renderEvent(
    makeEvent({ organizerEmail: "alice@example.com", organizerName: "Alice" }),
    { now: FIXED_DTSTAMP },
  );
  assert.ok(lines(out).includes("ORGANIZER;CN=Alice:mailto:alice@example.com"));
});

test("ORGANIZER without name is bare mailto", () => {
  const out = renderEvent(
    makeEvent({ organizerEmail: "alice@example.com", organizerName: "" }),
    { now: FIXED_DTSTAMP },
  );
  assert.ok(lines(out).includes("ORGANIZER:mailto:alice@example.com"));
});

test("ORGANIZER CN with special chars gets DQUOTE-wrapped", () => {
  const out = renderEvent(
    makeEvent({
      organizerEmail: "x@y.z",
      // contains both `;` and `:` — must be quoted per RFC 5545 §3.2
      organizerName: "Dr. Smith; PhD",
    }),
    { now: FIXED_DTSTAMP },
  );
  assert.ok(lines(out).includes('ORGANIZER;CN="Dr. Smith; PhD":mailto:x@y.z'));
});

test("ORGANIZER omitted entirely when email is empty", () => {
  const out = renderEvent(
    makeEvent({ organizerEmail: "", organizerName: "Ignored" }),
    { now: FIXED_DTSTAMP },
  );
  assert.ok(!out.includes("ORGANIZER"));
});

test("Multiple ATTENDEE lines, one per email", () => {
  const out = renderEvent(
    makeEvent({ attendees: ["alice@x.com", "bob@x.com", "carol@x.com"] }),
    { now: FIXED_DTSTAMP },
  );
  const ls = lines(out);
  assert.ok(ls.includes("ATTENDEE:mailto:alice@x.com"));
  assert.ok(ls.includes("ATTENDEE:mailto:bob@x.com"));
  assert.ok(ls.includes("ATTENDEE:mailto:carol@x.com"));
});

test("STATUS:CANCELLED appears only when isCancelled", () => {
  const live = renderEvent(makeEvent({ isCancelled: false }), { now: FIXED_DTSTAMP });
  const dead = renderEvent(makeEvent({ isCancelled: true }), { now: FIXED_DTSTAMP });
  assert.ok(!live.includes("STATUS:CANCELLED"));
  assert.ok(lines(dead).includes("STATUS:CANCELLED"));
});

test("LAST-MODIFIED emitted only when lastModifiedIso parses", () => {
  const withMod = renderEvent(
    makeEvent({ lastModifiedIso: "2026-05-12T10:00:00Z" }),
    { now: FIXED_DTSTAMP },
  );
  const withoutMod = renderEvent(makeEvent({ lastModifiedIso: "" }), { now: FIXED_DTSTAMP });
  const withBadMod = renderEvent(
    makeEvent({ lastModifiedIso: "definitely-not-a-date" }),
    { now: FIXED_DTSTAMP },
  );
  assert.ok(lines(withMod).includes("LAST-MODIFIED:20260512T100000Z"));
  assert.ok(!withoutMod.includes("LAST-MODIFIED"));
  assert.ok(!withBadMod.includes("LAST-MODIFIED"));
});

test("DTSTAMP uses the injected now", () => {
  const out = renderEvent(makeEvent(), { now: FIXED_DTSTAMP });
  assert.ok(lines(out).includes("DTSTAMP:20260513T120000Z"));
});

test("DTSTAMP falls back to wall clock when not injected", () => {
  const before = Date.now();
  const out = renderEvent(makeEvent());
  const after = Date.now();
  const stampLine = lines(out).find((l) => l.startsWith("DTSTAMP:"));
  assert.ok(stampLine, "DTSTAMP missing");
  const stamp = stampLine!.slice("DTSTAMP:".length);
  // 20260513T120000Z → 2026-05-13T12:00:00Z
  const parsed = new Date(
    stamp.slice(0, 4) + "-" + stamp.slice(4, 6) + "-" + stamp.slice(6, 11) +
    ":" + stamp.slice(11, 13) + ":" + stamp.slice(13, 15) + "Z",
  ).getTime();
  assert.ok(parsed >= before - 1000 && parsed <= after + 1000, `DTSTAMP ${stamp} not near now`);
});

test("Lines longer than 75 octets are folded", () => {
  const longSubject = "x".repeat(200);
  const out = renderEvent(makeEvent({ subject: longSubject }), { now: FIXED_DTSTAMP });
  // No physical line in the output should exceed 75 octets.
  for (const line of out.split("\r\n")) {
    const octets = Buffer.from(line, "utf8").length;
    assert.ok(octets <= 75, `line ${octets} octets: ${line.slice(0, 40)}…`);
  }
  // After unfolding (CRLF + SP → ""), the original SUMMARY should reappear.
  const unfolded = out.replace(/\r\n /g, "");
  assert.ok(unfolded.includes(`SUMMARY:${longSubject}`));
});

test("renderAllEvents produces one calendar with N VEVENTs", () => {
  const a = makeEvent({ itemId: "a", subject: "A" });
  const b = makeEvent({ itemId: "b", subject: "B" });
  const c = makeEvent({ itemId: "c", subject: "C" });
  const out = renderAllEvents([a, b, c], { now: FIXED_DTSTAMP });
  const ls = lines(out);
  const begins = ls.filter((l) => l === "BEGIN:VEVENT");
  const ends = ls.filter((l) => l === "END:VEVENT");
  assert.equal(begins.length, 3);
  assert.equal(ends.length, 3);
  // Exactly one VCALENDAR wrapper
  assert.equal(ls.filter((l) => l === "BEGIN:VCALENDAR").length, 1);
  assert.equal(ls.filter((l) => l === "END:VCALENDAR").length, 1);
  assert.ok(ls.includes("SUMMARY:A"));
  assert.ok(ls.includes("SUMMARY:B"));
  assert.ok(ls.includes("SUMMARY:C"));
});

test("renderAllEvents with no events still emits a valid empty VCALENDAR", () => {
  const out = renderAllEvents([], { now: FIXED_DTSTAMP });
  const ls = lines(out);
  assert.deepEqual(ls, ["BEGIN:VCALENDAR", `PRODID:${PRODID}`, "VERSION:2.0", "END:VCALENDAR"]);
});

test("Multi-byte characters fold on codepoint boundaries", () => {
  // Each "é" is 2 bytes in UTF-8. Pad the subject so the fold lands
  // inside a multi-byte run and verify the output round-trips.
  const subject = "é".repeat(80); // 160 bytes total
  const out = renderEvent(makeEvent({ subject }), { now: FIXED_DTSTAMP });
  // Each physical line must remain valid UTF-8 (no orphan continuation bytes).
  for (const line of out.split("\r\n")) {
    // Re-encoding must round-trip: if we'd split mid-codepoint, the
    // resulting string would have replacement chars.
    const roundtripped = Buffer.from(line, "utf8").toString("utf8");
    assert.equal(roundtripped, line);
  }
  const unfolded = out.replace(/\r\n /g, "");
  assert.ok(unfolded.includes(`SUMMARY:${subject}`));
});
