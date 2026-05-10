// Local SQLite store: what we have already pushed to a backend, and how.
//
// The differ is the primary consumer: given a fresh list of `Event`s from
// the fetch layer it needs to know which are new, which changed, and which
// disappeared. We persist three things per item:
//
//   - the Exchange ImmutableId (primary key — stable across syncs because
//     we requested IdType="ImmutableId" on capture),
//   - a content hash so "did this change?" is a string compare, and
//   - the backend's (remote_id, remote_etag) for the most recent push,
//     so future updates and deletes can target the same remote resource.
//
// `remote_id` is backend-opaque — for CalDAV it's an href, for Etebase
// it's an item UID. The schema deliberately doesn't bake either name in,
// unlike the Python predecessor which used caldav_href / caldav_etag.
//
// Schema is applied idempotently on every connection; there is no
// separate migration step at this scale.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { contentHash, caldavUid, type Event } from "./models.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
    item_id           TEXT PRIMARY KEY,
    change_key        TEXT NOT NULL,
    content_hash      TEXT NOT NULL,
    caldav_uid        TEXT NOT NULL,
    remote_id         TEXT,
    remote_etag       TEXT,
    backend           TEXT,
    start_iso         TEXT NOT NULL,
    subject           TEXT NOT NULL,
    last_modified_iso TEXT,
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    last_pushed_at    INTEGER,
    record_json       TEXT NOT NULL,
    push_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_iso);
`;

/**
 * The subset of a stored event the differ and backends need.
 *
 * Returning a structured record (not a raw row) keeps the rest of the
 * code unaware of column indices — adding a new column does not need
 * every consumer to be re-checked.
 */
export interface StoredRow {
  itemId: string;
  contentHash: string;
  caldavUid: string;
  remoteId: string | null;
  remoteEtag: string | null;
  backend: string | null;
  startIso: string;
  subject: string;
  pushError: string | null;
}

interface RawRow {
  item_id: string;
  change_key: string;
  content_hash: string;
  caldav_uid: string;
  remote_id: string | null;
  remote_etag: string | null;
  backend: string | null;
  start_iso: string;
  subject: string;
  last_modified_iso: string | null;
  record_json: string;
  push_error: string | null;
}

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ----- reads ----------------------------------------------------

  get(itemId: string): StoredRow | undefined {
    const row = this.db
      .prepare<[string], RawRow>(SELECT_ROW + " WHERE item_id = ?")
      .get(itemId);
    return row ? rowToStored(row) : undefined;
  }

  iterRows(): StoredRow[] {
    const rows = this.db.prepare<[], RawRow>(SELECT_ROW).all();
    return rows.map(rowToStored);
  }

  /**
   * Yield (event, lastError) for every row with a recorded push failure.
   * Used by `fix-errors` to retry pushes without re-fetching from Exchange.
   */
  iterFailed(): Array<{ event: Event; error: string }> {
    const rows = this.db
      .prepare<[], RawRow & { push_error: string }>(
        SELECT_ROW + " WHERE push_error IS NOT NULL ORDER BY start_iso",
      )
      .all();
    return rows.map((r) => ({ event: rowToEvent(r), error: r.push_error }));
  }

  countFailures(): number {
    const row = this.db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM events WHERE push_error IS NOT NULL",
      )
      .get();
    return row?.n ?? 0;
  }

  /** Reconstruct every Event in the store, ordered by start time. Used by export-ics. */
  iterEvents(): Event[] {
    const rows = this.db
      .prepare<[], RawRow>(SELECT_ROW + " ORDER BY start_iso")
      .all();
    return rows.map(rowToEvent);
  }

  /** Fastest diff input shape: { item_id: content_hash } for every stored row. */
  allHashes(): Map<string, string> {
    const rows = this.db
      .prepare<[], { item_id: string; content_hash: string }>(
        "SELECT item_id, content_hash FROM events",
      )
      .all();
    return new Map(rows.map((r) => [r.item_id, r.content_hash]));
  }

  // ----- writes ----------------------------------------------------

  /**
   * Insert or update the row for `event`, preserving backend metadata.
   *
   * `remote_id` / `remote_etag` / `backend` are deliberately NOT
   * overwritten on update — those are the backend's responsibility to
   * set via markPushed() after a successful push. Letting an upsert
   * clear them would orphan the remote resource.
   */
  upsert(event: Event): void {
    const now = Math.floor(Date.now() / 1000);
    const recordJson = JSON.stringify(eventToRecord(event));
    this.db
      .prepare(`
        INSERT INTO events (
          item_id, change_key, content_hash, caldav_uid,
          start_iso, subject, last_modified_iso,
          first_seen_at, last_seen_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          change_key        = excluded.change_key,
          content_hash      = excluded.content_hash,
          start_iso         = excluded.start_iso,
          subject           = excluded.subject,
          last_modified_iso = excluded.last_modified_iso,
          last_seen_at      = excluded.last_seen_at,
          record_json       = excluded.record_json
      `)
      .run(
        event.itemId,
        event.changeKey,
        contentHash(event),
        caldavUid(event),
        event.startIso,
        event.subject,
        event.lastModifiedIso,
        now,
        now,
        recordJson,
      );
  }

  /** Record a successful push so future updates target the same remote resource. */
  markPushed(
    itemId: string,
    args: { remoteId: string; remoteEtag: string; backend: string },
  ): void {
    this.db
      .prepare(`
        UPDATE events
           SET remote_id = ?, remote_etag = ?, backend = ?,
               last_pushed_at = ?, push_error = NULL
         WHERE item_id = ?
      `)
      .run(
        args.remoteId,
        args.remoteEtag,
        args.backend,
        Math.floor(Date.now() / 1000),
        itemId,
      );
  }

  /** Record a push failure so fix-errors can target this event. */
  markFailed(itemId: string, error: string): void {
    this.db
      .prepare("UPDATE events SET push_error = ? WHERE item_id = ?")
      .run(error, itemId);
  }

  /**
   * Bump last_seen_at without touching the rest of the row. Used to
   * record "this still exists upstream" when nothing about the event
   * changed; future cleanup logic can use the gap between last_seen_at
   * and now to decide what's gone forever vs. transiently missing.
   */
  touchSeen(itemId: string): void {
    this.db
      .prepare("UPDATE events SET last_seen_at = ? WHERE item_id = ?")
      .run(Math.floor(Date.now() / 1000), itemId);
  }

  delete(itemId: string): void {
    this.db.prepare("DELETE FROM events WHERE item_id = ?").run(itemId);
  }

  // ----- transactions ---------------------------------------------

  begin(): void {
    this.db.exec("BEGIN");
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }
}

// ---------- internals ----------

const SELECT_ROW = `
  SELECT item_id, change_key, content_hash, caldav_uid,
         remote_id, remote_etag, backend,
         start_iso, subject, last_modified_iso,
         record_json, push_error
    FROM events
`;

function rowToStored(r: RawRow): StoredRow {
  return {
    itemId: r.item_id,
    contentHash: r.content_hash,
    caldavUid: r.caldav_uid,
    remoteId: r.remote_id,
    remoteEtag: r.remote_etag,
    backend: r.backend,
    startIso: r.start_iso,
    subject: r.subject,
    pushError: r.push_error,
  };
}

function rowToEvent(r: RawRow): Event {
  const rec = JSON.parse(r.record_json) as Partial<Event>;
  return {
    itemId: r.item_id,
    changeKey: r.change_key,
    subject: rec.subject ?? "",
    startIso: rec.startIso ?? "",
    endIso: rec.endIso ?? "",
    isAllDay: rec.isAllDay ?? false,
    location: rec.location ?? "",
    bodyText: rec.bodyText ?? "",
    organizerEmail: rec.organizerEmail ?? "",
    organizerName: rec.organizerName ?? "",
    attendees: rec.attendees ?? [],
    isRecurring: rec.isRecurring ?? false,
    isCancelled: rec.isCancelled ?? false,
    lastModifiedIso: rec.lastModifiedIso ?? "",
    webLink: rec.webLink ?? "",
  };
}

/**
 * Plain-object snapshot of an Event for `record_json`. The full `raw`
 * OWA dict is intentionally not persisted — it's a moving target across
 * Exchange versions and storing it tempts future consumers to depend on
 * its shape, which would couple the store to the wire format we worked
 * hard to isolate behind the fetch layer.
 */
function eventToRecord(event: Event): Record<string, unknown> {
  return {
    subject: event.subject,
    startIso: event.startIso,
    endIso: event.endIso,
    isAllDay: event.isAllDay,
    location: event.location,
    bodyText: event.bodyText,
    organizerEmail: event.organizerEmail,
    organizerName: event.organizerName,
    attendees: [...event.attendees],
    isRecurring: event.isRecurring,
    isCancelled: event.isCancelled,
    lastModifiedIso: event.lastModifiedIso,
    webLink: event.webLink,
  };
}
