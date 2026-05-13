import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Session } from "../auth/session.js";
import type { Config } from "../config.js";
import { type Event } from "../models.js";
import { Store } from "../store.js";
import type { Backend, PushResult, UpsertOptions } from "./backend.js";
import { runFixErrorsWith, runSyncOnceWith, type SyncDeps } from "./orchestrator.js";

// ---------- scaffolding ----------

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
  return path.join(dir, "events.sqlite");
}

function makeCfg(overrides: Partial<Config> = {}): Config {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cfg-"));
  return {
    stateDir: tmp,
    profileDir: tmp,
    cookiesFile: "",
    bearerFile: "",
    dbFile: path.join(tmp, "events.sqlite"),
    etebaseBlobFile: "",
    owaBaseUrl: "",
    backend: "etebase",
    etebaseServerUrl: "",
    etebaseUsername: "",
    etebaseCollectionUid: "",
    caldavUrl: "",
    caldavUsername: "",
    caldavPassword: "",
    caldavCalendarName: "",
    daysBack: 7,
    daysForward: 30,
    freezePastDays: 2,
    intervalMinutes: 30,
    ...overrides,
  };
}

function makeEvent(id: string, startIso: string, subject = "Standup"): Event {
  return {
    itemId: id,
    changeKey: "ck",
    subject,
    startIso,
    endIso: startIso,
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
}

class FakeBackend implements Backend {
  pushes: Array<{ itemId: string; existingId?: string }> = [];
  deletes: string[] = [];
  closed = false;
  shouldFail = new Set<string>();

  async upsert(event: Event, opts: UpsertOptions = {}): Promise<PushResult> {
    if (this.shouldFail.has(event.itemId)) throw new Error(`forced failure on ${event.itemId}`);
    this.pushes.push(opts.existingId ? { itemId: event.itemId, existingId: opts.existingId } : { itemId: event.itemId });
    return { remoteId: `rid-${event.itemId}`, remoteEtag: "etag-1" };
  }

  async delete(remoteId: string): Promise<void> {
    this.deletes.push(remoteId);
  }

  close(): void {
    this.closed = true;
  }
}

function makeSession(): Session {
  return {
    bearer: { token: "t", expires_on: Math.floor(Date.now() / 1000) + 3600 },
    baseHeaders: Object.freeze({}),
    cookieHeader: "",
  };
}

function depsWith(overrides: Partial<SyncDeps>): SyncDeps {
  return {
    loadSession: () => makeSession(),
    fetchEvents: async () => [],
    openStore: (c) => new Store(c.dbFile),
    openBackend: async () => new FakeBackend(),
    now: () => new Date("2026-05-13T12:00:00Z"),
    ...overrides,
  };
}

// ---------- runSyncOnce: happy paths ----------

test("runSyncOnce creates new events and persists remote metadata", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBackend();
  const events = [makeEvent("e1", "2026-05-15T10:00:00Z")];
  const deps = depsWith({ fetchEvents: async () => events, openBackend: async () => backend });

  const summary = await runSyncOnceWith(cfg, {}, deps);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.pushedCreates, 1);

  const store = new Store(cfg.dbFile);
  try {
    const row = store.get("e1");
    assert.ok(row);
    assert.equal(row!.remoteId, "rid-e1");
    assert.equal(row!.remoteEtag, "etag-1");
    assert.equal(row!.pushError, null);
  } finally {
    store.close();
  }
  assert.equal(backend.closed, true);
});

test("runSyncOnce updates an existing row when the hash changes", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBackend();
  const v1 = makeEvent("e1", "2026-05-15T10:00:00Z", "Original");
  const v2 = makeEvent("e1", "2026-05-15T10:00:00Z", "Renamed");

  // First sync seeds the store with the original event.
  await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [v1],
    openBackend: async () => backend,
  }));
  const firstPushes = backend.pushes.length;

  // Second sync renames the subject — should land as an update.
  const backend2 = new FakeBackend();
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [v2],
    openBackend: async () => backend2,
  }));
  assert.equal(summary.pushedUpdates, 1);
  assert.equal(backend2.pushes.length, 1);
  assert.equal(backend2.pushes[0]!.existingId, "rid-e1");
  // Sanity-check we didn't accidentally push during this run via the
  // first backend.
  assert.equal(backend.pushes.length, firstPushes);
});

test("runSyncOnce deletes stored events that vanished upstream", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const event = makeEvent("e1", "2026-05-15T10:00:00Z");

  await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [event],
    openBackend: async () => new FakeBackend(),
  }));

  // Force allowEmptyFetch so the safety check doesn't kick in.
  const backend = new FakeBackend();
  const summary = await runSyncOnceWith(cfg, { allowEmptyFetch: true }, depsWith({
    fetchEvents: async () => [],
    openBackend: async () => backend,
  }));
  assert.equal(summary.pushedDeletes, 1);
  assert.deepEqual(backend.deletes, ["rid-e1"]);
});

// ---------- safety check ----------

test("runSyncOnce refuses to delete when fetch returned zero events", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const event = makeEvent("e1", "2026-05-15T10:00:00Z");
  await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [event],
    openBackend: async () => new FakeBackend(),
  }));

  const backend = new FakeBackend();
  // Default: allowEmptyFetch is false → should abort with an error.
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [],
    openBackend: async () => backend,
  }));
  assert.equal(summary.pushedDeletes, 0);
  assert.equal(backend.deletes.length, 0);
  assert.match(summary.errors[0] ?? "", /silently/);
});

// ---------- dry run ----------

test("runSyncOnce dry-run makes no writes and reports the diff", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBackend();
  const event = makeEvent("e1", "2026-05-15T10:00:00Z");

  const summary = await runSyncOnceWith(cfg, { dryRun: true }, depsWith({
    fetchEvents: async () => [event],
    openBackend: async () => backend,
  }));
  assert.equal(summary.creates, 1);
  assert.equal(summary.pushedCreates, 0);
  assert.equal(backend.pushes.length, 0);

  // Confirm nothing was persisted to the store either.
  const store = new Store(cfg.dbFile);
  try {
    assert.equal(store.get("e1"), undefined);
  } finally {
    store.close();
  }
});

// ---------- per-event error capture ----------

test("runSyncOnce records per-event failures without aborting the run", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBackend();
  backend.shouldFail.add("bad");

  const events = [
    makeEvent("good", "2026-05-15T10:00:00Z"),
    makeEvent("bad", "2026-05-16T10:00:00Z"),
  ];
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => events,
    openBackend: async () => backend,
  }));

  assert.equal(summary.pushedCreates, 1);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0] ?? "", /forced failure on bad/);

  const store = new Store(cfg.dbFile);
  try {
    assert.equal(store.get("good")!.pushError, null);
    assert.match(store.get("bad")!.pushError ?? "", /forced failure/);
  } finally {
    store.close();
  }
});

// ---------- runFixErrors ----------

test("runFixErrors retries only events with recorded push errors", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const failingBackend = new FakeBackend();
  failingBackend.shouldFail.add("bad");

  await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [
      makeEvent("good", "2026-05-15T10:00:00Z"),
      makeEvent("bad", "2026-05-16T10:00:00Z"),
    ],
    openBackend: async () => failingBackend,
  }));

  const retryBackend = new FakeBackend();
  const summary = await runFixErrorsWith(cfg, {}, depsWith({
    openBackend: async () => retryBackend,
  }));
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.pushedCreates, 1);
  assert.deepEqual(retryBackend.pushes.map((p) => p.itemId), ["bad"]);

  const store = new Store(cfg.dbFile);
  try {
    assert.equal(store.get("bad")!.pushError, null);
  } finally {
    store.close();
  }
});

test("runFixErrors is a no-op when nothing has failed", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  // Empty store: no failures.
  new Store(cfg.dbFile).close();

  const summary = await runFixErrorsWith(cfg, {}, depsWith({
    openBackend: async () => {
      throw new Error("should not have opened a backend");
    },
  }));
  assert.equal(summary.errors.length, 0);
});
