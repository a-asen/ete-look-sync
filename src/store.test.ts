import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Store } from "./store.js";
import { contentHash, type Event } from "./models.js";

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ete-look-sync-store-"));
  return path.join(dir, "events.sqlite");
}

function fixture(overrides: Partial<Event> = {}): Event {
  return {
    itemId: "item-1",
    changeKey: "ck1",
    subject: "Stand-up",
    startIso: "2026-05-10T09:00:00",
    endIso: "2026-05-10T09:30:00",
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
    ...overrides,
  };
}

test("upsert + get round-trips an event", () => {
  const db = new Store(tempDb());
  const e = fixture();
  db.upsert(e);

  const row = db.get(e.itemId);
  assert.ok(row);
  assert.equal(row!.itemId, "item-1");
  assert.equal(row!.subject, "Stand-up");
  assert.equal(row!.contentHash, contentHash(e));
  assert.equal(row!.remoteId, null);
  assert.equal(row!.pushError, null);
  db.close();
});

test("markPushed records (remoteId, remoteEtag, backend) and clears errors", () => {
  const db = new Store(tempDb());
  const e = fixture();
  db.upsert(e);
  db.markFailed(e.itemId, "boom");
  assert.equal(db.get(e.itemId)!.pushError, "boom");

  db.markPushed(e.itemId, {
    remoteId: "abc-123",
    remoteEtag: "etag-xyz",
    backend: "etebase",
  });

  const row = db.get(e.itemId)!;
  assert.equal(row.remoteId, "abc-123");
  assert.equal(row.remoteEtag, "etag-xyz");
  assert.equal(row.backend, "etebase");
  assert.equal(row.pushError, null);
  db.close();
});

test("upsert preserves remote metadata across content updates", () => {
  const db = new Store(tempDb());
  const e = fixture();
  db.upsert(e);
  db.markPushed(e.itemId, {
    remoteId: "id-1",
    remoteEtag: "etag-1",
    backend: "etebase",
  });

  // Same itemId, new content — must not orphan the remote resource.
  db.upsert(fixture({ subject: "Stand-up (rescheduled)" }));

  const row = db.get(e.itemId)!;
  assert.equal(row.subject, "Stand-up (rescheduled)");
  assert.equal(row.remoteId, "id-1");
  assert.equal(row.remoteEtag, "etag-1");
  assert.equal(row.backend, "etebase");
  db.close();
});

test("allHashes returns a Map keyed by itemId", () => {
  const db = new Store(tempDb());
  db.upsert(fixture({ itemId: "a" }));
  db.upsert(fixture({ itemId: "b", subject: "Other" }));

  const hashes = db.allHashes();
  assert.equal(hashes.size, 2);
  assert.equal(hashes.get("a"), contentHash(fixture({ itemId: "a" })));
  assert.equal(
    hashes.get("b"),
    contentHash(fixture({ itemId: "b", subject: "Other" })),
  );
  db.close();
});

test("iterFailed yields only events with push_error", () => {
  const db = new Store(tempDb());
  db.upsert(fixture({ itemId: "ok" }));
  db.upsert(fixture({ itemId: "bad", subject: "Failing" }));
  db.markFailed("bad", "remote rejected");

  const failures = db.iterFailed();
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.event.itemId, "bad");
  assert.equal(failures[0]!.error, "remote rejected");
  assert.equal(db.countFailures(), 1);
  db.close();
});

test("delete removes the row", () => {
  const db = new Store(tempDb());
  db.upsert(fixture());
  db.delete("item-1");
  assert.equal(db.get("item-1"), undefined);
  db.close();
});

test("transaction rollback discards pending writes", () => {
  const db = new Store(tempDb());
  db.upsert(fixture());

  db.begin();
  db.upsert(fixture({ itemId: "scratch", subject: "Temp" }));
  assert.ok(db.get("scratch"));
  db.rollback();

  assert.equal(db.get("scratch"), undefined);
  assert.ok(db.get("item-1"));
  db.close();
});

test("iterEvents reconstructs Event objects ordered by start", () => {
  const db = new Store(tempDb());
  db.upsert(fixture({ itemId: "later", startIso: "2026-06-01T09:00:00" }));
  db.upsert(fixture({ itemId: "earlier", startIso: "2026-04-01T09:00:00" }));

  const events = db.iterEvents();
  assert.deepEqual(
    events.map((e) => e.itemId),
    ["earlier", "later"],
  );
  db.close();
});
