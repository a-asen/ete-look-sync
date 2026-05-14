#!/usr/bin/env node
// ete-look-sync command-line entry point.
//
// Binary name is the portmanteau "ete-look-sync"; state still lives
// under ~/.local/state/outlook-sync/ (and env vars stay OUTLOOK_SYNC_*)
// so the Python predecessor and migrate-legacy can keep reading the
// same files during cutover.
//
// Subcommands:
//   login            Playwright-driven browser login that captures cookies + bearer
//   login-etebase    Interactive Etebase server login + collection picker
//   probe            Verify the saved session by reading 7 days of events
//   sync-once        One fetch + diff + push cycle against the configured backend
//   fix-errors       Re-push events that failed previously, from local data
//   export-ics       Dump all stored events to a single .ics backup file
//   diagnose         (not ported) Record raw API traffic for debugging
//   setup-timer      Install a systemd user timer for unattended periodic sync
//   remove-timer     Uninstall the systemd timer
//
// Top-level --debug enables verbose logging across all subcommands.

import { Command } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { capture } from "./auth/capture.js";
import { loadConfig } from "./config.js";
import { runEtebaseLogin } from "./etebase_login.js";
import { setupLogging } from "./log.js";
import { migrateLegacy } from "./migrate.js";
import { runProbe } from "./probe.js";
import { Store } from "./store.js";
import { renderAllEvents } from "./sync/ics.js";
import { runFixErrors, runSyncOnce } from "./sync/orchestrator.js";
import { runRemoveTimer, runSetupTimer } from "./timer.js";

async function main(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("ete-look-sync")
    .description("Headless mirror of an Outlook calendar to a personal EteSync calendar.")
    .option("--debug", "Enable debug logging (API requests, pagination, batch details).")
    .hook("preAction", (thisCommand) => {
      setupLogging({ debug: Boolean(thisCommand.opts()["debug"]) });
    });

  program
    .command("login")
    .description("Open a browser to sign in to Microsoft and save the OWA session.")
    .action(async () => {
      await capture(loadConfig());
      process.exit(0);
    });

  program
    .command("login-etebase")
    .description("Sign in to Etebase, pick a collection, and write the saved blob to disk.")
    .action(async () => {
      const code = await runEtebaseLogin(loadConfig());
      process.exit(code);
    });

  program
    .command("probe")
    .description("Hit service.svc with the saved session to verify auth + fetch.")
    .action(async () => {
      const code = await runProbe();
      process.exit(code);
    });

  program
    .command("sync-once")
    .description("One fetch + diff cycle. Without --dry-run, pushes to the configured backend.")
    .option("--dry-run", "Compute and print the diff without touching the backend.")
    .option("--days-back <n>", "Days of past events to include.", asInt)
    .option("--days-forward <n>", "Days of future events to include.", asInt)
    .option("--allow-empty-fetch", "Skip the safety check that aborts when Exchange returns 0 events but deletions are pending.")
    .option("--no-freeze-past", "Push historical events too (disables the today−N cutoff). Use once for initial backfill.")
    .action(async (opts: SyncOnceFlags) => {
      const syncOpts: Parameters<typeof runSyncOnce>[1] = {
        // commander's --no-X flag yields freezePast=false on the
        // opts object; invert here so noFreezePast=true means
        // "disable the cutoff."
        noFreezePast: opts.freezePast === false,
      };
      if (opts.dryRun) syncOpts.dryRun = true;
      if (opts.daysBack !== undefined) syncOpts.daysBack = opts.daysBack;
      if (opts.daysForward !== undefined) syncOpts.daysForward = opts.daysForward;
      if (opts.allowEmptyFetch) syncOpts.allowEmptyFetch = true;

      const summary = await runSyncOnce(loadConfig(), syncOpts);
      process.exit(summary.errors.length > 0 ? 1 : 0);
    });

  program
    .command("fix-errors")
    .description("Re-push events that failed during a previous sync (no Exchange fetch needed).")
    .option("--dry-run", "List failed events without retrying.")
    .action(async (opts: { dryRun?: boolean }) => {
      const summary = await runFixErrors(loadConfig(), opts.dryRun ? { dryRun: true } : {});
      process.exit(summary.errors.length > 0 ? 1 : 0);
    });

  program
    .command("export-ics")
    .description("Export all locally stored events to a single .ics backup file.")
    .argument("<path>", "Path to write the .ics file (e.g. ~/cloud/outlook-backup.ics).")
    .action((outputPath: string) => {
      const cfg = loadConfig();
      const store = new Store(cfg.dbFile);
      try {
        const events = store.iterEvents();
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, renderAllEvents(events));
        process.stdout.write(`[export] ${events.length} events → ${outputPath}\n`);
      } finally {
        store.close();
      }
    });

  program
    .command("diagnose")
    .description("(not yet ported) Record raw OWA traffic for debugging.")
    .action(() => {
      process.stderr.write(
        "[diagnose] not yet ported from the Python tool. " +
          "Use the Python tool's `outlook-sync diagnose` for now.\n",
      );
      process.exit(2);
    });

  program
    .command("setup-timer")
    .description("Install a systemd user timer that runs sync-once automatically.")
    .option("--dry-run", "Print the unit files that would be written without installing them.")
    .action(async (opts: { dryRun?: boolean }) => {
      const code = await runSetupTimer(
        loadConfig(),
        opts.dryRun ? { dryRun: true } : {},
      );
      process.exit(code);
    });

  program
    .command("remove-timer")
    .description("Stop, disable, and delete the installed systemd units.")
    .action(async () => {
      const code = await runRemoveTimer();
      process.exit(code);
    });

  program
    .command("migrate-legacy")
    .description("Import the Python predecessor's events.sqlite into this store.")
    .argument("<legacy-db>", "Path to the legacy events.sqlite (e.g. ~/.local/state/outlook-sync/events.sqlite).")
    .option("--force", "Merge into a non-empty target store instead of refusing.")
    .option("--skip-parity-check", "Skip the content_hash sanity check (use only if you know why).")
    .action((legacyDb: string, opts: { force?: boolean; skipParityCheck?: boolean }) => {
      const migrateOpts: Parameters<typeof migrateLegacy>[2] = {};
      if (opts.force) migrateOpts.force = true;
      if (opts.skipParityCheck) migrateOpts.skipParityCheck = true;
      const result = migrateLegacy(legacyDb, loadConfig(), migrateOpts);
      process.stdout.write(
        `[migrate] imported ${result.imported} row(s), ${result.hashMismatches} hash mismatch(es), ` +
          `${result.recordJsonErrors} record_json error(s)\n`,
      );
      process.exit(result.hashMismatches > 0 ? 1 : 0);
    });

  await program.parseAsync(argv);
  return 0;
}

interface SyncOnceFlags {
  dryRun?: boolean;
  daysBack?: number;
  daysForward?: number;
  allowEmptyFetch?: boolean;
  /** commander encodes --no-freeze-past as freezePast=false on the opts object. */
  freezePast?: boolean;
}

function asInt(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`expected an integer, got ${JSON.stringify(raw)}`);
  }
  return Math.trunc(n);
}

main(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[cli] fatal: ${msg}\n`);
  process.exit(1);
});
