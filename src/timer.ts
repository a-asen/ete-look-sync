// Generate and install systemd user units for unattended periodic sync.
//
// Two units are written to ~/.config/systemd/user/:
//
//   ete-look-sync.service — oneshot service that runs `ete-look-sync sync-once`
//   ete-look-sync.timer   — calendar timer that fires it every N minutes
//
// The bin path is whatever resolved `ete-look-sync` from the user's
// PATH at setup time (i.e. wherever `npm i -g .` installed the
// shim). When the timer fires, systemd re-resolves the unit's
// ExecStart against the user's PATH only if the path is unqualified
// — so we always pin the absolute path we observed at setup.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.js";
import { getLogger } from "./log.js";

const log = getLogger("timer");

const SERVICE_NAME = "ete-look-sync.service";
const TIMER_NAME = "ete-look-sync.timer";
const NOTIFY_NAME = "ete-look-sync-notify.service";

export interface TimerDeps {
  /** Resolve the absolute path to the installed CLI shim. */
  resolveBinPath: () => string | null;
  /**
   * Resolve the absolute path to the Node binary that should run
   * the CLI. We pin it in the unit instead of relying on the shim's
   * `#!/usr/bin/env node`, because systemd user services start with
   * a stripped PATH that doesn't include nvm/asdf shims — env would
   * silently pick up the system Node and a native dep (like
   * better-sqlite3) compiled against the project's Node version
   * would then refuse to load.
   */
  resolveNodePath: () => string;
  /** Where systemd user units are written. */
  systemdUserDir: () => string;
  /** Wraps `systemctl --user …` so tests can avoid touching real systemd. */
  systemctl: (args: readonly string[]) => { status: number; stderr: string };
}

const defaultDeps: TimerDeps = {
  resolveBinPath,
  resolveNodePath: () => process.execPath,
  systemdUserDir: () => path.join(os.homedir(), ".config", "systemd", "user"),
  systemctl: (args) => {
    const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
    return { status: result.status ?? 0, stderr: result.stderr ?? "" };
  },
};

/** Install (or print) the units. Returns the CLI exit code. */
export async function runSetupTimer(
  cfg: Config,
  opts: { dryRun?: boolean } = {},
  deps: TimerDeps = defaultDeps,
): Promise<number> {
  const binPath = deps.resolveBinPath();
  if (!binPath) {
    process.stderr.write(
      "[timer] could not locate the ete-look-sync executable on PATH.\n" +
        "        Install the CLI first (e.g. `npm i -g .` from the repo).\n",
    );
    return 1;
  }

  const nodePath = deps.resolveNodePath();
  const serviceContent = renderServiceUnit(binPath, nodePath);
  const timerContent = renderTimerUnit(cfg.intervalMinutes);
  const notifyContent = renderNotifyUnit();
  const dir = deps.systemdUserDir();
  const servicePath = path.join(dir, SERVICE_NAME);
  const timerPath = path.join(dir, TIMER_NAME);
  const notifyPath = path.join(dir, NOTIFY_NAME);

  if (opts.dryRun) {
    process.stdout.write(`[timer] would write ${servicePath}:\n\n${serviceContent}\n`);
    process.stdout.write(`[timer] would write ${timerPath}:\n\n${timerContent}\n`);
    process.stdout.write(`[timer] would write ${notifyPath}:\n\n${notifyContent}\n`);
    process.stdout.write("[timer] would run:\n");
    process.stdout.write("  systemctl --user daemon-reload\n");
    process.stdout.write(`  systemctl --user enable --now ${TIMER_NAME}\n`);
    return 0;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(servicePath, serviceContent);
  fs.writeFileSync(timerPath, timerContent);
  fs.writeFileSync(notifyPath, notifyContent);
  process.stdout.write(`[timer] wrote ${servicePath}\n`);
  process.stdout.write(`[timer] wrote ${timerPath}\n`);
  process.stdout.write(`[timer] wrote ${notifyPath}\n`);

  const reload = deps.systemctl(["daemon-reload"]);
  if (reload.status !== 0) {
    process.stderr.write(`[timer] systemctl daemon-reload failed: ${reload.stderr.trim()}\n`);
    return reload.status;
  }
  const enable = deps.systemctl(["enable", "--now", TIMER_NAME]);
  if (enable.status !== 0) {
    process.stderr.write(`[timer] systemctl enable --now failed: ${enable.stderr.trim()}\n`);
    return enable.status;
  }

  process.stdout.write(`\n[timer] ete-look-sync will run every ${cfg.intervalMinutes} min\n`);
  process.stdout.write(`[timer] next fire:  systemctl --user list-timers ${TIMER_NAME}\n`);
  process.stdout.write(`[timer] live logs:  journalctl --user -u ${SERVICE_NAME} -f\n`);
  process.stdout.write(`[timer] run now:    systemctl --user start ${SERVICE_NAME}\n`);
  process.stdout.write(`[timer] disable:    systemctl --user disable --now ${TIMER_NAME}\n`);
  process.stdout.write(
    "[timer] on failure: a desktop notification fires (via notify-send) " +
      "prompting `ete-look-sync login` when silent refresh can't recover\n",
  );
  return 0;
}

/** Stop, disable, and delete the installed units. */
export async function runRemoveTimer(
  deps: TimerDeps = defaultDeps,
): Promise<number> {
  // It's fine if disable fails because the timer was never enabled.
  deps.systemctl(["disable", "--now", TIMER_NAME]);

  const dir = deps.systemdUserDir();
  for (const file of [TIMER_NAME, SERVICE_NAME, NOTIFY_NAME]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      process.stdout.write(`[timer] removed ${p}\n`);
    }
  }
  const reload = deps.systemctl(["daemon-reload"]);
  if (reload.status !== 0) {
    log.warn(`[timer] systemctl daemon-reload returned ${reload.status}: ${reload.stderr.trim()}`);
  }
  process.stdout.write("[timer] ete-look-sync timer removed\n");
  return 0;
}

// ---------- unit rendering (exported for tests) ----------

export function renderServiceUnit(binPath: string, nodePath: string): string {
  // ExecStart invokes Node directly with the CLI shim as its first
  // argument. Bypasses the shim's `#!/usr/bin/env node` so a
  // stripped-PATH systemd session can't fall back to the system Node
  // (and break a Node-version-bound native dep like better-sqlite3).
  return `[Unit]
Description=Outlook calendar → personal calendar sync (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${nodePath} ${binPath} sync-once
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ete-look-sync
OnFailure=${NOTIFY_NAME}

[Install]
WantedBy=default.target
`;
}

// Triggered by the main service's OnFailure= only when a sync run
// exits non-zero. With silent token refresh now wired in, a sustained
// failure usually means MSAL needs a real MFA interaction — i.e. the
// one case that genuinely requires a human to run `ete-look-sync
// login`. We shell out so a missing notify-send (headless box, no
// libnotify) degrades to a no-op instead of a unit-start error.
export function renderNotifyUnit(): string {
  // Kept free of single quotes, backticks, and `$` so it nests safely
  // as a double-quoted argument inside systemd's single-quoted sh -c.
  const body =
    "ete-look-sync could not complete a sync. If the saved token expired " +
    "and silent refresh failed, run: ete-look-sync login. " +
    "Logs: journalctl --user -u ete-look-sync.service -e";
  return `[Unit]
Description=Desktop notification for ete-look-sync failure

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'command -v notify-send >/dev/null 2>&1 && notify-send --urgency=critical --app-name=ete-look-sync "Outlook calendar sync failed" "${body}" || true'
`;
}

export function renderTimerUnit(intervalMinutes: number): string {
  // OnCalendar fires on clock boundaries (e.g. every 30 min → :00
  // and :30), so it works reliably whether the service has run
  // before or not. Persistent=true catches up a missed fire after a
  // suspend/shutdown.
  return `[Unit]
Description=Run ete-look-sync every ${intervalMinutes} minutes

[Timer]
OnCalendar=*:0/${intervalMinutes}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

// ---------- internals ----------

function resolveBinPath(): string | null {
  // Prefer the shim that landed in PATH (e.g. `npm i -g .` puts an
  // `ete-look-sync` script in npm's global bin). Falling back to
  // process.argv[1] lets the user run from a checkout without a
  // global install.
  const which = spawnSync("which", ["ete-look-sync"], { encoding: "utf8" });
  if (which.status === 0) {
    const out = which.stdout.trim();
    if (out) return out;
  }
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) return path.resolve(argv1);
  return null;
}
