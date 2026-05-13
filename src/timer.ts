// Generate and install systemd user units for unattended periodic sync.
//
// Two units are written to ~/.config/systemd/user/:
//
//   outlook-sync.service — oneshot service that runs `outlook-sync sync-once`
//   outlook-sync.timer   — calendar timer that fires it every N minutes
//
// The bin path is whatever resolved `outlook-sync` from the user's
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

const SERVICE_NAME = "outlook-sync.service";
const TIMER_NAME = "outlook-sync.timer";

export interface TimerDeps {
  /** Resolve the absolute path to the installed CLI. */
  resolveBinPath: () => string | null;
  /** Where systemd user units are written. */
  systemdUserDir: () => string;
  /** Wraps `systemctl --user …` so tests can avoid touching real systemd. */
  systemctl: (args: readonly string[]) => { status: number; stderr: string };
}

const defaultDeps: TimerDeps = {
  resolveBinPath,
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
      "[timer] could not locate the outlook-sync executable on PATH.\n" +
        "        Install the CLI first (e.g. `npm i -g .` from the repo).\n",
    );
    return 1;
  }

  const serviceContent = renderServiceUnit(binPath);
  const timerContent = renderTimerUnit(cfg.intervalMinutes);
  const dir = deps.systemdUserDir();
  const servicePath = path.join(dir, SERVICE_NAME);
  const timerPath = path.join(dir, TIMER_NAME);

  if (opts.dryRun) {
    process.stdout.write(`[timer] would write ${servicePath}:\n\n${serviceContent}\n`);
    process.stdout.write(`[timer] would write ${timerPath}:\n\n${timerContent}\n`);
    process.stdout.write("[timer] would run:\n");
    process.stdout.write("  systemctl --user daemon-reload\n");
    process.stdout.write(`  systemctl --user enable --now ${TIMER_NAME}\n`);
    return 0;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(servicePath, serviceContent);
  fs.writeFileSync(timerPath, timerContent);
  process.stdout.write(`[timer] wrote ${servicePath}\n`);
  process.stdout.write(`[timer] wrote ${timerPath}\n`);

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

  process.stdout.write(`\n[timer] outlook-sync will run every ${cfg.intervalMinutes} min\n`);
  process.stdout.write(`[timer] next fire:  systemctl --user list-timers ${TIMER_NAME}\n`);
  process.stdout.write(`[timer] live logs:  journalctl --user -u ${SERVICE_NAME} -f\n`);
  process.stdout.write(`[timer] run now:    systemctl --user start ${SERVICE_NAME}\n`);
  process.stdout.write(`[timer] disable:    systemctl --user disable --now ${TIMER_NAME}\n`);
  return 0;
}

/** Stop, disable, and delete the installed units. */
export async function runRemoveTimer(
  deps: TimerDeps = defaultDeps,
): Promise<number> {
  // It's fine if disable fails because the timer was never enabled.
  deps.systemctl(["disable", "--now", TIMER_NAME]);

  const dir = deps.systemdUserDir();
  for (const file of [TIMER_NAME, SERVICE_NAME]) {
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
  process.stdout.write("[timer] outlook-sync timer removed\n");
  return 0;
}

// ---------- unit rendering (exported for tests) ----------

export function renderServiceUnit(binPath: string): string {
  return `[Unit]
Description=Outlook calendar → personal calendar sync (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${binPath} sync-once
StandardOutput=journal
StandardError=journal
SyslogIdentifier=outlook-sync

[Install]
WantedBy=default.target
`;
}

export function renderTimerUnit(intervalMinutes: number): string {
  // OnCalendar fires on clock boundaries (e.g. every 30 min → :00
  // and :30), so it works reliably whether the service has run
  // before or not. Persistent=true catches up a missed fire after a
  // suspend/shutdown.
  return `[Unit]
Description=Run outlook-sync every ${intervalMinutes} minutes

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
  // `outlook-sync` script in npm's global bin). Falling back to
  // process.argv[1] lets the user run from a checkout without a
  // global install.
  const which = spawnSync("which", ["outlook-sync"], { encoding: "utf8" });
  if (which.status === 0) {
    const out = which.stdout.trim();
    if (out) return out;
  }
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) return path.resolve(argv1);
  return null;
}
