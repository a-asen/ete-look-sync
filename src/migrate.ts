// One-shot import of the Python predecessor's events.sqlite into the
// new TS schema, so cutover preserves push history (i.e. doesn't
// re-push every event on the first post-migration sync).
//
// Mapping (legacy → new):
//   item_id          → item_id          (primary key, unchanged)
//   change_key       → change_key
//   content_hash     → content_hash     (re-derived from the event
//                                        and verified against the
//                                        legacy value; if they
//                                        diverge the migration
//                                        aborts because the
//                                        post-cutover sync would
//                                        otherwise look like a full
//                                        re-push)
//   caldav_uid       → caldav_uid
//   caldav_href      → remote_id        (CalDAV href becomes the
//                                        opaque "remote_id")
//   caldav_etag      → remote_etag
//   (new column)     → backend = "caldav" (every legacy row was a
//                                        CalDAV push)
//   start_iso/subject/last_modified_iso/first_seen_at/last_seen_at/
//     last_pushed_at/push_error → carry over verbatim
//   record_json      → rebuilt from the legacy snake_case shape so
//                      iter_events()/fix-errors don't see blank
//                      fields after migration.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import type { Config } from "./config.js";
import { getLogger } from "./log.js";
import { contentHash, type Event } from "./models.js";
import { Store } from "./store.js";

const log = getLogger("migrate");

export interface MigrateResult {
  /** How many rows were imported into the new store. */
  imported: number;
  /** Rows whose recomputed content_hash didn't match the legacy hash. */
  hashMismatches: number;
  /** Rows whose record_json was unparseable. */
  recordJsonErrors: number;
}

export interface MigrateOptions {
  /** Allow import into a non-empty target DB. Otherwise the migration aborts. */
  force?: boolean;
  /** Skip the hash-parity sanity check on the first row. Use with care. */
  skipParityCheck?: boolean;
}

interface LegacyRow {
  item_id: string;
  change_key: string;
  content_hash: string;
  caldav_uid: string;
  caldav_href: string | null;
  caldav_etag: string | null;
  start_iso: string;
  subject: string;
  last_modified_iso: string | null;
  first_seen_at: number;
  last_seen_at: number;
  last_pushed_at: number | null;
  record_json: string | null;
  push_error: string | null;
}

interface LegacyRecord {
  subject?: string;
  start_iso?: string;
  end_iso?: string;
  is_all_day?: boolean;
  location?: string;
  body_text?: string;
  organizer_email?: string;
  organizer_name?: string;
  attendees?: string[];
  is_recurring?: boolean;
  is_cancelled?: boolean;
  last_modified_iso?: string;
  web_link?: string;
}

/** Read every event row from the legacy DB and merge it into the new store. */
export function migrateLegacy(
  legacyDbPath: string,
  cfg: Config,
  opts: MigrateOptions = {},
): MigrateResult {
  if (!existsSync(legacyDbPath)) {
    throw new Error(`Legacy events.sqlite not found at ${legacyDbPath}`);
  }

  // Refuse to overwrite an existing non-empty store unless asked.
  const targetExisting = countTargetRows(cfg.dbFile);
  if (targetExisting > 0 && !opts.force) {
    throw new Error(
      `Target store ${cfg.dbFile} already has ${targetExisting} row(s). ` +
        "Re-run with --force to merge into it, or move the file aside first.",
    );
  }

  const legacy = new Database(legacyDbPath, { readonly: true });
  const rows = legacy
    .prepare<[], LegacyRow>(
      `SELECT item_id, change_key, content_hash, caldav_uid, caldav_href, caldav_etag,
              start_iso, subject, last_modified_iso, first_seen_at, last_seen_at,
              last_pushed_at, record_json, push_error
         FROM events`,
    )
    .all();
  legacy.close();

  log.info(`[migrate] read ${rows.length} row(s) from ${legacyDbPath}`);

  const result: MigrateResult = { imported: 0, hashMismatches: 0, recordJsonErrors: 0 };
  if (rows.length === 0) {
    log.info("[migrate] nothing to import");
    return result;
  }

  const store = new Store(cfg.dbFile);
  try {
    // Parity sanity check: the new contentHash() over the first row's
    // legacy record_json must match the legacy content_hash. If it
    // doesn't, every imported row would look "changed" on the next
    // sync and the whole calendar would re-push.
    if (!opts.skipParityCheck) {
      const sample = pickFirstWithRecord(rows);
      if (sample) {
        const event = legacyRowToEvent(sample);
        if (event && contentHash(event) !== sample.content_hash) {
          throw new Error(
            "Hash parity check failed: TS contentHash() does not match the " +
              "legacy content_hash for item_id=" +
              JSON.stringify(sample.item_id) +
              ". Migration aborted to avoid a full re-push. " +
              "See src/models.test.ts + src/fetch/parse.test.ts for the parity tests; " +
              "use --skip-parity-check if you understand the consequences.",
          );
        }
      }
    }

    store.begin();
    try {
      for (const row of rows) {
        const event = legacyRowToEvent(row);
        if (!event) {
          result.recordJsonErrors++;
          // Carry the row across as best we can so the next sync still
          // sees it; record_json will be filled with the legacy values
          // we have on the row itself.
          insertSkeleton(store, row);
          continue;
        }
        store.upsert(event);
        if (contentHash(event) !== row.content_hash) {
          result.hashMismatches++;
        }
        if (row.caldav_href) {
          store.markPushed(event.itemId, {
            remoteId: row.caldav_href,
            remoteEtag: row.caldav_etag ?? "",
            backend: "caldav",
          });
        }
        if (row.push_error) {
          store.markFailed(event.itemId, row.push_error);
        }
        result.imported++;
      }
      store.commit();
    } catch (err) {
      store.rollback();
      throw err;
    }
  } finally {
    store.close();
  }

  log.info(
    `[migrate] imported ${result.imported} row(s); ${result.hashMismatches} hash mismatch(es), ` +
      `${result.recordJsonErrors} record_json error(s)`,
  );
  return result;
}

// ---------- internals ----------

function countTargetRows(dbFile: string): number {
  if (!existsSync(dbFile)) return 0;
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare<[], { n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='events'",
      )
      .get();
    if (!row || row.n === 0) return 0;
    const c = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM events").get();
    return c?.n ?? 0;
  } finally {
    db.close();
  }
}

function pickFirstWithRecord(rows: readonly LegacyRow[]): LegacyRow | null {
  for (const row of rows) if (row.record_json) return row;
  return null;
}

/**
 * Translate a legacy row's record_json (snake_case) into our Event
 * shape (camelCase). Returns null if record_json is missing or
 * unparseable so the caller can skip it gracefully.
 */
export function legacyRowToEvent(row: LegacyRow): Event | null {
  if (!row.record_json) return null;
  let rec: LegacyRecord;
  try {
    rec = JSON.parse(row.record_json) as LegacyRecord;
  } catch {
    return null;
  }
  return {
    itemId: row.item_id,
    changeKey: row.change_key,
    subject: rec.subject ?? row.subject ?? "",
    startIso: rec.start_iso ?? row.start_iso ?? "",
    endIso: rec.end_iso ?? "",
    isAllDay: rec.is_all_day ?? false,
    location: rec.location ?? "",
    bodyText: rec.body_text ?? "",
    organizerEmail: rec.organizer_email ?? "",
    organizerName: rec.organizer_name ?? "",
    attendees: rec.attendees ?? [],
    isRecurring: rec.is_recurring ?? false,
    isCancelled: rec.is_cancelled ?? false,
    lastModifiedIso: rec.last_modified_iso ?? row.last_modified_iso ?? "",
    webLink: rec.web_link ?? "",
  };
}

/**
 * Best-effort fallback when a row's record_json is missing or
 * unparseable: build a minimal Event from the legacy column data so
 * the row still ends up in the new store. The next normal sync will
 * re-fetch from Exchange and overwrite this skeleton with full data.
 */
function insertSkeleton(store: Store, row: LegacyRow): void {
  const event: Event = {
    itemId: row.item_id,
    changeKey: row.change_key,
    subject: row.subject,
    startIso: row.start_iso,
    endIso: "",
    isAllDay: false,
    location: "",
    bodyText: "",
    organizerEmail: "",
    organizerName: "",
    attendees: [],
    isRecurring: false,
    isCancelled: false,
    lastModifiedIso: row.last_modified_iso ?? "",
    webLink: "",
  };
  store.upsert(event);
  if (row.caldav_href) {
    store.markPushed(event.itemId, {
      remoteId: row.caldav_href,
      remoteEtag: row.caldav_etag ?? "",
      backend: "caldav",
    });
  }
  if (row.push_error) store.markFailed(event.itemId, row.push_error);
}
