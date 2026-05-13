import { test } from "node:test";
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.js";
import { contentHash, type Event } from "./models.js";
import { legacyRowToEvent, migrateLegacy } from "./migrate.js";
import { Store } from "./store.js";

// ---------- scaffolding ----------

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCfg(dbFile: string): Config {
  return {
    stateDir: path.dirname(dbFile),
    profileDir: "",
    cookiesFile: "",
    bearerFile: "",
    dbFile,
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
    daysForward: 365,
    freezePastDays: 2,
    intervalMinutes: 30,
  };
}

const LEGACY_SCHEMA_SQL = `
CREATE TABLE events (
    item_id           TEXT PRIMARY KEY,
    change_key        TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    caldav_uid        TEXT NOT NULL,
    caldav_href       TEXT,
    caldav_etag       TEXT,
    start_iso         TEXT NOT NULL,
    subject           TEXT NOT NULL,
    last_modified_iso TEXT,
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    last_pushed_at    INTEGER,
    record_json       TEXT NOT NULL,
    push_error        TEXT
);
`;

/**
 * Build a fake legacy DB that matches the Python schema, using a TS
 * Event as the source of truth so the legacy content_hash agrees
 * with our parity check.
 */
function makeLegacyDb(rows: Array<{
  event: Event;
  caldavHref?: string | null;
  caldavEtag?: string | null;
  pushError?: string | null;
  recordJsonOverride?: string;
}>): string {
  const dir = tempDir("legacy-");
  const dbPath = path.join(dir, "events.sqlite");
  const db = new Database(dbPath);
  db.exec(LEGACY_SCHEMA_SQL);
  const insert = db.prepare(`
    INSERT INTO events (
      item_id, change_key, content_hash, caldav_uid,
      caldav_href, caldav_etag, start_iso, subject,
      last_modified_iso, first_seen_at, last_seen_at,
      last_pushed_at, record_json, push_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Math.floor(Date.now() / 1000);
  for (const { event, caldavHref, caldavEtag, pushError, recordJsonOverride } of rows) {
    const recordJson = recordJsonOverride ?? JSON.stringify(eventToLegacyRecord(event));
    insert.run(
      event.itemId,
      event.changeKey,
      contentHash(event),
      legacyCaldavUid(event.itemId),
      caldavHref ?? null,
      caldavEtag ?? null,
      event.startIso,
      event.subject,
      event.lastModifiedIso || null,
      now,
      now,
      caldavHref ? now : null,
      recordJson,
      pushError ?? null,
    );
  }
  db.close();
  return dbPath;
}

function eventToLegacyRecord(e: Event): Record<string, unknown> {
  return {
    subject: e.subject,
    start_iso: e.startIso,
    end_iso: e.endIso,
    is_all_day: e.isAllDay,
    location: e.location,
    body_text: e.bodyText,
    organizer_email: e.organizerEmail,
    organizer_name: e.organizerName,
    attendees: [...e.attendees],
    is_recurring: e.isRecurring,
    is_cancelled: e.isCancelled,
    last_modified_iso: e.lastModifiedIso,
    web_link: e.webLink,
  };
}

function legacyCaldavUid(itemId: string): string {
  // Match the same UID formula used by both Python and TS — the
  // value doesn't drive any assertions, but using the real shape
  // avoids surprises in row-by-row inspection.
  // (Synthetic placeholder for the fixture; the real value is
  // recomputed by Store.upsert during migration.)
  return `ocs-${itemId}@outlook-sync`;
}

function makeEvent(itemId: string, overrides: Partial<Event> = {}): Event {
  return {
    itemId,
    changeKey: "ck",
    subject: "Test Event",
    startIso: "2026-05-15T10:00:00Z",
    endIso: "2026-05-15T11:00:00Z",
    isAllDay: false,
    location: "Room 1",
    bodyText: "Some body text",
    organizerEmail: "alice@example.com",
    organizerName: "Alice",
    attendees: ["bob@example.com"],
    isRecurring: false,
    isCancelled: false,
    lastModifiedIso: "2026-05-14T09:00:00Z",
    webLink: "",
    ...overrides,
  };
}

// ---------- legacyRowToEvent ----------

test("legacyRowToEvent translates snake_case record_json into camelCase Event", () => {
  const event = makeEvent("evt-1");
  const legacyRow = {
    item_id: event.itemId,
    change_key: event.changeKey,
    content_hash: contentHash(event),
    caldav_uid: "uid",
    caldav_href: "href-1",
    caldav_etag: "etag-1",
    start_iso: event.startIso,
    subject: event.subject,
    last_modified_iso: event.lastModifiedIso,
    first_seen_at: 0,
    last_seen_at: 0,
    last_pushed_at: 0,
    record_json: JSON.stringify(eventToLegacyRecord(event)),
    push_error: null,
  };
  const recovered = legacyRowToEvent(legacyRow);
  assert.ok(recovered);
  assert.equal(recovered!.subject, event.subject);
  assert.equal(recovered!.startIso, event.startIso);
  assert.equal(recovered!.location, event.location);
  assert.deepEqual([...recovered!.attendees], [...event.attendees]);
  // The whole point of parity: re-hashing the recovered Event matches
  // the legacy hash.
  assert.equal(contentHash(recovered!), contentHash(event));
});

test("legacyRowToEvent returns null on unparseable record_json", () => {
  const row = {
    item_id: "x",
    change_key: "ck",
    content_hash: "",
    caldav_uid: "",
    caldav_href: null,
    caldav_etag: null,
    start_iso: "",
    subject: "",
    last_modified_iso: null,
    first_seen_at: 0,
    last_seen_at: 0,
    last_pushed_at: null,
    record_json: "{not json",
    push_error: null,
  };
  assert.equal(legacyRowToEvent(row), null);
});

// ---------- migrateLegacy ----------

test("migrateLegacy imports rows and preserves remote_id / remote_etag", () => {
  const events = [
    makeEvent("e1"),
    makeEvent("e2", { subject: "Other", startIso: "2026-05-20T10:00:00Z" }),
  ];
  const legacyDb = makeLegacyDb([
    { event: events[0]!, caldavHref: "https://dav/a.ics", caldavEtag: '"etag-a"' },
    { event: events[1]!, caldavHref: "https://dav/b.ics", caldavEtag: '"etag-b"' },
  ]);
  const targetDir = tempDir("target-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  const result = migrateLegacy(legacyDb, cfg);
  assert.equal(result.imported, 2);
  assert.equal(result.hashMismatches, 0);
  assert.equal(result.recordJsonErrors, 0);

  const store = new Store(cfg.dbFile);
  try {
    const e1 = store.get("e1");
    assert.equal(e1!.remoteId, "https://dav/a.ics");
    assert.equal(e1!.remoteEtag, '"etag-a"');
    assert.equal(e1!.backend, "caldav");
    assert.equal(e1!.pushError, null);
    // contentHash on the recovered Event must equal what was stored.
    assert.equal(e1!.contentHash, contentHash(events[0]!));

    const e2 = store.get("e2");
    assert.equal(e2!.remoteId, "https://dav/b.ics");
  } finally {
    store.close();
  }
});

test("migrateLegacy refuses to merge into a non-empty target without --force", () => {
  const legacyDb = makeLegacyDb([{ event: makeEvent("legacy-1") }]);
  const targetDir = tempDir("target-existing-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));

  // Seed the target with a pre-existing row.
  const store = new Store(cfg.dbFile);
  store.upsert(makeEvent("preexisting"));
  store.close();

  assert.throws(
    () => migrateLegacy(legacyDb, cfg),
    /already has 1 row/,
  );
});

test("migrateLegacy --force merges into a non-empty target", () => {
  const legacyDb = makeLegacyDb([
    { event: makeEvent("from-legacy"), caldavHref: "https://dav/x.ics", caldavEtag: '"x"' },
  ]);
  const targetDir = tempDir("target-merge-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  const store = new Store(cfg.dbFile);
  store.upsert(makeEvent("preexisting"));
  store.close();

  const result = migrateLegacy(legacyDb, cfg, { force: true });
  assert.equal(result.imported, 1);

  const reopened = new Store(cfg.dbFile);
  try {
    assert.ok(reopened.get("preexisting"));
    assert.ok(reopened.get("from-legacy"));
    assert.equal(reopened.get("from-legacy")!.remoteId, "https://dav/x.ics");
  } finally {
    reopened.close();
  }
});

test("migrateLegacy aborts when the parity check fails", () => {
  const event = makeEvent("e1");
  // Sabotage the stored content_hash so it diverges from what TS
  // contentHash() would compute from the same record_json.
  const legacyDb = makeLegacyDb([{ event }]);
  const sabotage = new Database(legacyDb);
  sabotage
    .prepare("UPDATE events SET content_hash = 'NOT-A-REAL-HASH' WHERE item_id = ?")
    .run(event.itemId);
  sabotage.close();

  const targetDir = tempDir("target-parity-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  assert.throws(
    () => migrateLegacy(legacyDb, cfg),
    /parity check failed/,
  );
  // Target store was not created because the migration aborted before
  // the begin() call.
  assert.equal(fs.existsSync(cfg.dbFile), true); // (Store was opened during the check)
  // …but no rows were inserted.
  const store = new Store(cfg.dbFile);
  try {
    assert.equal(store.iterRows().length, 0);
  } finally {
    store.close();
  }
});

test("migrateLegacy --skip-parity-check bypasses the sanity check", () => {
  const event = makeEvent("e1");
  const legacyDb = makeLegacyDb([{ event }]);
  const sabotage = new Database(legacyDb);
  sabotage
    .prepare("UPDATE events SET content_hash = 'BOGUS' WHERE item_id = ?")
    .run(event.itemId);
  sabotage.close();

  const targetDir = tempDir("target-skip-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  const result = migrateLegacy(legacyDb, cfg, { skipParityCheck: true });
  // Still counts as a mismatch because the recomputed hash != legacy.
  assert.equal(result.hashMismatches, 1);
  assert.equal(result.imported, 1);
});

test("migrateLegacy carries push_error rows across so fix-errors can retry", () => {
  const event = makeEvent("failed-evt");
  const legacyDb = makeLegacyDb([
    { event, caldavHref: "https://dav/y.ics", pushError: "Conflict 409" },
  ]);
  const targetDir = tempDir("target-err-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  migrateLegacy(legacyDb, cfg);

  const store = new Store(cfg.dbFile);
  try {
    const row = store.get(event.itemId);
    assert.equal(row!.pushError, "Conflict 409");
    assert.equal(row!.remoteId, "https://dav/y.ics");
  } finally {
    store.close();
  }
});

test("migrateLegacy salvages rows with unparseable record_json", () => {
  const event = makeEvent("salvage");
  const legacyDb = makeLegacyDb([
    { event, recordJsonOverride: "{garbage", caldavHref: "https://dav/z.ics" },
  ]);
  const targetDir = tempDir("target-salvage-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  const result = migrateLegacy(legacyDb, cfg, { skipParityCheck: true });
  assert.equal(result.imported, 0);
  assert.equal(result.recordJsonErrors, 1);

  // The skeleton should still be in the store, with caldav metadata.
  const store = new Store(cfg.dbFile);
  try {
    const row = store.get("salvage");
    assert.ok(row);
    assert.equal(row!.remoteId, "https://dav/z.ics");
  } finally {
    store.close();
  }
});

test("migrateLegacy throws when the legacy DB doesn't exist", () => {
  const targetDir = tempDir("target-missing-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  assert.throws(
    () => migrateLegacy("/definitely/not/a/file.sqlite", cfg),
    /not found/,
  );
});

test("migrateLegacy is a no-op on an empty legacy DB", () => {
  const legacyDb = makeLegacyDb([]);
  const targetDir = tempDir("target-empty-");
  const cfg = makeCfg(path.join(targetDir, "events.sqlite"));
  const result = migrateLegacy(legacyDb, cfg);
  assert.equal(result.imported, 0);
});
