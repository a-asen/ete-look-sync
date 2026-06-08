import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { RemoteItem } from "./backend.js";
import { planDedupe } from "./dedupe.js";

// Build a minimal single-VEVENT ICS with the given uid + signature parts.
function ics(uid: string, summary: string, start = "20260605T083000Z", end = "20260605T090000Z"): string {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    "END:VEVENT",
  ].join("\r\n");
}

const tool = (n: string, s = "Standup") => ({ remoteId: n, content: ics(`${n}@ete-look-sync`, s) });
const real = (n: string, s = "Standup") => ({ remoteId: n, content: ics(`${n}-external`, s) });

test("keeps one tool item per signature, deletes the rest", () => {
  const items: RemoteItem[] = [tool("a"), tool("b"), tool("c")];
  const plan = planDedupe(items);
  assert.equal(plan.deletes.length, 2);
  assert.ok(plan.deletes.every((d) => d.reason === "duplicate-tool"));
  // exactly one survivor for the signature
  assert.equal(plan.survivors.size, 1);
  const kept = plan.survivors.get("Standup 20260605T083000Z 20260605T090000Z");
  assert.equal(plan.deletes.find((d) => d.remoteId === kept), undefined);
});

test("when a real event shares the signature, ALL tool copies are deleted", () => {
  const items: RemoteItem[] = [real("R"), tool("a"), tool("b")];
  const plan = planDedupe(items);
  assert.equal(plan.deletes.length, 2);
  assert.ok(plan.deletes.every((d) => d.reason === "shadows-real"));
  // the real item survives and is never queued for deletion
  assert.equal(plan.survivors.get("Standup 20260605T083000Z 20260605T090000Z"), "R");
  assert.equal(plan.deletes.find((d) => d.remoteId === "R"), undefined);
});

test("never deletes real items even when several real duplicates exist", () => {
  const items: RemoteItem[] = [real("R1"), real("R2")];
  const plan = planDedupe(items);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.realItems, 2);
});

test("distinct signatures are independent", () => {
  const items: RemoteItem[] = [tool("a", "Standup"), tool("b", "Standup"), tool("c", "Lunch")];
  const plan = planDedupe(items);
  assert.equal(plan.deletes.length, 1); // one extra Standup; Lunch untouched
  assert.equal(plan.duplicateSignatures, 1);
});

test("items with no parseable signature are left alone", () => {
  const items: RemoteItem[] = [
    { remoteId: "x", content: "BEGIN:VEVENT\r\nUID:x@ete-look-sync\r\nSUMMARY:no times\r\nEND:VEVENT" },
    tool("a"),
    tool("b"),
  ];
  const plan = planDedupe(items);
  assert.equal(plan.unparseable, 1);
  assert.equal(plan.deletes.length, 1); // only the tool dup
});

test("no duplicates → empty plan", () => {
  const plan = planDedupe([tool("a"), tool("b", "Lunch"), real("R", "Dinner")]);
  assert.equal(plan.deletes.length, 0);
  assert.equal(plan.duplicateSignatures, 0);
});
