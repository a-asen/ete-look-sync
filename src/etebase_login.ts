// Interactive `ete-look-sync login-etebase` flow.
//
// Prompts for server URL / username / password, calls Account.login,
// lists collections, asks the user to pick one, then writes:
//
//   - the saved Account blob to cfg.etebaseBlobFile (mode 600)
//   - the chosen collection UID to stdout, with a single-line hint
//     about adding it to ~/.config/ete-look-sync/config.toml
//
// The blob is the only place encryption keys are persisted; chmod 600
// keeps it readable by the user only. Persisting the collection UID
// itself doesn't reveal anything beyond a calendar identifier — it
// goes in plain config so users can edit it freely.

import { promises as fsp } from "node:fs";
import * as readline from "node:readline/promises";

import { Account, ready as etebaseReady } from "etebase";

import type { Config } from "./config.js";

export async function runEtebaseLogin(cfg: Config): Promise<number> {
  await etebaseReady;

  process.stdout.write(
    "──────────────────────────────────────────────────────────────\n" +
      "  ete-look-sync — Etebase login\n" +
      "\n" +
      "  This sets the destination calendar for Outlook events.\n" +
      "  After sign-in you'll pick one of your etebase.vevent\n" +
      "  collections; every event fetched from Outlook will be\n" +
      "  pushed there on every sync.\n" +
      "\n" +
      "  Use a calendar dedicated to this (e.g. one named\n" +
      "  \"…UiT_Calendar_sync\" or similar) so the sync does not\n" +
      "  mingle with your personal/main calendar.\n" +
      "──────────────────────────────────────────────────────────────\n\n",
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const defaultServer = cfg.etebaseServerUrl || "https://api.etebase.com";
    const serverUrl = (await rl.question(`Etebase server URL [${defaultServer}]: `)).trim() || defaultServer;
    const defaultUser = cfg.etebaseUsername || "";
    const userPrompt = defaultUser ? `Etebase username [${defaultUser}]: ` : "Etebase username: ";
    const username = (await rl.question(userPrompt)).trim() || defaultUser;
    if (!username) {
      process.stderr.write("[login-etebase] username required\n");
      return 1;
    }
    const password = await askPasswordSilently(rl, "Etebase password (input hidden, press Enter when done): ");
    if (!password) {
      process.stderr.write("[login-etebase] password required\n");
      return 1;
    }

    process.stdout.write(`[login-etebase] signing in as ${username}…\n`);
    const account = await Account.login(username, password, serverUrl);
    process.stdout.write("[login-etebase] signed in\n");

    const colManager = account.getCollectionManager();
    const { data: collections } = await colManager.list("etebase.vevent");
    if (collections.length === 0) {
      process.stderr.write(
        "[login-etebase] no etebase.vevent collections on this account.\n" +
          "  Create one in your Etebase client (e.g. EteSync app) first.\n",
      );
      return 1;
    }

    process.stdout.write(
      "\n" +
        "──────────────────────────────────────────────────────────────\n" +
        "  Pick the destination calendar for Outlook events.\n" +
        "\n" +
        "  Every event fetched from Outlook will be pushed here on\n" +
        "  every sync. Most users dedicate a separate calendar to\n" +
        "  this (e.g. one named \"…UiT_Calendar_sync\" or similar)\n" +
        "  rather than mixing it into a personal/main calendar.\n" +
        "──────────────────────────────────────────────────────────────\n\n" +
        "Available etebase.vevent collections:\n",
    );
    collections.forEach((col, i) => {
      const meta = col.getMeta() as { name?: string; description?: string };
      const desc = meta.description ? `  — ${meta.description}` : "";
      process.stdout.write(`  [${i}] ${meta.name ?? "(unnamed)"}${desc}\n`);
    });
    const choice = (await rl.question(
      `\nPick the sync destination [0-${collections.length - 1}]: `,
    )).trim();
    const idx = Number(choice);
    if (!Number.isInteger(idx) || idx < 0 || idx >= collections.length) {
      process.stderr.write(`[login-etebase] invalid choice: ${choice}\n`);
      return 1;
    }
    const collection = collections[idx]!;
    const collectionUid = collection.uid;
    const chosenMeta = collection.getMeta() as { name?: string };
    const confirm = (await rl.question(
      `Confirm: push Outlook events to "${chosenMeta.name ?? "(unnamed)"}" (uid=${collectionUid})? [y/N] `,
    )).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      process.stderr.write("[login-etebase] aborted; nothing written.\n");
      return 1;
    }

    const blob = await account.save();
    await fsp.writeFile(cfg.etebaseBlobFile, blob, { mode: 0o600 });
    process.stdout.write(`\n[login-etebase] saved account blob to ${cfg.etebaseBlobFile} (mode 600)\n`);
    process.stdout.write(`[login-etebase] collection UID: ${collectionUid}\n\n`);
    process.stdout.write(
      "Add this to ~/.config/ete-look-sync/config.toml:\n\n" +
        "[etebase]\n" +
        `server_url     = "${serverUrl}"\n` +
        `username       = "${username}"\n` +
        `collection_uid = "${collectionUid}"\n`,
    );
    return 0;
  } finally {
    rl.close();
  }
}

// Read a line without echoing it. Used for password input; Node's
// readline doesn't have a built-in mode for this so we briefly mute
// stdout writes while the keystrokes come in.
//
// The prompt itself is multi-char and goes through readline's own
// prompt rendering — passing it via rl.question() keeps the visible
// label in sync with the cursor position even after readline's line
// management. We only suppress 1-char writes, which is what readline
// echoes per keystroke for ASCII input.
async function askPasswordSilently(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  const stdout = process.stdout as NodeJS.WriteStream;
  const originalWrite = stdout.write.bind(stdout);
  stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.length === 1) return true;
    return originalWrite(chunk as never, ...(rest as never[]));
  }) as typeof stdout.write;
  try {
    return await rl.question(prompt);
  } finally {
    stdout.write = originalWrite as typeof stdout.write;
    process.stdout.write("\n");
  }
}
