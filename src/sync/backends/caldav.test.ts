import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, type Event } from "../../models.js";
import { CalDAVBackend, type DavOps, type DavResult } from "./caldav.js";

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

interface CreateCall {
  calendarUrl: string;
  iCalString: string;
  filename: string;
}
interface UpdateCall {
  url: string;
  iCalString: string;
  etag?: string;
}
interface DeleteCall {
  url: string;
  etag?: string;
}

interface FakeOps extends DavOps {
  creates: CreateCall[];
  updates: UpdateCall[];
  deletes: DeleteCall[];
}

interface FakeOpsConfig {
  createResults?: Array<DavResult | Error>;
  updateResults?: Array<DavResult | Error>;
  deleteResults?: Array<DavResult | Error>;
}

function fakeOps(plan: FakeOpsConfig = {}): FakeOps {
  const create = [...(plan.createResults ?? [])];
  const update = [...(plan.updateResults ?? [])];
  const del = [...(plan.deleteResults ?? [])];
  const creates: CreateCall[] = [];
  const updates: UpdateCall[] = [];
  const deletes: DeleteCall[] = [];

  return {
    creates,
    updates,
    deletes,
    async createObject(args) {
      creates.push(args);
      const next = create.shift();
      if (!next) throw new Error(`no createResults queued (call #${creates.length})`);
      if (next instanceof Error) throw next;
      return next;
    },
    async updateObject(args) {
      updates.push(args);
      const next = update.shift();
      if (!next) throw new Error(`no updateResults queued (call #${updates.length})`);
      if (next instanceof Error) throw next;
      return next;
    },
    async deleteObject(args) {
      deletes.push(args);
      const next = del.shift();
      if (!next) throw new Error(`no deleteResults queued (call #${deletes.length})`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const CAL = "https://example.test/calendars/me/work/";

// ---------- upsert: create path ----------

test("upsert creates a new resource when no existingId", async () => {
  const ops = fakeOps({
    createResults: [
      { status: 201, etag: '"etag-1"', url: "https://example.test/calendars/me/work/evt.ics" },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  const event = makeEvent();
  const result = await backend.upsert(event);
  assert.equal(ops.creates.length, 1);
  assert.equal(ops.creates[0]!.calendarUrl, CAL);
  // Filename embeds the canonical UID stem (- and . preserved, @ replaced).
  assert.ok(ops.creates[0]!.filename.endsWith(".ics"));
  assert.ok(ops.creates[0]!.iCalString.includes(`UID:${caldavUid(event)}`));
  assert.equal(result.remoteId, "https://example.test/calendars/me/work/evt.ics");
  assert.equal(result.remoteEtag, '"etag-1"');
});

// ---------- upsert: update fast path ----------

test("upsert with existingId uses update fast path", async () => {
  const ops = fakeOps({
    updateResults: [
      {
        status: 204,
        etag: '"etag-v2"',
        url: "https://example.test/calendars/me/work/evt.ics",
      },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  const event = makeEvent();
  const result = await backend.upsert(event, {
    existingId: "https://example.test/calendars/me/work/evt.ics",
  });
  assert.equal(ops.updates.length, 1);
  assert.equal(ops.creates.length, 0);
  assert.equal(result.remoteEtag, '"etag-v2"');
});

test("upsert falls back to create when update returns 404", async () => {
  const ops = fakeOps({
    updateResults: [
      { status: 404, etag: "", url: "https://gone" },
    ],
    createResults: [
      { status: 201, etag: '"new"', url: "https://example.test/calendars/me/work/new.ics" },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  const result = await backend.upsert(makeEvent(), {
    existingId: "https://gone",
  });
  assert.equal(ops.updates.length, 1);
  assert.equal(ops.creates.length, 1);
  assert.equal(result.remoteId, "https://example.test/calendars/me/work/new.ics");
});

test("upsert falls back to create when update throws", async () => {
  const ops = fakeOps({
    updateResults: [new Error("ECONNRESET")],
    createResults: [
      { status: 201, etag: '"new"', url: "https://example.test/calendars/me/work/new.ics" },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  const result = await backend.upsert(makeEvent(), { existingId: "https://gone" });
  assert.equal(ops.creates.length, 1);
  assert.equal(result.remoteEtag, '"new"');
});

// ---------- tombstone retry ----------

test("create retries with alt UID when server returns 500 (tombstone)", async () => {
  const ops = fakeOps({
    createResults: [
      { status: 500, etag: "", url: "https://example.test/x" },
      { status: 201, etag: '"alt"', url: "https://example.test/calendars/me/work/alt.ics" },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  const event = makeEvent({ subject: "Conflicted" });
  const canonicalUid = caldavUid(event);
  const expectedAltUid = canonicalUid.replace("@ete-look-sync", "-r2@ete-look-sync");

  const result = await backend.upsert(event);
  assert.equal(ops.creates.length, 2);

  // First request used the canonical UID.
  assert.ok(ops.creates[0]!.iCalString.includes(`UID:${canonicalUid}`));
  // Second request used the alt UID with the -r2 suffix.
  assert.ok(ops.creates[1]!.iCalString.includes(`UID:${expectedAltUid}`));
  // Filenames also reflect the different UIDs.
  assert.notEqual(ops.creates[0]!.filename, ops.creates[1]!.filename);

  assert.equal(result.remoteId, "https://example.test/calendars/me/work/alt.ics");
});

test("create propagates non-500 errors without retrying", async () => {
  const ops = fakeOps({
    createResults: [{ status: 403, etag: "", url: CAL + "evt.ics" }],
  });
  const backend = new CalDAVBackend(ops, CAL);
  await assert.rejects(() => backend.upsert(makeEvent()), /HTTP 403/);
  // Only one attempt — no tombstone retry for 4xx.
  assert.equal(ops.creates.length, 1);
});

test("create wraps both errors when 500 retry also fails", async () => {
  const ops = fakeOps({
    createResults: [
      { status: 500, etag: "", url: "" },
      { status: 500, etag: "", url: "" },
    ],
  });
  const backend = new CalDAVBackend(ops, CAL);
  await assert.rejects(
    () => backend.upsert(makeEvent()),
    /CalDAV PUT failed on both canonical and alt UID/,
  );
  assert.equal(ops.creates.length, 2);
});

// ---------- delete ----------

test("delete sends one DELETE for the resource", async () => {
  const ops = fakeOps({
    deleteResults: [{ status: 204, etag: "", url: "https://x/y" }],
  });
  const backend = new CalDAVBackend(ops, CAL);
  await backend.delete("https://x/y");
  assert.equal(ops.deletes.length, 1);
  assert.equal(ops.deletes[0]!.url, "https://x/y");
});

test("delete swallows 404 (already gone)", async () => {
  const ops = fakeOps({
    deleteResults: [{ status: 404, etag: "", url: "https://x/y" }],
  });
  const backend = new CalDAVBackend(ops, CAL);
  await backend.delete("https://x/y"); // does not throw
});

test("delete swallows arbitrary errors so partial-run retries succeed", async () => {
  const ops = fakeOps({
    deleteResults: [new Error("network down")],
  });
  const backend = new CalDAVBackend(ops, CAL);
  await backend.delete("https://x/y"); // does not throw
});

// ---------- misc ----------

test("close is a no-op (tsdav is stateless)", () => {
  const backend = new CalDAVBackend(fakeOps(), CAL);
  backend.close();
});
