// Interactive (and headless silent-refresh) OWA login capture for the
// One Outlook MSAL frontend.
//
// Launches a real Chromium via Playwright with a persistent user-data
// dir so the MFA trusted-device cookie survives between runs. Polls the
// page's localStorage for an MSAL accesstoken whose JWT audience is
// `https://outlook.office.com` — the Bearer the SPA presents to
// service.svc on every call. The token is the only artefact our
// headless client actually needs, so waiting for it is both a cheap
// liveness check and a precise readiness signal.
//
// On success two files are written under cfg.stateDir:
//
//   * cookies.json — every cookie the browser holds, replayed verbatim
//     by `auth/session.ts`. Some service.svc calls look at cookie-
//     derived values alongside the Bearer.
//   * bearer.json — { token, expires_on, tenant_id, anchor_mailbox,
//     scopes, cached_at, msal_key }. `anchor_mailbox` is the
//     `PUID:<puid>@<tid>` form OWA sends in `X-AnchorMailbox`.
//
// Bearer JSON keys match the Python predecessor exactly so the legacy
// tool can still read this file during cutover.

import * as fs from "node:fs";
import { chromium, type Page } from "playwright";

import { calendarUrl, type Config } from "../config.js";
import { getLogger } from "../log.js";

const log = getLogger("auth/capture");

export const OUTLOOK_AUDIENCE = "https://outlook.office.com";

const POLL_INTERVAL_MS = 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
// Headless silent-refresh gets a shorter window — if MSAL can refresh
// silently it does so in seconds; failing quickly avoids blocking the
// systemd timer for the full interactive timeout.
const SILENT_TIMEOUT_MS = 60 * 1000;
const PROGRESS_TICK_MS = 15 * 1000;
// Skew margin: a token whose exp is within this window is treated as
// already expired so we never persist one that will fail the
// SessionExpired guard the moment we hand it back.
const EXPIRY_SKEW_SEC = 60;
// If no fresh token has appeared after this long, reload the calendar
// once — MSAL only refreshes proactively when the SPA makes
// authenticated calls, and a reload forces a new wave of them.
const RELOAD_NUDGE_MS = 45 * 1000;
// Attempt silent refresh when the saved bearer has less than this many
// seconds remaining. Two hours is enough headroom for the next sync
// to fire on a 30-minute timer.
const SILENT_REFRESH_THRESHOLD_SEC = 2 * 60 * 60;

/** Headless capture timed out — MFA interaction is required. */
export class SilentRefreshFailed extends Error {
  override readonly name = "SilentRefreshFailed";
}

/** Interactive capture timed out — user did not finish signing in. */
export class CaptureTimedOut extends Error {
  override readonly name = "CaptureTimedOut";
}

export interface BearerRecord {
  token: string;
  expires_on: number;
  tenant_id: string;
  anchor_mailbox: string;
  scopes: string;
  cached_at: string | number | null;
  msal_key: string;
}

export interface CaptureResult {
  bearer: BearerRecord;
  cookies: unknown[];
}

export interface CaptureOptions {
  headless?: boolean;
}

export async function capture(
  cfg: Config,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const headless = opts.headless === true;
  fs.mkdirSync(cfg.profileDir, { recursive: true });
  const timeoutMs = headless ? SILENT_TIMEOUT_MS : LOGIN_TIMEOUT_MS;
  const url = calendarUrl(cfg);

  if (headless) {
    log.info("[auth] attempting silent headless token refresh…");
  } else {
    log.info(`[auth] opening ${url}`);
  }

  const context = await chromium.launchPersistentContext(cfg.profileDir, {
    headless,
    viewport: { width: 1200, height: 900 },
  });

  let bearer: BearerRecord;
  let cookies: unknown[];
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Give MSAL a chance to finish its initial token-acquisition flow
    // before we start reading localStorage. OWA streams telemetry
    // forever, so we treat the eventual timeout as a non-error.
    try {
      await page.waitForLoadState("networkidle", { timeout: 20_000 });
    } catch {
      /* networkidle is best-effort */
    }

    if (!headless) {
      log.info(
        "[auth] complete sign-in in the opened window; this script waits up to 5 min…",
      );
    }

    try {
      bearer = await waitForBearer(page, { timeoutMs });
    } catch (e) {
      if (headless) throw new SilentRefreshFailed(toMessage(e));
      throw e;
    }
    cookies = await context.cookies();
  } finally {
    await context.close();
  }

  fs.writeFileSync(cfg.cookiesFile, JSON.stringify(cookies, null, 2));
  fs.writeFileSync(cfg.bearerFile, JSON.stringify(bearer, null, 2));

  log.info(`[auth] saved ${cookies.length} cookies → ${cfg.cookiesFile}`);
  log.info(`[auth] saved bearer (exp ${bearer.expires_on}) → ${cfg.bearerFile}`);
  return { bearer, cookies };
}

/**
 * Attempt a headless token refresh if the saved bearer is near expiry.
 *
 * Called by the orchestrator before every sync so the timer keeps
 * working unattended even when the access token has a short TTL. If
 * MSAL can reuse the saved MFA session it replaces bearer.json in
 * ~10s. If MFA interaction is needed it logs a warning and leaves the
 * old token in place — the subsequent loadSession() then either
 * succeeds (still valid) or raises SessionExpired with a clear
 * message.
 */
export async function maybeSilentRefresh(cfg: Config): Promise<void> {
  if (!fs.existsSync(cfg.bearerFile)) return;
  let exp = 0;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cfg.bearerFile, "utf8"));
    if (raw && typeof raw === "object" && "expires_on" in raw) {
      exp = Number((raw as Record<string, unknown>)["expires_on"] ?? 0);
    }
  } catch {
    return;
  }
  const remaining = exp - Math.floor(Date.now() / 1000);
  if (remaining > SILENT_REFRESH_THRESHOLD_SEC) {
    log.debug(
      `[sync] bearer valid for ${(remaining / 3600).toFixed(1)}h — skipping silent refresh`,
    );
    return;
  }
  log.info(
    `[sync] bearer expires in ${(Math.max(remaining, 0) / 3600).toFixed(1)}h — ` +
      "attempting silent headless refresh",
  );
  try {
    await capture(cfg, { headless: true });
    log.info("[sync] silent refresh succeeded");
  } catch (e) {
    if (e instanceof SilentRefreshFailed) {
      log.warn(
        "[sync] silent refresh failed — MFA interaction required. " +
          "Run 'ete-look-sync login' at your next opportunity. " +
          "Proceeding with the existing token for now.",
      );
      return;
    }
    log.warn(
      `[sync] silent refresh error (${toMessage(e)}) — continuing with existing token`,
    );
  }
}

async function waitForBearer(
  page: Page,
  opts: { timeoutMs: number },
): Promise<BearerRecord> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastTick = 0;
  let nudged = false;
  const started = Date.now();
  let lastErr = "";

  while (Date.now() < deadline) {
    let entries: MsalEntry[] = [];
    try {
      // Any evaluate failure just means the page isn't ready yet.
      const raw: unknown = await page.evaluate(MSAL_SCAN_SCRIPT);
      // Defensive: Playwright's evaluate can yield `undefined` if the
      // page navigates mid-call or the script returns a non-
      // serialisable value. Better to no-op this tick than crash the
      // login.
      entries = Array.isArray(raw) ? (raw as MsalEntry[]) : [];
      lastErr = "";
    } catch (e) {
      lastErr = toMessage(e);
    }
    const record = pickBestToken(entries, Math.floor(Date.now() / 1000));
    if (record) {
      log.info(`[auth] bearer found (exp=${record.expires_on}); url=${page.url()}`);
      return record;
    }

    const now = Date.now();
    if (!nudged && now - started >= RELOAD_NUDGE_MS) {
      log.info("[auth]   no fresh token yet — reloading the page to nudge MSAL refresh");
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
      } catch {
        /* reload failures are non-fatal */
      }
      nudged = true;
    }
    if (now - lastTick >= PROGRESS_TICK_MS) {
      const remaining = Math.floor((deadline - now) / 1000);
      const detail = lastErr ? `  (err: ${lastErr})` : "";
      log.info(
        `[auth]   waiting… url=${JSON.stringify(page.url())}  (${remaining}s remaining)${detail}`,
      );
      lastTick = now;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new CaptureTimedOut(
    `[auth] timed out after ${Math.floor(opts.timeoutMs / 1000)}s waiting for a fresh ` +
      "Outlook-audience bearer token. Sign in and let the calendar fully render — " +
      "clicking around the week view triggers MSAL to refresh. If it keeps failing, " +
      "run `ete-look-sync diagnose` and share the summary.",
  );
}

/**
 * Pick the freshest MSAL accesstoken entry whose JWT audience is
 * `https://outlook.office.com`. Stale tokens (`exp <= now + skew`) are
 * skipped — MSAL keeps historical entries in its cache and without
 * this filter we would latch onto a stale token from a previous
 * session and cheerfully persist it.
 *
 * Pure given `nowSec`; exposed for testing.
 */
export function pickBestToken(
  entries: readonly MsalEntry[],
  nowSec: number,
): BearerRecord | null {
  let best: BearerRecord | null = null;
  let bestExp = -1;
  for (const entry of entries) {
    const val = entry.value;
    const token = typeof val.secret === "string" ? val.secret : "";
    const claims = decodeJwtClaims(token);
    if (!claims || claims["aud"] !== OUTLOOK_AUDIENCE) continue;
    const expRaw = val.expiresOn ?? claims["exp"] ?? 0;
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp <= nowSec + EXPIRY_SKEW_SEC) continue;
    if (exp <= bestExp) continue;
    best = {
      token,
      expires_on: exp,
      tenant_id: typeof claims["tid"] === "string" ? claims["tid"] : "",
      anchor_mailbox: anchorMailboxFromClaims(claims),
      scopes:
        typeof val.target === "string"
          ? val.target
          : typeof claims["scp"] === "string"
            ? claims["scp"]
            : "",
      cached_at:
        typeof val.cachedAt === "string" || typeof val.cachedAt === "number"
          ? val.cachedAt
          : null,
      msal_key: entry.key,
    };
    bestExp = exp;
  }
  return best;
}

/**
 * Decode a JWT payload (segment 2) without verifying the signature.
 *
 * We trust the token because it was produced by Microsoft's own MSAL
 * library running in an isolated Playwright profile we ourselves
 * launched; verifying against Azure's rotating JWKS would add latency
 * for zero additional safety.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1] ?? "";
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Build the `X-AnchorMailbox` value the OWA SPA sends: `PUID:<puid>@<tid>`. */
export function anchorMailboxFromClaims(claims: Record<string, unknown>): string {
  const puid = typeof claims["puid"] === "string" ? claims["puid"] : "";
  const tid = typeof claims["tid"] === "string" ? claims["tid"] : "";
  return `PUID:${puid}@${tid}`;
}

export interface MsalEntry {
  key: string;
  value: {
    secret?: unknown;
    expiresOn?: unknown;
    target?: unknown;
    cachedAt?: unknown;
    [k: string]: unknown;
  };
}

// MSAL v2 stores accesstokens under keys containing 'accesstoken' (case-
// insensitive) with JSON values like {secret, expiresOn, realm, target, ...}.
// `secret` is the JWT.
//
// Wrapped as an IIFE so `page.evaluate(MSAL_SCAN_SCRIPT)` resolves
// to the function's RETURN value, not the function object itself. A
// bare `() => { … }` string evaluates to the arrow function, which
// is non-serialisable and comes back as `undefined`.
const MSAL_SCAN_SCRIPT = `(() => {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.toLowerCase().includes('accesstoken')) continue;
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v && v.secret) out.push({key: k, value: v});
    } catch (_) {}
  }
  return out;
})()`;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
