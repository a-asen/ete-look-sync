// Backend abstraction for pushing events to a remote calendar.
//
// Each Backend implementation owns the create/update/delete side of a
// sync. The differ is backend-agnostic: it works with opaque
// `remoteId` strings the backend returns on push, so the orchestrator
// never sees CalDAV hrefs, Etebase item UIDs, or any other
// backend-specific identifier directly.
//
// Add a new backend by writing a module that exports something
// implementing `Backend`, then wire its construction into
// `openBackend` below.

import type { Config } from "../config.js";
import type { Event } from "../models.js";

/** Push receipt: opaque to everything outside the backend. */
export interface PushResult {
  /** Backend-specific resource handle (CalDAV href, Etebase item UID, …). */
  remoteId: string;
  /** Cache key for next-run conditional updates. */
  remoteEtag: string;
}

export interface UpsertOptions {
  /**
   * `remoteId` returned by a previous successful push for this event.
   * When provided the backend should update in place; when omitted it
   * should create a fresh resource.
   */
  existingId?: string;
}

/**
 * One open connection to a single remote calendar.
 *
 * `close()` releases the underlying HTTP session / SDK resources.
 * Callers must invoke it in a `finally` even when the sync raises
 * mid-run.
 */
export interface Backend {
  /**
   * Create or update the remote resource for `event`.
   *
   * Returns `{ remoteId, remoteEtag }` — both opaque strings the
   * caller persists for next-run targeting.
   */
  upsert(event: Event, opts?: UpsertOptions): Promise<PushResult>;

  /**
   * Delete the remote resource identified by `remoteId`.
   *
   * Implementations should treat "already gone" as success so a retry
   * after a partial run does the right thing instead of raising.
   */
  delete(remoteId: string): Promise<void>;

  /** Release the underlying network/SDK resources. Idempotent. */
  close(): Promise<void> | void;
}

/** Raised when a backend's settings are missing or contradictory. */
export class BackendConfigError extends Error {
  override readonly name = "BackendConfigError";
}

/**
 * Construct the backend named in `cfg.backend`.
 *
 * Concrete implementations land in later phases — calls to this
 * factory during phase 8 throw a clear "not yet implemented" error
 * pointing at which phase wires up the missing piece.
 */
export async function openBackend(cfg: Config): Promise<Backend> {
  // Lazy imports keep each backend's protocol-specific dep
  // (tsdav / etebase) off the path of commands that don't push
  // (probe / login / diagnose).
  switch (cfg.backend) {
    case "etebase": {
      const { EtebaseBackend } = await import("./backends/etebase.js");
      return EtebaseBackend.open(cfg);
    }
    case "caldav": {
      const { CalDAVBackend } = await import("./backends/caldav.js");
      return CalDAVBackend.open(cfg);
    }
  }
}
