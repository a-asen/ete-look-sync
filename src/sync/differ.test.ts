import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, contentHash, type Event } from "../models.js";
import type { StoredRow } from "../store.js";
import { PAST_GRACE_DAYS, computeDiff } from "./differ.js";

// Build a deterministic, minimal Event with a hash that matches the
// stored row helper below — diff tests should rarely override fields
// other than itemId and startIso.
function makeEvent(overrides: Partial<Event> = {}): Event {
  const base: Event = {
    itemId: "evt-1",
    changeKey: "ck",
    subject: "Standup",
    startIso: "2026-05-13T08:00:00Z",
    endIso: "2026-05-13T09:00:00Z",
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

// Mirror what Store.upsert + Store.markPushed would have produced for `event`.
function rowFor(event: Event, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    itemId: event.itemId,
    contentHash: contentHash(event),
    caldavUid: caldavUid(event),
    remoteId: "remote-" + event.itemId,
    remoteEtag: "etag-" + event.itemId,
    backend: "etebase",
    startIso: event.startIso,
    subject: event.subject,
    pushError: null,
    ...overrides,
  };
}

const WINDOW = {
  fetchStart: new Date("2026-05-01T00:00:00Z"),
  fetchEnd: new Date("2026-06-01T00:00:00Z"),
  // Cutoff well before the window so freeze-past doesn't interfere
  // with normal create/update/delete tests.
  cutoff: new Date("2026-04-01T00:00:00Z"),
};

test("new event in window produces a create", () => {
  const event = makeEvent();
  const diff = computeDiff([event], [], WINDOW);
  assert.deepEqual(diff.creates, [event]);
  assert.equal(diff.updates.length, 0);
  assert.equal(diff.deletes.length, 0);
  assert.equal(diff.unchanged.length, 0);
});

test("unchanged event (same hash) produces unchanged", () => {
  const event = makeEvent();
  const diff = computeDiff([event], [rowFor(event)], WINDOW);
  assert.equal(diff.creates.length, 0);
  assert.equal(diff.updates.length, 0);
  assert.deepEqual(diff.unchanged, [event.itemId]);
});

test("event with different content_hash produces an update", () => {
  const event = makeEvent({ subject: "Standup" });
  // Stored row has a different hash → counts as change.
  const row = rowFor(event, { contentHash: "different-hash" });
  const diff = computeDiff([event], [row], WINDOW);
  assert.equal(diff.updates.length, 1);
  assert.equal(diff.updates[0]!.event, event);
  assert.equal(diff.updates[0]!.row, row);
  assert.equal(diff.creates.length, 0);
});

test("row with push_error gets re-pushed as a create", () => {
  const event = makeEvent();
  const row = rowFor(event, { pushError: "Conflict 409" });
  const diff = computeDiff([event], [row], WINDOW);
  // Even though the hash matches, the error path forces a retry via
  // the create code path (so the writer reuses the same UID).
  assert.deepEqual(diff.creates, [event]);
  assert.equal(diff.updates.length, 0);
  assert.equal(diff.unchanged.length, 0);
});

test("stored row missing from fresh fetch produces a delete (in window)", () => {
  const event = makeEvent({ itemId: "evt-1" });
  const ghost = makeEvent({ itemId: "evt-ghost", startIso: "2026-05-20T10:00:00Z" });
  const diff = computeDiff([event], [rowFor(event), rowFor(ghost)], WINDOW);
  assert.equal(diff.deletes.length, 1);
  assert.equal(diff.deletes[0]!.itemId, "evt-ghost");
});

test("stored row outside window is not deleted, just counted", () => {
  const fresh = makeEvent();
  // Row before window start.
  const past = makeEvent({ itemId: "evt-past", startIso: "2026-04-15T10:00:00Z" });
  // Row after window end.
  const future = makeEvent({ itemId: "evt-future", startIso: "2026-07-15T10:00:00Z" });
  const diff = computeDiff(
    [fresh],
    [rowFor(fresh), rowFor(past), rowFor(future)],
    WINDOW,
  );
  assert.equal(diff.deletes.length, 0);
  assert.equal(diff.outOfWindow, 2);
});

test("event before cutoff is frozen — not created, not updated", () => {
  const event = makeEvent({ itemId: "old-evt", startIso: "2020-01-01T00:00:00Z" });
  const diff = computeDiff([event], [], WINDOW);
  assert.equal(diff.creates.length, 0);
  assert.equal(diff.frozenPast, 1);
});

test("stored row before cutoff that disappeared upstream is left alone", () => {
  const oldEvent = makeEvent({ itemId: "old-evt", startIso: "2020-01-01T00:00:00Z" });
  const diff = computeDiff([], [rowFor(oldEvent)], WINDOW);
  assert.equal(diff.deletes.length, 0);
  // It's also not counted as out_of_window — the cutoff check runs first.
  assert.equal(diff.outOfWindow, 0);
});

test("event with empty itemId is silently skipped", () => {
  const orphan = makeEvent({ itemId: "" });
  const diff = computeDiff([orphan], [], WINDOW);
  assert.equal(diff.creates.length, 0);
  assert.equal(diff.frozenPast, 0);
});

test("window boundary: row exactly at fetchStart is in-window", () => {
  // Window start matches the event start instant.
  const event = makeEvent({
    itemId: "boundary",
    startIso: "2026-05-01T00:00:00Z",
  });
  const diff = computeDiff([], [rowFor(event)], WINDOW);
  // Vanished upstream but inside the window → delete.
  assert.equal(diff.deletes.length, 1);
  assert.equal(diff.deletes[0]!.itemId, "boundary");
});

test("window boundary: row exactly at fetchEnd is out-of-window", () => {
  // CalendarPageView is [start, end) — fetchEnd is exclusive.
  const event = makeEvent({
    itemId: "boundary-end",
    startIso: "2026-06-01T00:00:00Z",
  });
  const diff = computeDiff([], [rowFor(event)], WINDOW);
  assert.equal(diff.deletes.length, 0);
  assert.equal(diff.outOfWindow, 1);
});

test("default cutoff is today UTC − PAST_GRACE_DAYS", () => {
  // Sanity: with no override, an event from 30 days ago is frozen and
  // an event for tomorrow is in scope. We use generous deltas to keep
  // the test stable regardless of wall-clock drift during execution.
  const longAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const tomorrow = new Date(Date.now() + 86400_000).toISOString();

  const stale = makeEvent({ itemId: "stale", startIso: longAgo });
  const upcoming = makeEvent({ itemId: "upcoming", startIso: tomorrow });

  const diff = computeDiff([stale, upcoming], [], {
    fetchStart: new Date(Date.now() - 365 * 86400_000),
    fetchEnd: new Date(Date.now() + 365 * 86400_000),
    // omit cutoff → use today − PAST_GRACE_DAYS
  });

  assert.equal(diff.frozenPast, 1);
  assert.equal(diff.creates.length, 1);
  assert.equal(diff.creates[0]!.itemId, "upcoming");
  // Sanity-check the constant is what we documented.
  assert.equal(PAST_GRACE_DAYS, 2);
});

test("mixed run: creates + updates + deletes + unchanged + frozen + out-of-window", () => {
  const fresh1 = makeEvent({ itemId: "create-me", startIso: "2026-05-10T00:00:00Z" });
  const fresh2 = makeEvent({ itemId: "update-me", startIso: "2026-05-11T00:00:00Z" });
  const fresh3 = makeEvent({ itemId: "unchanged", startIso: "2026-05-12T00:00:00Z" });
  const frozenFresh = makeEvent({ itemId: "frozen-fresh", startIso: "2020-01-01T00:00:00Z" });

  const rowUpdate = rowFor(fresh2, { contentHash: "stale-hash" });
  const rowUnchanged = rowFor(fresh3);
  const rowToDelete = rowFor(
    makeEvent({ itemId: "delete-me", startIso: "2026-05-15T00:00:00Z" }),
  );
  const rowOutOfWindow = rowFor(
    makeEvent({ itemId: "ooW", startIso: "2026-07-15T00:00:00Z" }),
  );

  const diff = computeDiff(
    [fresh1, fresh2, fresh3, frozenFresh],
    [rowUpdate, rowUnchanged, rowToDelete, rowOutOfWindow],
    WINDOW,
  );

  assert.deepEqual(diff.creates.map((e) => e.itemId), ["create-me"]);
  assert.deepEqual(diff.updates.map((u) => u.event.itemId), ["update-me"]);
  assert.deepEqual(diff.deletes.map((r) => r.itemId), ["delete-me"]);
  assert.deepEqual(diff.unchanged, ["unchanged"]);
  assert.equal(diff.frozenPast, 1);
  assert.equal(diff.outOfWindow, 1);
});
