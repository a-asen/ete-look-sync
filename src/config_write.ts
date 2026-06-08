// Surgically upsert `key = "value"` pairs inside a named TOML section
// without disturbing comments, key ordering, alignment, or any other
// section. Used by `login-etebase` to persist the chosen collection
// back into the user's config.toml instead of asking them to paste it.
//
// This is a deliberately tiny, comment-preserving editor — not a full
// TOML serializer. A smol-toml parse→stringify round-trip would drop
// every comment in the user's hand-edited file, so we edit raw text.

import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** Return `text` with `values` set under `[section]`, adding the section
 * and/or any missing keys when absent. Only string values are written. */
export function upsertTomlSection(
  text: string,
  section: string,
  values: Record<string, string>,
): string {
  const header = `[${section}]`;
  const lines = text.split("\n");
  const headerIdx = lines.findIndex((l) => l.trim() === header);

  if (headerIdx === -1) {
    const block = [header, ...Object.entries(values).map(([k, v]) => `${k} = ${quote(v)}`)].join("\n");
    if (text.trim() === "") return `${block}\n`;
    return `${text.replace(/\n*$/, "")}\n\n${block}\n`;
  }

  // The section runs from just after its header to the next `[…]` header
  // (or EOF). Edits and insertions stay strictly inside that range so
  // sibling sections (e.g. a [caldav] username) are never touched.
  let sectionEnd = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }

  const pending = new Set(Object.keys(values));
  for (let i = headerIdx + 1; i < sectionEnd && pending.size > 0; i++) {
    for (const key of pending) {
      if (new RegExp(`^\\s*${escapeRe(key)}\\s*=`).test(lines[i]!)) {
        // Preserve everything left of `=` (indent + alignment); rewrite value.
        lines[i] = lines[i]!.replace(/=.*/, `= ${quote(values[key]!)}`);
        pending.delete(key);
        break;
      }
    }
  }

  if (pending.size > 0) {
    let insertAt = sectionEnd;
    while (insertAt - 1 > headerIdx && lines[insertAt - 1]!.trim() === "") insertAt--;
    lines.splice(insertAt, 0, ...[...pending].map((k) => `${k} = ${quote(values[k]!)}`));
  }

  return lines.join("\n");
}

/** Persist the etebase target into the config file, creating it (mode
 * 600) if it doesn't exist yet. */
export async function writeEtebaseConfig(
  configFile: string,
  values: { server_url: string; username: string; collection_uid: string },
): Promise<void> {
  let existing = "";
  let existed = true;
  try {
    existing = await fsp.readFile(configFile, "utf8");
  } catch {
    existed = false;
  }
  const updated = upsertTomlSection(existing, "etebase", values);
  if (!existed) await fsp.mkdir(path.dirname(configFile), { recursive: true });
  await fsp.writeFile(configFile, updated, existed ? {} : { mode: 0o600 });
}

function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
