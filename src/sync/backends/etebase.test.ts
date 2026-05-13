import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, type Event } from "../../models.js";
import { EtebaseBackend, type EtebaseItemSnapshot, type EtebaseOps } from "./etebase.js";

// ---------- test scaffolding ----------

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
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
    ...overrides,
  };
}

interface FakeStore {
  items: Map<string, EtebaseItemSnapshot & { content: string }>;
  fetches: string[];
  creates: Array<{ content: string; meta: { name: string; mtime: number; type: string } }>;
  updates: Array<{ uid: string; etag: string; content: string }>;
  deletes: Array<{ uid: string; etag: string }>;
  nextUid: number;
  nextEtag: number;
}

interface FakeOpsConfig {
  fetchThrows?: Map<string, Error>;
  updateThrows?: Map<string, Error>;
  deleteThrows?: Map<string, Error>;
  createThrows?: Error;
}

function makeFakeOps(initial: Array<{ uid: string; content: string }> = [], config: FakeOpsConfig = {}): {
  ops: EtebaseOps;
  store: FakeStore;
} {
  const store: FakeStore = {
    items: new Map(),
    fetches: [],
    creates: [],
    updates: [],
    deletes: [],
    nextUid: 0,
    nextEtag: 0,
  };
  for (const seed of initial) {
    store.items.set(seed.uid, { uid: seed.uid, etag: `etag-0-${seed.uid}`, content: seed.content });
  }

  const ops: EtebaseOps = {
    async fetchItem(uid) {
      store.fetches.push(uid);
      const t = config.fetchThrows?.get(uid);
      if (t) throw t;
      const item = store.items.get(uid);
      return item ? { uid: item.uid, etag: item.etag } : null;
    },
    async createItem(args) {
      if (config.createThrows) throw config.createThrows;
      store.creates.push(args);
      const uid = `uid-${++store.nextUid}`;
      const etag = `etag-${++store.nextEtag}`;
      store.items.set(uid, { uid, etag, content: args.content });
      return { uid, etag };
    },
    async updateItem(args) {
      const t = config.updateThrows?.get(args.uid);
      if (t) throw t;
      store.updates.push(args);
      const item = store.items.get(args.uid);
      if (!item) throw new Error("update of unknown item " + args.uid);
      const etag = `etag-${++store.nextEtag}`;
      store.items.set(args.uid, { uid: item.uid, etag, content: args.content });
      return { uid: item.uid, etag };
    },
    async deleteItem(args) {
      const t = config.deleteThrows?.get(args.uid);
      if (t) throw t;
      store.deletes.push(args);
      store.items.delete(args.uid);
    },
  };
  return { ops, store };
}

// ---------- upsert: create path ----------

test("upsert creates a new item when no existingId", async () => {
  const { ops, store } = makeFakeOps();
  const backend = new EtebaseBackend(ops);
  const event = makeEvent();
  const result = await backend.upsert(event);
  assert.equal(store.creates.length, 1);
  assert.equal(store.updates.length, 0);
  // Meta carries the human-readable name + a VEVENT type marker so
  // foreign clients can render the item without parsing the content.
  assert.equal(store.creates[0]!.meta.name, "Standup");
  assert.equal(store.creates[0]!.meta.type, "VEVENT");
  assert.ok(store.creates[0]!.content.includes(`UID:${caldavUid(event)}`));
  assert.match(result.remoteId, /^uid-/);
  assert.match(result.remoteEtag, /^etag-/);
});

test("upsert falls back to empty subject", async () => {
  const { ops, store } = makeFakeOps();
  const backend = new EtebaseBackend(ops);
  await backend.upsert(makeEvent({ subject: "" }));
  assert.equal(store.creates[0]!.meta.name, "(no subject)");
});

// ---------- upsert: update path ----------

test("upsert with existingId updates in place", async () => {
  const { ops, store } = makeFakeOps([{ uid: "existing", content: "old-ics" }]);
  const backend = new EtebaseBackend(ops);
  const result = await backend.upsert(makeEvent(), { existingId: "existing" });
  assert.equal(store.updates.length, 1);
  assert.equal(store.creates.length, 0);
  assert.equal(store.updates[0]!.uid, "existing");
  assert.equal(result.remoteId, "existing");
  // Etag advances on every revision.
  assert.notEqual(result.remoteEtag, "etag-0-existing");
});

test("upsert with stale existingId falls through to create", async () => {
  const { ops, store } = makeFakeOps();
  const backend = new EtebaseBackend(ops);
  const result = await backend.upsert(makeEvent(), { existingId: "gone-uid" });
  assert.equal(store.fetches[0], "gone-uid");
  // No update happened because the item didn't exist; create instead.
  assert.equal(store.updates.length, 0);
  assert.equal(store.creates.length, 1);
  assert.match(result.remoteId, /^uid-/);
});

// ---------- delete ----------

test("delete removes an existing item", async () => {
  const { ops, store } = makeFakeOps([{ uid: "doomed", content: "x" }]);
  const backend = new EtebaseBackend(ops);
  await backend.delete("doomed");
  assert.equal(store.deletes.length, 1);
  assert.equal(store.deletes[0]!.uid, "doomed");
  assert.equal(store.items.has("doomed"), false);
});

test("delete is a no-op when the item is already gone", async () => {
  const { ops, store } = makeFakeOps();
  const backend = new EtebaseBackend(ops);
  await backend.delete("never-existed"); // does not throw
  assert.equal(store.deletes.length, 0);
});

test("delete swallows fetch errors so partial-run retries succeed", async () => {
  const fetchThrows = new Map<string, Error>();
  fetchThrows.set("blowup", new Error("network down"));
  const { ops, store } = makeFakeOps([], { fetchThrows });
  const backend = new EtebaseBackend(ops);
  await backend.delete("blowup"); // does not throw
  assert.equal(store.deletes.length, 0);
});

test("delete swallows delete-step errors too", async () => {
  const deleteThrows = new Map<string, Error>();
  deleteThrows.set("doomed", new Error("conflict 409"));
  const { ops, store } = makeFakeOps(
    [{ uid: "doomed", content: "x" }],
    { deleteThrows },
  );
  const backend = new EtebaseBackend(ops);
  await backend.delete("doomed"); // does not throw
  // The item is still present in the fake — that's fine, the real
  // SDK would have raised, and we logged & moved on.
  assert.equal(store.items.has("doomed"), true);
});

// ---------- close ----------

test("close calls account.logout() if available", async () => {
  let loggedOut = false;
  const account = {
    logout: async () => {
      loggedOut = true;
    },
  };
  const { ops } = makeFakeOps();
  const backend = new EtebaseBackend(ops, account);
  await backend.close();
  assert.equal(loggedOut, true);
});

test("close swallows logout errors", async () => {
  const account = {
    logout: async () => {
      throw new Error("network down");
    },
  };
  const { ops } = makeFakeOps();
  const backend = new EtebaseBackend(ops, account);
  await backend.close(); // does not throw
});

test("close works when no account is attached (test-injection case)", async () => {
  const { ops } = makeFakeOps();
  const backend = new EtebaseBackend(ops);
  await backend.close(); // does not throw
});
