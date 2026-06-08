import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { Event } from "../models.js";
import { renderEvent } from "./ics.js";
import { eventSignature, icsSignature } from "./signature.js";

function makeEvent(over: Partial<Event> = {}): Event {
  return {
    itemId: "AAA",
    changeKey: "CK",
    subject: "Standup",
    startIso: "2026-06-05T08:30:00Z",
    endIso: "2026-06-05T09:00:00Z",
    isAllDay: false,
    location: "Room 1",
    bodyText: "agenda",
    organizerEmail: "o@x.com",
    organizerName: "Org",
    attendees: ["a@x.com"],
    isRecurring: false,
    isCancelled: false,
    lastModifiedIso: "2026-06-01T00:00:00Z",
    webLink: "",
    ...over,
  };
}

test("eventSignature is name + start + end, independent of body/location", () => {
  const a = makeEvent();
  const b = makeEvent({ bodyText: "totally different body", location: "elsewhere" });
  assert.equal(eventSignature(a), eventSignature(b)); // body/location not in the key
  assert.match(eventSignature(a), /^Standup 20260605T083000Z 20260605T090000Z$/);
});

test("a different time or subject changes the signature", () => {
  const base = eventSignature(makeEvent());
  assert.notEqual(base, eventSignature(makeEvent({ subject: "Other" })));
  assert.notEqual(base, eventSignature(makeEvent({ endIso: "2026-06-05T09:30:00Z" })));
});

test("CRITICAL: a tool-rendered ICS round-trips to the same signature as its event", () => {
  // This is what makes remote dedup work: the signature parsed back out
  // of what we wrote must equal the signature of the source event.
  for (const ev of [
    makeEvent(),
    makeEvent({ subject: "Lunch, with: friends; & co", bodyText: "a\nb,c;d\\e" }),
    makeEvent({ isAllDay: true, startIso: "2026-06-05T00:00:00Z", endIso: "2026-06-06T00:00:00Z" }),
    makeEvent({ subject: "  trailing spaces  " }),
    makeEvent({ subject: "" }), // becomes "(no subject)"
  ]) {
    const parsed = icsSignature(renderEvent(ev));
    assert.equal(parsed.signature, eventSignature(ev), `mismatch for subject=${JSON.stringify(ev.subject)}`);
    assert.equal(parsed.isToolItem, true); // our UID suffix is recognised
  }
});

test("trailing/leading whitespace in the subject is normalised away", () => {
  assert.equal(eventSignature(makeEvent({ subject: " Standup " })), eventSignature(makeEvent({ subject: "Standup" })));
});

test("icsSignature flags non-tool items and parses foreign UTC/DATE forms", () => {
  const foreign = [
    "BEGIN:VEVENT",
    "UID:some-random-thing-from-another-app",
    "SUMMARY:Standup",
    "DTSTART:20260605T083000Z",
    "DTEND:20260605T090000Z",
    "END:VEVENT",
  ].join("\r\n");
  const r = icsSignature(foreign);
  assert.equal(r.isToolItem, false);
  assert.equal(r.signature, "Standup 20260605T083000Z 20260605T090000Z");
});

test("icsSignature returns null signature when required props are missing", () => {
  const r = icsSignature("BEGIN:VEVENT\r\nUID:x@ete-look-sync\r\nSUMMARY:No times\r\nEND:VEVENT");
  assert.equal(r.signature, null);
  assert.equal(r.isToolItem, true);
});

test("icsSignature unfolds long folded lines before matching", () => {
  // A SUMMARY folded across two physical lines (CRLF + space) must
  // rejoin to the original value.
  const folded =
    "BEGIN:VEVENT\r\nUID:x@ete-look-sync\r\nSUMMARY:Very long title that exceeded sevent\r\n y five octets once\r\nDTSTART:20260605T083000Z\r\nDTEND:20260605T090000Z\r\nEND:VEVENT";
  const r = icsSignature(folded);
  assert.equal(r.signature, "Very long title that exceeded seventy five octets once 20260605T083000Z 20260605T090000Z");
});
