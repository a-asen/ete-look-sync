// End-to-end sync runner: fetch → diff → push (or print, in dry-run).
//
// This is the only place that opens Store/Session/Backend together and
// is responsible for closing them in a `finally`. Both the CLI's
// `sync-once` and any future timer-driven entry point share the same
// `runSyncOnce` call.

import { loadSession, SessionExpired, SessionNotCaptured, type Session } from "../auth/session.js";
import type { Config } from "../config.js";
import { fetchCalendarView, FetchError } from "../fetch/owa.js";
import { getLogger } from "../log.js";
import type { Event } from "../models.js";
import { Store, type StoredRow } from "../store.js";
import { type Backend, BackendConfigError, openBackend } from "./backend.js";
import { computeDiff, type Diff, PAST_GRACE_DAYS } from "./differ.js";

const log = getLogger("orchestrator");

/** Counts and durations from one sync run, surfaced to the caller for logging. */
export interface SyncSummary {
  fetched: number;
  creates: number;
  updates: number;
  deletes: number;
  unchanged: number;
  frozenPast: number;
  outOfWindow: number;
  pushedCreates: number;
  pushedUpdates: number;
  pushedDeletes: number;
  errors: string[];
  elapsedSec: number;
}

export interface SyncOptions {
  dryRun?: boolean;
  daysBack?: number;
  daysForward?: number;
  /** Suppress the "fetch returned 0 events but stored events would be deleted" safety check. */
  allowEmptyFetch?: boolean;
  /** Disable the today-N-days cutoff so historical events get pushed too. */
  noFreezePast?: boolean;
}

/** Internals re-exported for tests; production callers use `runSyncOnce`. */
export interface SyncDeps {
  loadSession: (cfg: Config) => Session;
  fetchEvents: (session: Session, cfg: Config, start: Date, end: Date) => Promise<Event[]>;
  openStore: (cfg: Config) => Store;
  openBackend: (cfg: Config) => Promise<Backend>;
  now: () => Date;
}

const defaultDeps: SyncDeps = {
  loadSession,
  fetchEvents: fetchCalendarView,
  openStore: (cfg) => new Store(cfg.dbFile),
  openBackend,
  now: () => new Date(),
};

/** One full sync: load session, fetch, diff, optionally push. */
export async function runSyncOnce(cfg: Config, opts: SyncOptions = {}): Promise<SyncSummary> {
  return runSyncOnceWith(cfg, opts, defaultDeps);
}

export async function runSyncOnceWith(
  cfg: Config,
  opts: SyncOptions,
  deps: SyncDeps,
): Promise<SyncSummary> {
  const summary = makeSummary();
  const started = Date.now();

  const daysBack = opts.daysBack ?? cfg.daysBack;
  const daysForward = opts.daysForward ?? cfg.daysForward;
  const today = startOfUtcDay(deps.now());
  const fetchStart = new Date(today.getTime() - daysBack * 86400_000);
  const fetchEnd = new Date(today.getTime() + daysForward * 86400_000);
  log.info(
    `[sync] window ${dateOnly(fetchStart)} → ${dateOnly(fetchEnd)} (-${daysBack}d / +${daysForward}d)`,
  );

  let session: Session;
  try {
    session = deps.loadSession(cfg);
  } catch (err) {
    if (err instanceof SessionNotCaptured || err instanceof SessionExpired) {
      record(summary, started, err.message);
      return summary;
    }
    throw err;
  }

  let events: Event[];
  try {
    events = await deps.fetchEvents(session, cfg, fetchStart, fetchEnd);
  } catch (err) {
    if (err instanceof FetchError) {
      record(summary, started, `fetch failed: ${err.message}`);
      return summary;
    }
    throw err;
  }
  summary.fetched = events.length;
  log.info(`[sync] fetched ${events.length} events`);

  const store = deps.openStore(cfg);
  try {
    store.begin();
    try {
      const cutoff = opts.noFreezePast
        ? new Date(0)
        : new Date(today.getTime() - (cfg.freezePastDays || PAST_GRACE_DAYS) * 86400_000);
      const diff = computeDiff(events, store.iterRows(), {
        fetchStart,
        fetchEnd,
        cutoff,
      });
      copyDiffCounts(diff, summary);
      log.info(
        `[sync] diff: +${diff.creates.length} ~${diff.updates.length} -${diff.deletes.length} ` +
          `(unchanged=${diff.unchanged.length}, frozen_past=${diff.frozenPast}, ` +
          `out_of_window=${diff.outOfWindow})`,
      );

      // Safety net: if Exchange returned nothing but we'd delete
      // stored events, that almost certainly means the OWA window
      // was too large and silently returned zero. Refuse rather
      // than wipe the calendar.
      if (
        summary.fetched === 0 &&
        diff.deletes.length > 0 &&
        !opts.allowEmptyFetch
      ) {
        const msg =
          `Fetch returned 0 events but ${diff.deletes.length} stored event(s) would be deleted — ` +
          "looks like Exchange rejected the window size silently. No changes made. " +
          "Try a smaller --days-back, or pass --allow-empty-fetch to force the deletion.";
        record(summary, started, msg);
        store.rollback();
        return summary;
      }

      if (opts.dryRun) {
        printDryRunPlan(diff);
        store.rollback();
        summary.elapsedSec = (Date.now() - started) / 1000;
        return summary;
      }

      let backend: Backend;
      try {
        backend = await deps.openBackend(cfg);
      } catch (err) {
        if (err instanceof BackendConfigError) {
          record(summary, started, err.message);
          store.rollback();
          return summary;
        }
        throw err;
      }

      try {
        await executePlan(diff, store, backend, summary);
      } finally {
        await backend.close();
      }

      store.commit();
    } catch (err) {
      store.rollback();
      throw err;
    }
  } finally {
    store.close();
  }

  summary.elapsedSec = (Date.now() - started) / 1000;
  const errSuffix = summary.errors.length ? `  ${summary.errors.length} error(s)` : "";
  log.info(
    `[sync] done in ${summary.elapsedSec.toFixed(1)}s — pushed +${summary.pushedCreates} ` +
      `~${summary.pushedUpdates} -${summary.pushedDeletes}${errSuffix}`,
  );
  return summary;
}

/** Re-push every event with a recorded push_error, using cached data only. */
export async function runFixErrors(cfg: Config, opts: { dryRun?: boolean } = {}): Promise<SyncSummary> {
  return runFixErrorsWith(cfg, opts, defaultDeps);
}

export async function runFixErrorsWith(
  cfg: Config,
  opts: { dryRun?: boolean },
  deps: SyncDeps,
): Promise<SyncSummary> {
  const summary = makeSummary();
  const started = Date.now();

  let failures: Array<{ event: Event; error: string }>;
  {
    const store = deps.openStore(cfg);
    try {
      failures = store.iterFailed();
    } finally {
      store.close();
    }
  }

  if (failures.length === 0) {
    log.info("[fix] no recorded push failures — nothing to do");
    summary.elapsedSec = (Date.now() - started) / 1000;
    return summary;
  }
  log.info(`[fix] ${failures.length} event(s) with recorded push failures:`);
  for (const { event } of failures) {
    log.info(`[fix]   ${event.startIso.slice(0, 16)}  ${event.subject}`);
  }

  if (opts.dryRun) {
    log.info("[fix] DRY RUN — no writes");
    summary.elapsedSec = (Date.now() - started) / 1000;
    return summary;
  }

  let backend: Backend;
  try {
    backend = await deps.openBackend(cfg);
  } catch (err) {
    if (err instanceof BackendConfigError) {
      record(summary, started, err.message);
      return summary;
    }
    throw err;
  }

  const store = deps.openStore(cfg);
  try {
    store.begin();
    try {
      for (const { event } of failures) {
        try {
          const result = await backend.upsert(event);
          store.upsert(event);
          store.markPushed(event.itemId, {
            remoteId: result.remoteId,
            remoteEtag: result.remoteEtag,
            backend: cfg.backend,
          });
          summary.pushedCreates++;
          log.info(`[fix] pushed  ${event.startIso.slice(0, 16)}  ${event.subject}`);
        } catch (err) {
          const msg = `${event.subject}: ${describeError(err)}`;
          summary.errors.push(msg);
          log.error(`[fix] failed ${event.startIso.slice(0, 16)}  ${msg}`);
          store.markFailed(event.itemId, describeError(err));
        }
      }
      store.commit();
    } catch (err) {
      store.rollback();
      throw err;
    }
  } finally {
    await backend.close();
    store.close();
  }

  summary.elapsedSec = (Date.now() - started) / 1000;
  return summary;
}

// ---------- internals ----------

// How many creates to ship per upsertMany() call when the backend
// supports bulk inserts. Etebase's batch endpoint timed out (504) on
// very large batches in practice; 50 has proven reliable.
const CREATE_BATCH_SIZE = 50;

async function executePlan(
  diff: Diff,
  store: Store,
  backend: Backend,
  summary: SyncSummary,
): Promise<void> {
  const backendName = currentBackendName(store);
  const totalCreates = diff.creates.length;

  // Bulk path: the backend advertised upsertMany() (Etebase), so we
  // chunk creates and ship each chunk in one round trip. On batch
  // failure every event in the chunk is marked failed; fix-errors
  // will retry them one at a time via the single-event upsert path.
  if (backend.upsertMany && totalCreates > 1) {
    let pushed = 0;
    for (let i = 0; i < totalCreates; i += CREATE_BATCH_SIZE) {
      const chunk = diff.creates.slice(i, i + CREATE_BATCH_SIZE);
      try {
        const results = await backend.upsertMany(chunk);
        for (let j = 0; j < chunk.length; j++) {
          const event = chunk[j]!;
          const result = results[j]!;
          store.upsert(event);
          store.markPushed(event.itemId, {
            remoteId: result.remoteId,
            remoteEtag: result.remoteEtag,
            backend: backendName ?? "",
          });
          summary.pushedCreates++;
        }
      } catch (err) {
        const desc = describeError(err);
        log.error(`[sync] batch create failed (${chunk.length} items): ${desc}`);
        for (const event of chunk) {
          summary.errors.push(`create ${event.subject}: ${desc}`);
          store.upsert(event);
          store.markFailed(event.itemId, desc);
        }
      }
      pushed += chunk.length;
      log.info(`[sync] pushed ${pushed}/${totalCreates} creates`);
    }
  } else {
    // Single-event fallback (CalDAV, or a one-event run).
    let pushed = 0;
    for (const event of diff.creates) {
      try {
        const result = await backend.upsert(event);
        store.upsert(event);
        store.markPushed(event.itemId, {
          remoteId: result.remoteId,
          remoteEtag: result.remoteEtag,
          backend: backendName ?? "",
        });
        summary.pushedCreates++;
      } catch (err) {
        const msg = `create ${event.subject}: ${describeError(err)}`;
        summary.errors.push(msg);
        log.error(`[sync] ${msg}`);
        store.upsert(event);
        store.markFailed(event.itemId, describeError(err));
      }
      pushed++;
      if (pushed % 50 === 0 || pushed === totalCreates) {
        log.info(`[sync] pushed ${pushed}/${totalCreates} creates`);
      }
    }
  }

  for (const { event, row } of diff.updates) {
    try {
      const upsertOpts = row.remoteId ? { existingId: row.remoteId } : {};
      const result = await backend.upsert(event, upsertOpts);
      store.upsert(event);
      store.markPushed(event.itemId, {
        remoteId: result.remoteId,
        remoteEtag: result.remoteEtag,
        backend: backendName ?? "",
      });
      summary.pushedUpdates++;
    } catch (err) {
      const msg = `update ${event.subject}: ${describeError(err)}`;
      summary.errors.push(msg);
      log.error(`[sync] ${msg}`);
      store.upsert(event);
      store.markFailed(event.itemId, describeError(err));
    }
  }

  for (const row of diff.deletes) {
    try {
      if (row.remoteId) await backend.delete(row.remoteId);
      store.delete(row.itemId);
      summary.pushedDeletes++;
    } catch (err) {
      const msg = `delete ${row.subject}: ${describeError(err)}`;
      summary.errors.push(msg);
      log.error(`[sync] ${msg}`);
    }
  }

  for (const itemId of diff.unchanged) {
    store.touchSeen(itemId);
  }
}

function printDryRunPlan(diff: Diff): void {
  const limit = 30;
  if (diff.creates.length) {
    process.stdout.write("[sync] would create:\n");
    for (const event of diff.creates.slice(0, limit)) {
      const loc = event.location ? `  @ ${event.location}` : "";
      process.stdout.write(`  + ${event.startIso.slice(0, 16)}  ${event.subject}${loc}\n`);
    }
    if (diff.creates.length > limit) {
      process.stdout.write(`  … and ${diff.creates.length - limit} more\n`);
    }
  }
  if (diff.updates.length) {
    process.stdout.write("[sync] would update:\n");
    for (const { event } of diff.updates.slice(0, limit)) {
      process.stdout.write(`  ~ ${event.startIso.slice(0, 16)}  ${event.subject}\n`);
    }
    if (diff.updates.length > limit) {
      process.stdout.write(`  … and ${diff.updates.length - limit} more\n`);
    }
  }
  if (diff.deletes.length) {
    process.stdout.write("[sync] would delete:\n");
    for (const row of diff.deletes.slice(0, limit)) {
      process.stdout.write(`  - ${row.startIso.slice(0, 16)}  ${row.subject}\n`);
    }
    if (diff.deletes.length > limit) {
      process.stdout.write(`  … and ${diff.deletes.length - limit} more\n`);
    }
  }
  if (!(diff.creates.length || diff.updates.length || diff.deletes.length)) {
    process.stdout.write("[sync] nothing to do\n");
  }
  process.stdout.write("[sync] DRY RUN — no backend writes performed\n");
}

function currentBackendName(store: Store): string | null {
  // Most recent stored backend name wins. Falls back to null when no
  // rows have ever been pushed (first sync); callers default to "".
  const rows: StoredRow[] = store.iterRows();
  for (const row of rows) if (row.backend) return row.backend;
  return null;
}

function copyDiffCounts(diff: Diff, summary: SyncSummary): void {
  summary.creates = diff.creates.length;
  summary.updates = diff.updates.length;
  summary.deletes = diff.deletes.length;
  summary.unchanged = diff.unchanged.length;
  summary.frozenPast = diff.frozenPast;
  summary.outOfWindow = diff.outOfWindow;
}

function makeSummary(): SyncSummary {
  return {
    fetched: 0,
    creates: 0,
    updates: 0,
    deletes: 0,
    unchanged: 0,
    frozenPast: 0,
    outOfWindow: 0,
    pushedCreates: 0,
    pushedUpdates: 0,
    pushedDeletes: 0,
    errors: [],
    elapsedSec: 0,
  };
}

function record(summary: SyncSummary, started: number, msg: string): void {
  summary.errors.push(msg);
  log.error(`[sync] ${msg}`);
  summary.elapsedSec = (Date.now() - started) / 1000;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function startOfUtcDay(dt: Date): Date {
  const d = new Date(dt.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dateOnly(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}
