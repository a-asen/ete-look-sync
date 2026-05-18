import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionExpired, type Session } from "../auth/session.js";
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

/** Backend that advertises upsertMany so the orchestrator routes creates through it. */
class FakeBatchBackend implements Backend {
  /** One entry per upsertMany call, with the chunk size. */
  batches: Array<{ size: number; itemIds: string[] }> = [];
  /** Single-event fallback (updates, fix-errors). */
  singles: Array<{ itemId: string; existingId?: string }> = [];
  deletes: string[] = [];
  closed = false;
  failBatchAt = -1;

  async upsert(event: Event, opts: UpsertOptions = {}): Promise<PushResult> {
    this.singles.push(
      opts.existingId
        ? { itemId: event.itemId, existingId: opts.existingId }
        : { itemId: event.itemId },
    );
    return { remoteId: `rid-${event.itemId}`, remoteEtag: "etag-single" };
  }

  async upsertMany(events: readonly Event[]): Promise<PushResult[]> {
    this.batches.push({ size: events.length, itemIds: events.map((e) => e.itemId) });
    if (this.failBatchAt === this.batches.length - 1) {
      throw new Error("forced batch failure");
    }
    return events.map((e) => ({ remoteId: `rid-${e.itemId}`, remoteEtag: "etag-batch" }));
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
    maybeSilentRefresh: async () => {},
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

test("runSyncOnce attempts a silent refresh before loading the session", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const calls: string[] = [];

  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    maybeSilentRefresh: async () => {
      calls.push("refresh");
    },
    loadSession: () => {
      calls.push("load");
      return makeSession();
    },
  }));

  assert.equal(summary.errors.length, 0);
  assert.deepEqual(calls, ["refresh", "load"]);
});

test("runSyncOnce surfaces SessionExpired when silent refresh can't save it", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  let refreshed = false;

  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    // Silent refresh ran but MFA was required, so it left the stale
    // token in place — loadSession's guard then fires.
    maybeSilentRefresh: async () => {
      refreshed = true;
    },
    loadSession: () => {
      throw new SessionExpired("Saved bearer token is expired (exp=1). Run `ete-look-sync login` to refresh.");
    },
  }));

  assert.equal(refreshed, true);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0]!, /expired/);
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

// ---------- batched-create path ----------

test("runSyncOnce routes creates through upsertMany when the backend supports it", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBatchBackend();
  // 120 events → 3 chunks of 50/50/20 at the default CREATE_BATCH_SIZE.
  const events = Array.from({ length: 120 }, (_, i) =>
    makeEvent(`e${i.toString().padStart(3, "0")}`, "2026-05-15T10:00:00Z", `evt ${i}`),
  );
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => events,
    openBackend: async () => backend,
  }));

  assert.equal(summary.errors.length, 0);
  assert.equal(summary.pushedCreates, 120);
  // Single-event upsert was NOT called for creates.
  assert.equal(backend.singles.length, 0);
  // Three batches expected.
  assert.equal(backend.batches.length, 3);
  assert.equal(backend.batches[0]!.size, 50);
  assert.equal(backend.batches[1]!.size, 50);
  assert.equal(backend.batches[2]!.size, 20);
});

test("upsertMany failure marks every event in the chunk as failed", async () => {
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBatchBackend();
  backend.failBatchAt = 1; // second chunk explodes
  const events = Array.from({ length: 80 }, (_, i) =>
    makeEvent(`e${i}`, "2026-05-15T10:00:00Z"),
  );
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => events,
    openBackend: async () => backend,
  }));
  // First batch (50) succeeded; second batch (30) all failed.
  assert.equal(summary.pushedCreates, 50);
  assert.equal(summary.errors.length, 30);

  const store = new Store(cfg.dbFile);
  try {
    // Successful rows have null pushError; failed rows have the batch's error text.
    assert.equal(store.get("e0")!.pushError, null);
    assert.match(store.get("e60")!.pushError ?? "", /forced batch failure/);
  } finally {
    store.close();
  }
});

test("runFixErrors uses single-event upsert even when upsertMany exists", async () => {
  // fix-errors retries one-at-a-time so a single bad row can't poison
  // a whole batch; verify the orchestrator stays on `upsert()` there.
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const failBackend = new FakeBackend();
  failBackend.shouldFail.add("bad");
  await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [
      makeEvent("good", "2026-05-15T10:00:00Z"),
      makeEvent("bad", "2026-05-15T11:00:00Z"),
    ],
    openBackend: async () => failBackend,
  }));

  const retryBackend = new FakeBatchBackend();
  const summary = await runFixErrorsWith(cfg, {}, depsWith({
    openBackend: async () => retryBackend,
  }));
  assert.equal(summary.errors.length, 0);
  // fix-errors went through the single-event path despite upsertMany being available.
  assert.equal(retryBackend.batches.length, 0);
  assert.equal(retryBackend.singles.length, 1);
  assert.equal(retryBackend.singles[0]!.itemId, "bad");
});

test("single-create-only run skips batching even on a bulk-capable backend", async () => {
  // The orchestrator's `totalCreates > 1` guard is a tiny perf optimisation
  // to avoid wrapping a single push in a batch wrapper. Pin it.
  const cfg = makeCfg({ dbFile: tempDbPath() });
  const backend = new FakeBatchBackend();
  const summary = await runSyncOnceWith(cfg, {}, depsWith({
    fetchEvents: async () => [makeEvent("solo", "2026-05-15T10:00:00Z")],
    openBackend: async () => backend,
  }));
  assert.equal(summary.pushedCreates, 1);
  assert.equal(backend.batches.length, 0);
  assert.equal(backend.singles.length, 1);
});
