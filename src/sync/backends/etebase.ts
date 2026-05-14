// Etebase implementation of the Backend interface.
//
// Wraps the `etebase` npm SDK so the orchestrator only ever deals in
// Event objects and opaque (remoteId, remoteEtag) tuples. The remote
// identifiers are the Etebase item's `uid` and `etag` — uid is stable
// for the lifetime of the item, etag changes on every revision.
//
// Login lives in the CLI's `login etebase` subcommand (phase 11): it
// writes the saved Account blob to `cfg.etebaseBlobFile` and the
// resolved collection UID into config. This module assumes both
// already exist and restores them on open.

import { promises as fsp } from "node:fs";

import {
  Account,
  type Collection,
  type ItemManager,
  ready as etebaseReady,
} from "etebase";

import type { Config } from "../../config.js";
import { getLogger } from "../../log.js";
import type { Event } from "../../models.js";
import { renderEvent } from "../ics.js";
import {
  type Backend,
  BackendConfigError,
  type PushResult,
  type UpsertOptions,
} from "../backend.js";

const log = getLogger("backends/etebase");

/** What our wrapper needs to know about an Etebase item. */
export interface EtebaseItemSnapshot {
  uid: string;
  etag: string;
}

/**
 * Minimal slice of Etebase operations the backend depends on.
 * Production binds these to the SDK's ItemManager; tests provide a fake.
 */
export interface EtebaseOps {
  /** Returns the item if it exists, or null when not found / GC'd. */
  fetchItem(uid: string): Promise<EtebaseItemSnapshot | null>;
  /** Create a new item; returns its uid + initial etag. */
  createItem(args: {
    content: string;
    meta: { name: string; mtime: number; type: string };
  }): Promise<EtebaseItemSnapshot>;
  /** Update content on an existing item; returns new etag (uid is stable). */
  updateItem(args: {
    uid: string;
    etag: string;
    content: string;
  }): Promise<EtebaseItemSnapshot>;
  /** Mark the item as deleted and upload that revision. */
  deleteItem(args: { uid: string; etag: string }): Promise<void>;
}

export class EtebaseBackend implements Backend {
  constructor(
    private readonly ops: EtebaseOps,
    private readonly account: { logout?: () => Promise<void> } | null = null,
  ) {}

  /** Build an SDK-backed EtebaseBackend from a Config. */
  static async open(cfg: Config): Promise<EtebaseBackend> {
    if (!cfg.etebaseCollectionUid) {
      throw new BackendConfigError(
        "etebase.collection_uid is unset. Run `ete-look-sync login-etebase` " +
          "to pick a collection first.",
      );
    }
    let blob: string;
    try {
      blob = await fsp.readFile(cfg.etebaseBlobFile, "utf8");
    } catch (err) {
      throw new BackendConfigError(
        `No saved Etebase account at ${cfg.etebaseBlobFile} ` +
          `(${describeError(err)}). Run \`ete-look-sync login-etebase\` first.`,
      );
    }

    await etebaseReady;
    const account = await Account.restore(blob.trim());
    const colManager = account.getCollectionManager();
    let collection: Collection;
    try {
      collection = await colManager.fetch(cfg.etebaseCollectionUid);
    } catch (err) {
      throw new BackendConfigError(
        `Failed to open Etebase collection ${cfg.etebaseCollectionUid}: ${describeError(err)}`,
      );
    }
    const itemManager = colManager.getItemManager(collection);
    return new EtebaseBackend(makeSdkOps(itemManager), account);
  }

  async upsert(event: Event, opts: UpsertOptions = {}): Promise<PushResult> {
    const ics = renderEvent(event);

    if (opts.existingId) {
      const existing = await this.ops.fetchItem(opts.existingId);
      if (existing) {
        const updated = await this.ops.updateItem({
          uid: existing.uid,
          etag: existing.etag,
          content: ics,
        });
        return { remoteId: updated.uid, remoteEtag: updated.etag };
      }
      // Item was deleted server-side; fall through to recreate so
      // we end up with a fresh resource.
      log.debug(`[etebase] existingId ${opts.existingId} not found; recreating`);
    }

    const created = await this.ops.createItem({
      content: ics,
      meta: {
        name: event.subject || "(no subject)",
        mtime: Date.now(),
        type: "VEVENT",
      },
    });
    return { remoteId: created.uid, remoteEtag: created.etag };
  }

  async delete(remoteId: string): Promise<void> {
    let existing: EtebaseItemSnapshot | null;
    try {
      existing = await this.ops.fetchItem(remoteId);
    } catch (err) {
      // 404 paths through the SDK throw; treat as already gone.
      log.debug(`[etebase] fetch on ${remoteId} threw ${describeError(err)}; ignoring`);
      return;
    }
    if (!existing) return;
    try {
      await this.ops.deleteItem({ uid: existing.uid, etag: existing.etag });
    } catch (err) {
      log.debug(`[etebase] delete on ${remoteId} threw ${describeError(err)}; ignoring`);
    }
  }

  async close(): Promise<void> {
    // Best-effort logout: invalidates the auth token server-side. If
    // we're offline (or the saved account already expired) this is a
    // no-op, but we shouldn't raise out of close.
    if (this.account?.logout) {
      try {
        await this.account.logout();
      } catch {
        // intentionally swallowed
      }
    }
  }
}

// ---------- SDK binding ----------

function makeSdkOps(itemManager: ItemManager): EtebaseOps {
  return {
    async fetchItem(uid) {
      try {
        const item = await itemManager.fetch(uid);
        if (item.isDeleted) return null;
        return { uid: item.uid, etag: item.etag };
      } catch (err) {
        // 404 manifests as a thrown HttpError; treat all SDK fetch
        // failures as "not found" for the diff's purposes.
        log.debug(`[etebase] fetchItem(${uid}) failed: ${describeError(err)}`);
        return null;
      }
    },
    async createItem({ content, meta }) {
      const item = await itemManager.create(meta, content);
      await itemManager.batch([item]);
      return { uid: item.uid, etag: item.etag };
    },
    async updateItem({ uid, content }) {
      // `etag` is implicit in the fetched item — we re-fetch to get the
      // current revision the SDK expects to match for optimistic
      // concurrency, then upload. Cheaper than threading the cached
      // EncryptedCollectionItem through the wrapper boundary.
      const item = await itemManager.fetch(uid);
      await item.setContent(content);
      await itemManager.batch([item]);
      return { uid: item.uid, etag: item.etag };
    },
    async deleteItem({ uid }) {
      const item = await itemManager.fetch(uid);
      item.delete();
      await itemManager.batch([item]);
    },
  };
}

// ---------- internals ----------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
