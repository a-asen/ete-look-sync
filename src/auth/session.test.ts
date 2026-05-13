import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SessionExpired,
  SessionNotCaptured,
  loadSession,
  originFromReferer,
} from "./session.js";
import { loadConfig, type Config } from "../config.js";

function withIsolatedConfig(fn: (cfg: Config) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-sync-auth-"));
  const saved: Record<string, string | undefined> = {};
  const overrides: Record<string, string | undefined> = {
    HOME: tmp,
    XDG_STATE_HOME: path.join(tmp, "state"),
    XDG_CONFIG_HOME: path.join(tmp, "config"),
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith("OUTLOOK_SYNC_"))
        .map((k) => [k, undefined]),
    ),
  };
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn(loadConfig());
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeBearer(cfg: Config, body: Record<string, unknown>): void {
  fs.writeFileSync(cfg.bearerFile, JSON.stringify(body));
}

function writeCookies(
  cfg: Config,
  cookies: Array<Record<string, unknown>>,
): void {
  fs.writeFileSync(cfg.cookiesFile, JSON.stringify(cookies));
}

test("loadSession throws SessionNotCaptured when files are missing", () => {
  withIsolatedConfig((cfg) => {
    assert.throws(() => loadSession(cfg), SessionNotCaptured);
  });
});

test("loadSession throws SessionExpired when bearer is in the past", () => {
  withIsolatedConfig((cfg) => {
    writeCookies(cfg, []);
    writeBearer(cfg, { token: "x", expires_on: 1 });
    assert.throws(() => loadSession(cfg), SessionExpired);
  });
});

test("loadSession throws SessionExpired when bearer is inside the skew", () => {
  withIsolatedConfig((cfg) => {
    writeCookies(cfg, []);
    // 30s ahead — inside the 60s skew, so treated as expired.
    writeBearer(cfg, {
      token: "x",
      expires_on: Math.floor(Date.now() / 1000) + 30,
    });
    assert.throws(() => loadSession(cfg), SessionExpired);
  });
});

test("loadSession returns headers and cookie string when valid", () => {
  withIsolatedConfig((cfg) => {
    writeCookies(cfg, [
      { name: "OWA", value: "abc", domain: "outlook.office.com", path: "/" },
      { name: "X-OWA-CANARY", value: "def", domain: "outlook.office.com", path: "/" },
    ]);
    writeBearer(cfg, {
      token: "jwt-here",
      expires_on: Math.floor(Date.now() / 1000) + 3600,
      anchor_mailbox: "PUID:1@2",
    });

    const session = loadSession(cfg);
    assert.equal(session.bearer.token, "jwt-here");
    assert.equal(session.cookieHeader, "OWA=abc; X-OWA-CANARY=def");
    assert.equal(session.baseHeaders["Authorization"], "Bearer jwt-here");
    assert.equal(session.baseHeaders["X-AnchorMailbox"], "PUID:1@2");
    assert.equal(session.baseHeaders["Origin"], "https://outlook.cloud.microsoft");
    assert.match(session.baseHeaders["Referer"] ?? "", /\/calendar\/$/);
    assert.match(session.baseHeaders["Prefer"] ?? "", /ImmutableId/);
  });
});

test("loadSession defaults X-AnchorMailbox to empty when missing", () => {
  withIsolatedConfig((cfg) => {
    writeCookies(cfg, []);
    writeBearer(cfg, {
      token: "t",
      expires_on: Math.floor(Date.now() / 1000) + 3600,
    });
    const session = loadSession(cfg);
    assert.equal(session.baseHeaders["X-AnchorMailbox"], "");
  });
});

test("originFromReferer strips path", () => {
  assert.equal(
    originFromReferer("https://outlook.cloud.microsoft/calendar/"),
    "https://outlook.cloud.microsoft",
  );
  assert.equal(originFromReferer("http://example.com"), "http://example.com");
  assert.equal(
    originFromReferer("http://example.com/a/b/c"),
    "http://example.com",
  );
});

test("originFromReferer returns input unchanged when no scheme", () => {
  assert.equal(originFromReferer("no-scheme-here"), "no-scheme-here");
});
