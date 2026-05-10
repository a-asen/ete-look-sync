import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig, serviceSvcUrl } from "./config.js";

/**
 * Run `fn` with a freshly-isolated `$HOME`, `$XDG_*`, and `$OUTLOOK_SYNC_*`
 * environment so loadConfig() reads only what we put there. Restores the
 * previous environment on exit, even on failure.
 */
function withIsolatedEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-sync-test-"));
  const sandbox: Record<string, string | undefined> = {
    HOME: tmp,
    XDG_STATE_HOME: path.join(tmp, "state"),
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    // Clear every OUTLOOK_SYNC_* var so the host env can't leak into a test.
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith("OUTLOOK_SYNC_"))
        .map((k) => [k, undefined]),
    ),
    ...overrides,
  };

  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sandbox)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("loadConfig: defaults when nothing is set", () => {
  withIsolatedEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.backend, "etebase");
    assert.equal(cfg.owaBaseUrl, "https://outlook.cloud.microsoft");
    assert.equal(cfg.daysBack, 7);
    assert.equal(cfg.daysForward, 365);
    assert.equal(cfg.freezePastDays, 2);
    assert.equal(cfg.intervalMinutes, 30);
    assert.equal(cfg.etebaseServerUrl, "https://api.etebase.com");
    assert.equal(cfg.caldavUrl, "");
  });
});

test("loadConfig: env vars override defaults", () => {
  withIsolatedEnv(
    {
      OUTLOOK_SYNC_BACKEND: "caldav",
      OUTLOOK_SYNC_DAYS_BACK: "42",
      OUTLOOK_SYNC_CALDAV_URL: "http://localhost:37358/x/y/",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.backend, "caldav");
      assert.equal(cfg.daysBack, 42);
      assert.equal(cfg.caldavUrl, "http://localhost:37358/x/y/");
    },
  );
});

test("loadConfig: TOML values are read when env is unset", () => {
  withIsolatedEnv({}, () => {
    const configHome = process.env["XDG_CONFIG_HOME"]!;
    const dir = path.join(configHome, "outlook-sync");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.toml"),
      [
        "[sync]",
        'backend = "caldav"',
        "days_back = 14",
        "",
        "[etebase]",
        'server_url = "https://etebase.example.org"',
        'collection_uid = "abc123"',
      ].join("\n"),
    );

    const cfg = loadConfig();
    assert.equal(cfg.backend, "caldav");
    assert.equal(cfg.daysBack, 14);
    assert.equal(cfg.etebaseServerUrl, "https://etebase.example.org");
    assert.equal(cfg.etebaseCollectionUid, "abc123");
  });
});

test("loadConfig: env wins over TOML", () => {
  withIsolatedEnv({ OUTLOOK_SYNC_BACKEND: "etebase" }, () => {
    const configHome = process.env["XDG_CONFIG_HOME"]!;
    const dir = path.join(configHome, "outlook-sync");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.toml"),
      ["[sync]", 'backend = "caldav"'].join("\n"),
    );
    assert.equal(loadConfig().backend, "etebase");
  });
});

test("loadConfig: paths land under the configured stateDir", () => {
  withIsolatedEnv({}, () => {
    const cfg = loadConfig();
    assert.ok(cfg.stateDir.endsWith(path.join("state", "outlook-sync")));
    assert.equal(cfg.dbFile, path.join(cfg.stateDir, "events.sqlite"));
    assert.equal(cfg.etebaseBlobFile, path.join(cfg.stateDir, "etebase.bin"));
    assert.equal(cfg.bearerFile, path.join(cfg.stateDir, "bearer.json"));
    assert.ok(fs.existsSync(cfg.stateDir));
  });
});

test("loadConfig: rejects an unknown backend value", () => {
  withIsolatedEnv({ OUTLOOK_SYNC_BACKEND: "bogus" }, () => {
    assert.throws(() => loadConfig(), /Unknown sync backend/);
  });
});

test("loadConfig: integer env values must parse", () => {
  withIsolatedEnv({ OUTLOOK_SYNC_DAYS_BACK: "not-a-number" }, () => {
    assert.throws(() => loadConfig(), /must be an integer/);
  });
});

test("serviceSvcUrl strips trailing slashes from owaBaseUrl", () => {
  withIsolatedEnv({ OUTLOOK_SYNC_OWA_URL: "https://example.com///" }, () => {
    const cfg = loadConfig();
    assert.equal(serviceSvcUrl(cfg), "https://example.com/owa/service.svc");
  });
});
