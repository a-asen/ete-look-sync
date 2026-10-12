// Source-of-truth mirror: plan deletion of remote items that no longer
// correspond to a fetched Outlook event.
//
// The store-driven differ (differ.ts) only knows items the tool itself
// pushed. When `mirror_foreign` is enabled the remote collection is
// instead reconciled by CONTENT against the Outlook source: anything
// in the managed window that the source no longer contains is deleted,
// whoever created it (the retired Python tool, a manual entry, an old
// duplicate). The window IS the freeze — past events within `days_back`
// are eligible too.
//
// Matching is by content signature (name + start + end), computed
// identically from a fresh `Event` and from a remote item's ICS. An
// item is a deletion candidate when it is:
//   - not claimed (no live stored row / adoption points at it),
//   - not already scheduled for deletion by the differ,
//   - inside the managed window,
//   - and either has no source counterpart at all, or duplicates a
//     signature that a claimed item already covers.
// A lone unclaimed item whose signature DOES match a source event is
// kept: it is the only representation of a live event (e.g. a stale
// mapping), so deleting it would lose the event.

import { icsSignature } from "./signature.js";

export interface RemoteForPrune {
  remoteId: string;
  content: string;
}

export interface ForeignDelete {
  remoteId: string;
  subject: string;
  /** "YYYYMMDD" start date, for logging. */
  startDate: string;
}

export interface PruneInput {
  remoteItems: readonly RemoteForPrune[];
  /** remoteIds that represent a live fetched event (store mappings + adoptions). */
  claimedRemoteIds: ReadonlySet<string>;
  /** remoteIds the store-driven differ already plans to delete. */
  alreadyDeleting: ReadonlySet<string>;
  /** Signatures of every fetched source event. */
  sourceSignatures: ReadonlySet<string>;
  /** Window bounds as "YYYYMMDD" (inclusive). */
  windowStart: string;
  windowEnd: string;
}

/** Pure: decide which remote items to delete. No I/O. */
export function planForeignDeletes(input: PruneInput): ForeignDelete[] {
  const signatureOf = new Map<string, string>();
  for (const item of input.remoteItems) {
    const sig = icsSignature(item.content).signature;
    if (sig) signatureOf.set(item.remoteId, sig);
  }
  const claimedSignatures = new Set<string>();
  for (const id of input.claimedRemoteIds) {
    const sig = signatureOf.get(id);
    if (sig !== undefined) claimedSignatures.add(sig);
  }

  const out: ForeignDelete[] = [];
  for (const item of input.remoteItems) {
    if (input.claimedRemoteIds.has(item.remoteId)) continue;
    if (input.alreadyDeleting.has(item.remoteId)) continue;

    const info = icsSignature(item.content);
    if (!info.signature || !info.startDate) continue; // unparseable → leave alone
    if (info.startDate < input.windowStart || info.startDate > input.windowEnd) continue;

    // Keep a lone unclaimed item that is the only representation of a
    // live source event (guards against a lost/again-stale mapping).
    if (input.sourceSignatures.has(info.signature) && !claimedSignatures.has(info.signature)) {
      continue;
    }

    out.push({
      remoteId: item.remoteId,
      subject: info.summary ?? "(no subject)",
      startDate: info.startDate,
    });
  }
  return out;
}
