// Clear every item from the configured Etebase collection.
//
// Useful when starting fresh — e.g. after a tool migration where the
// remote already holds items under different UIDs that would
// otherwise duplicate on the next sync. Always dry-run by default;
// `--force` is required to actually delete.

import { promises as fsp } from "node:fs";

import { Account, OutputFormat, ready as etebaseReady } from "etebase";

import type { Config } from "./config.js";
import { BackendConfigError } from "./sync/backend.js";

export interface WipeOptions {
  force?: boolean;
}

export async function runEtebaseWipe(
  cfg: Config,
  opts: WipeOptions = {},
): Promise<number> {
  if (!cfg.etebaseCollectionUid) {
    throw new BackendConfigError(
      "etebase.collection_uid is unset. Run `ete-look-sync login-etebase` first.",
    );
  }
  let blob: string;
  try {
    blob = await fsp.readFile(cfg.etebaseBlobFile, "utf8");
  } catch (err) {
    throw new BackendConfigError(
      `No saved Etebase account at ${cfg.etebaseBlobFile}: ${describeError(err)}. ` +
        "Run `ete-look-sync login-etebase` first.",
    );
  }

  await etebaseReady;
  const account = await Account.restore(blob.trim());
  const colManager = account.getCollectionManager();
  const collection = await colManager.fetch(cfg.etebaseCollectionUid);
  const meta = collection.getMeta() as { name?: string };
  const itemManager = colManager.getItemManager(collection);

  // The first list call gives us up to `limit` items (SDK default
  // 50). Page through with stoken until done.
  const all = [];
  let stoken: string | undefined;
  for (;;) {
    const page = await itemManager.list(
      stoken ? { stoken, limit: 200 } : { limit: 200 },
    );
    all.push(...page.data);
    if (page.done) break;
    stoken = page.stoken;
  }
  const live = all.filter((item) => !item.isDeleted);

  process.stdout.write(
    `[wipe] collection "${meta.name ?? "(unnamed)"}" (uid=${cfg.etebaseCollectionUid})\n` +
      `[wipe] ${live.length} live item(s); ${all.length - live.length} already-deleted tombstone(s)\n`,
  );

  if (live.length === 0) {
    process.stdout.write("[wipe] nothing to delete.\n");
    return 0;
  }

  // Show a sample so the user knows what they're about to nuke.
  const previewN = Math.min(5, live.length);
  process.stdout.write(`[wipe] first ${previewN} item meta name(s):\n`);
  for (let i = 0; i < previewN; i++) {
    const m = live[i]!.getMeta() as { name?: string };
    process.stdout.write(`  - ${m.name ?? "(unnamed)"}\n`);
  }
  if (live.length > previewN) {
    process.stdout.write(`  … and ${live.length - previewN} more\n`);
  }

  if (!opts.force) {
    process.stdout.write(
      "\n[wipe] dry-run only. Re-run with --force to actually delete every item.\n",
    );
    return 0;
  }

  // Etebase's batch endpoint times out (504) on very large batches —
  // ~3000+ items in one call is too much. Chunk into pages so even
  // a multi-thousand-item collection clears reliably.
  const CHUNK = 50;
  for (const item of live) item.delete();
  let processed = 0;
  for (let i = 0; i < live.length; i += CHUNK) {
    const slice = live.slice(i, i + CHUNK);
    await itemManager.batch(slice);
    processed += slice.length;
    process.stdout.write(
      `[wipe] deleted ${processed}/${live.length}\n`,
    );
  }
  process.stdout.write(`[wipe] done. deleted ${live.length} item(s).\n`);
  return 0;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Silences an unused-import lint in environments that don't tree-shake.
void OutputFormat;
