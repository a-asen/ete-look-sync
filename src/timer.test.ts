import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Config } from "./config.js";
import {
  renderServiceUnit,
  renderTimerUnit,
  runRemoveTimer,
  runSetupTimer,
  type TimerDeps,
} from "./timer.js";

function makeCfg(intervalMinutes = 30): Config {
  return {
    stateDir: "",
    profileDir: "",
    cookiesFile: "",
    bearerFile: "",
    dbFile: "",
    etebaseBlobFile: "",
    owaBaseUrl: "",
    backend: "etebase",
    etebaseServerUrl: "",
    etebaseUsername: "",
    etebaseCollectionUid: "",
    caldavUrl: "",
    caldavUsername: "",
    caldavPassword: "",
    caldavCalendarName: "",
    daysBack: 7,
    daysForward: 30,
    freezePastDays: 2,
    intervalMinutes,
  };
}

interface SystemctlCall {
  args: string[];
}

function makeDeps(opts: {
  binPath?: string | null;
  nodePath?: string;
  systemdDir: string;
  systemctlStatus?: number;
}): { deps: TimerDeps; calls: SystemctlCall[] } {
  const calls: SystemctlCall[] = [];
  // null is explicit "no bin found"; undefined falls back to the default.
  const binPath =
    "binPath" in opts ? opts.binPath ?? null : "/usr/local/bin/ete-look-sync";
  const nodePath = opts.nodePath ?? "/usr/local/bin/node";
  return {
    calls,
    deps: {
      resolveBinPath: () => binPath,
      resolveNodePath: () => nodePath,
      systemdUserDir: () => opts.systemdDir,
      systemctl: (args) => {
        calls.push({ args: [...args] });
        return { status: opts.systemctlStatus ?? 0, stderr: "" };
      },
    },
  };
}

// ---------- unit rendering ----------

test("renderServiceUnit pins the resolved node + bin paths", () => {
  const unit = renderServiceUnit("/usr/local/bin/ete-look-sync", "/usr/local/bin/node");
  // ExecStart explicitly names the Node binary so a stripped-PATH
  // systemd session can't fall back to a wrong Node.
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/usr\/local\/bin\/ete-look-sync sync-once/);
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /After=network-online\.target/);
});

test("renderTimerUnit uses the configured interval", () => {
  const unit = renderTimerUnit(15);
  assert.match(unit, /OnCalendar=\*:0\/15/);
  assert.match(unit, /Persistent=true/);
  assert.match(unit, /WantedBy=timers\.target/);
});

test("renderServiceUnit and renderTimerUnit output ends with a newline", () => {
  // systemd is lenient about trailing newlines, but conventional
  // unit files end with one — pinning here avoids future drift.
  assert.ok(renderServiceUnit("/x", "/node").endsWith("\n"));
  assert.ok(renderTimerUnit(30).endsWith("\n"));
});

// ---------- setup ----------

test("runSetupTimer --dry-run prints units without touching disk", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-dry-"));
  const { deps, calls } = makeDeps({ systemdDir });

  const code = await runSetupTimer(makeCfg(), { dryRun: true }, deps);
  assert.equal(code, 0);
  // No files written and no systemctl invocations.
  assert.deepEqual(fs.readdirSync(systemdDir), []);
  assert.equal(calls.length, 0);
});

test("runSetupTimer writes both unit files and runs daemon-reload + enable", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-setup-"));
  const { deps, calls } = makeDeps({ systemdDir });

  const code = await runSetupTimer(makeCfg(15), {}, deps);
  assert.equal(code, 0);

  const service = fs.readFileSync(path.join(systemdDir, "ete-look-sync.service"), "utf8");
  const timer = fs.readFileSync(path.join(systemdDir, "ete-look-sync.timer"), "utf8");
  assert.match(service, /ExecStart=\/usr\/local\/bin\/node \/usr\/local\/bin\/ete-look-sync sync-once/);
  assert.match(timer, /OnCalendar=\*:0\/15/);

  assert.deepEqual(
    calls.map((c) => c.args),
    [["daemon-reload"], ["enable", "--now", "ete-look-sync.timer"]],
  );
});

test("runSetupTimer fails when the CLI bin can't be located", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-nobin-"));
  const { deps } = makeDeps({ binPath: null, systemdDir });
  const code = await runSetupTimer(makeCfg(), {}, deps);
  assert.equal(code, 1);
  // No units written when we bail early.
  assert.deepEqual(fs.readdirSync(systemdDir), []);
});

test("runSetupTimer surfaces a non-zero systemctl status", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-fail-"));
  const { deps } = makeDeps({ systemdDir, systemctlStatus: 5 });
  const code = await runSetupTimer(makeCfg(), {}, deps);
  // Units were written but daemon-reload failed → exit code propagates.
  assert.equal(code, 5);
});

// ---------- remove ----------

test("runRemoveTimer disables and deletes both units", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-remove-"));
  // Seed with both units so removal has something to do.
  fs.writeFileSync(path.join(systemdDir, "ete-look-sync.service"), "stub");
  fs.writeFileSync(path.join(systemdDir, "ete-look-sync.timer"), "stub");

  const { deps, calls } = makeDeps({ systemdDir });
  const code = await runRemoveTimer(deps);
  assert.equal(code, 0);

  assert.equal(fs.existsSync(path.join(systemdDir, "ete-look-sync.service")), false);
  assert.equal(fs.existsSync(path.join(systemdDir, "ete-look-sync.timer")), false);
  // disable --now first, then daemon-reload after the unlinks.
  assert.deepEqual(
    calls.map((c) => c.args),
    [["disable", "--now", "ete-look-sync.timer"], ["daemon-reload"]],
  );
});

test("runRemoveTimer is idempotent when no units are installed", async () => {
  const systemdDir = fs.mkdtempSync(path.join(os.tmpdir(), "timer-noop-"));
  const { deps } = makeDeps({ systemdDir });
  const code = await runRemoveTimer(deps);
  assert.equal(code, 0);
});
