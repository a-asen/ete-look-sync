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
    const password = await askPasswordSilently(rl, "Etebase password: ");
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

    process.stdout.write("\nCollections:\n");
    collections.forEach((col, i) => {
      const meta = col.getMeta() as { name?: string; description?: string };
      const desc = meta.description ? `  — ${meta.description}` : "";
      process.stdout.write(`  [${i}] ${meta.name ?? "(unnamed)"}${desc}\n`);
    });
    const choice = (await rl.question(`Pick one [0-${collections.length - 1}]: `)).trim();
    const idx = Number(choice);
    if (!Number.isInteger(idx) || idx < 0 || idx >= collections.length) {
      process.stderr.write(`[login-etebase] invalid choice: ${choice}\n`);
      return 1;
    }
    const collection = collections[idx]!;
    const collectionUid = collection.uid;

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
async function askPasswordSilently(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  process.stdout.write(prompt);
  const stdout = process.stdout as NodeJS.WriteStream & { _write?: Function };
  const originalWrite = stdout.write.bind(stdout);
  // Suppress echoing of typed characters by intercepting write calls
  // until the prompt resolves.
  stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.length === 1) return true;
    return originalWrite(chunk as never, ...(rest as never[]));
  }) as typeof stdout.write;
  try {
    const answer = await rl.question("");
    return answer;
  } finally {
    stdout.write = originalWrite as typeof stdout.write;
    process.stdout.write("\n");
  }
}
