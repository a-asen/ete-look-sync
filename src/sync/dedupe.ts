// `ete-look-sync dedupe` — remove duplicate copies of synced events from
// the remote collection. Dry-run by default; --force actually deletes.
//
// Strictly scoped to items this tool created (UID ends @ete-look-sync).
// Real source events — anything without that suffix — are NEVER deleted,
// only counted. For each content signature (name + duration):
//
//   - if a real (non-tool) item exists, every tool copy is redundant and
//     queued for deletion (the real one already represents the event);
//   - otherwise the first tool item is kept and the rest are deleted.
//
// After deletion the local store is repointed off any removed remote ids
// onto the surviving item, so a later edit updates in place rather than
// recreating a duplicate.

import type { Config } from "../config.js";
import { getLogger } from "../log.js";
import { Store } from "../store.js";
import { openBackend, type RemoteItem } from "./backend.js";
import { icsSignature } from "./signature.js";

const log = getLogger("dedupe");

export interface DedupePlan {
  totalItems: number;
  toolItems: number;
  realItems: number;
  /** Items whose ICS had no parseable signature — left untouched. */
  unparseable: number;
  /** Signatures appearing on more than one item. */
  duplicateSignatures: number;
  deletes: Array<{ remoteId: string; signature: string; reason: "shadows-real" | "duplicate-tool" }>;
  /** signature → remoteId of the item kept for that signature. */
  survivors: Map<string, string>;
}

/** Decide which tool items to delete. Pure — no I/O. */
export function planDedupe(items: ReadonlyArray<RemoteItem>): DedupePlan {
  const groups = new Map<string, { tool: RemoteItem[]; real: RemoteItem[] }>();
  let toolItems = 0;
  let realItems = 0;
  let unparseable = 0;

  for (const item of items) {
    const { signature, isToolItem } = icsSignature(item.content);
    if (!signature) {
      unparseable++;
      continue;
    }
    if (isToolItem) toolItems++;
    else realItems++;
    const g = groups.get(signature) ?? { tool: [], real: [] };
    (isToolItem ? g.tool : g.real).push(item);
    groups.set(signature, g);
  }

  const deletes: DedupePlan["deletes"] = [];
  const survivors = new Map<string, string>();
  let duplicateSignatures = 0;

  for (const [signature, g] of groups) {
    if (g.tool.length + g.real.length > 1) duplicateSignatures++;

    if (g.real.length >= 1) {
      // A real event already represents this signature — keep it, drop
      // every tool copy.
      survivors.set(signature, g.real[0]!.remoteId);
      for (const item of g.tool) {
        deletes.push({ remoteId: item.remoteId, signature, reason: "shadows-real" });
      }
    } else {
      // Tool items only — keep the first, delete the rest.
      survivors.set(signature, g.tool[0]!.remoteId);
      for (const item of g.tool.slice(1)) {
        deletes.push({ remoteId: item.remoteId, signature, reason: "duplicate-tool" });
      }
    }
  }

  return {
    totalItems: items.length,
    toolItems,
    realItems,
    unparseable,
    duplicateSignatures,
    deletes,
    survivors,
  };
}

/** Run the dedupe. Returns a process exit code. */
export async function runDedupe(cfg: Config, opts: { force?: boolean } = {}): Promise<number> {
  const backend = await openBackend(cfg);
  try {
    if (!backend.listItems) {
      process.stderr.write("[dedupe] the configured backend can't list items; nothing to do.\n");
      return 2;
    }
    log.info("[dedupe] listing remote items…");
    const items = await backend.listItems();
    const plan = planDedupe(items);

    process.stdout.write(
      `[dedupe] ${plan.totalItems} items (${plan.toolItems} ete-look-sync, ` +
        `${plan.realItems} other, ${plan.unparseable} unparseable)\n` +
        `[dedupe] ${plan.duplicateSignatures} signature(s) with duplicates; ` +
        `${plan.deletes.length} tool item(s) to delete\n`,
    );
    const shadows = plan.deletes.filter((d) => d.reason === "shadows-real").length;
    if (shadows > 0) {
      process.stdout.write(`[dedupe]   ${shadows} duplicate a real source event; ${plan.deletes.length - shadows} are tool-vs-tool\n`);
    }
    for (const d of plan.deletes.slice(0, 15)) {
      process.stdout.write(`  - ${d.signature}  [${d.reason}]\n`);
    }
    if (plan.deletes.length > 15) process.stdout.write(`  … and ${plan.deletes.length - 15} more\n`);

    if (plan.deletes.length === 0) {
      process.stdout.write("[dedupe] no duplicates — nothing to do.\n");
      return 0;
    }
    if (!opts.force) {
      process.stdout.write("\n[dedupe] dry-run only. Re-run with --force to delete the duplicates above.\n");
      return 0;
    }

    // Map each soon-to-be-deleted remote id to its surviving sibling so
    // the local store can be repointed after deletion.
    const oldToSurvivor = new Map<string, string>();
    for (const d of plan.deletes) {
      const survivor = plan.survivors.get(d.signature);
      if (survivor) oldToSurvivor.set(d.remoteId, survivor);
    }

    let deleted = 0;
    let failed = 0;
    const deletedIds: string[] = [];
    for (const d of plan.deletes) {
      try {
        await backend.delete(d.remoteId);
        deletedIds.push(d.remoteId);
        deleted++;
        if (deleted % 50 === 0) log.info(`[dedupe] deleted ${deleted}/${plan.deletes.length}`);
      } catch (err) {
        failed++;
        log.error(`[dedupe] delete failed for ${d.remoteId}: ${describeError(err)}`);
      }
    }

    // Heal the local store: point any row that referenced a deleted item
    // at the survivor for its signature.
    const store = new Store(cfg.dbFile);
    let repointed = 0;
    try {
      store.begin();
      for (const oldId of deletedIds) {
        const survivor = oldToSurvivor.get(oldId);
        if (survivor) repointed += store.repointRemoteId(oldId, survivor);
      }
      store.commit();
    } catch (err) {
      store.rollback();
      log.warn(`[dedupe] store repoint failed: ${describeError(err)}`);
    } finally {
      store.close();
    }

    process.stdout.write(
      `[dedupe] deleted ${deleted} duplicate(s)` +
        (failed ? `, ${failed} failed` : "") +
        `; repointed ${repointed} local mapping(s)\n`,
    );
    return failed > 0 ? 1 : 0;
  } finally {
    await backend.close();
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
