import { test } from "node:test";
import { strict as assert } from "node:assert";

import { planForeignDeletes } from "./prune.js";
import { icsSignature } from "./signature.js";

// Minimal single-VEVENT ICS, canonical UTC timestamps.
function ics(uid: string, summary: string, dtstart: string, dtend: string): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function sig(content: string): string {
  const s = icsSignature(content).signature;
  assert.ok(s, "expected a parseable signature");
  return s;
}

const WIN_START = "20261005";
const WIN_END = "20271012";

test("deletes an unclaimed in-window item with no source counterpart", () => {
  const content = ics("es-old1", "Stale test", "20261017T103000Z", "20261017T113000Z");
  const out = planForeignDeletes({
    remoteItems: [{ remoteId: "r1", content }],
    claimedRemoteIds: new Set(),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set(),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { remoteId: "r1", subject: "Stale test", startDate: "20261017" });
});

test("keeps a claimed item", () => {
  const content = ics("ocs-abc@ete-look-sync", "Live", "20261017T103000Z", "20261017T113000Z");
  const out = planForeignDeletes({
    remoteItems: [{ remoteId: "r1", content }],
    claimedRemoteIds: new Set(["r1"]),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set(),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 0);
});

test("keeps a lone unclaimed item that is the only representation of a source event", () => {
  const content = ics("es-only", "Live", "20261017T103000Z", "20261017T113000Z");
  const out = planForeignDeletes({
    remoteItems: [{ remoteId: "r1", content }],
    claimedRemoteIds: new Set(),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set([sig(content)]),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 0);
});

test("deletes an unclaimed duplicate when a claimed item already covers the signature", () => {
  const claimed = ics("ocs-dup@ete-look-sync", "Dup", "20261017T103000Z", "20261017T113000Z");
  const dup = ics("es-dup", "Dup", "20261017T103000Z", "20261017T113000Z");
  const out = planForeignDeletes({
    remoteItems: [
      { remoteId: "keep", content: claimed },
      { remoteId: "drop", content: dup },
    ],
    claimedRemoteIds: new Set(["keep"]),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set([sig(claimed)]),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.remoteId, "drop");
});

test("keeps items outside the managed window", () => {
  const past = ics("es-past", "Old", "20200101T100000Z", "20200101T110000Z");
  const future = ics("es-far", "Far", "20280101T100000Z", "20280101T110000Z");
  const out = planForeignDeletes({
    remoteItems: [
      { remoteId: "p", content: past },
      { remoteId: "f", content: future },
    ],
    claimedRemoteIds: new Set(),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set(),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 0);
});

test("keeps unparseable items and skips ones already scheduled by the differ", () => {
  const noProps = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const normal = ics("es-2", "Deleting", "20261017T103000Z", "20261017T113000Z");
  const out = planForeignDeletes({
    remoteItems: [
      { remoteId: "bad", content: noProps },
      { remoteId: "scheduled", content: normal },
    ],
    claimedRemoteIds: new Set(),
    alreadyDeleting: new Set(["scheduled"]),
    sourceSignatures: new Set(),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 0);
});

test("all-day items compare by date", () => {
  const content = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:es-allday",
    "SUMMARY:away",
    "DTSTART;VALUE=DATE:20261024",
    "DTEND;VALUE=DATE:20261025",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const out = planForeignDeletes({
    remoteItems: [{ remoteId: "a", content }],
    claimedRemoteIds: new Set(),
    alreadyDeleting: new Set(),
    sourceSignatures: new Set(),
    windowStart: WIN_START,
    windowEnd: WIN_END,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.startDate, "20261024");
});
