// Replay a captured OWA session — cookies + Bearer JWT — from a
// headless client. The Outlook SPA authenticates service.svc calls
// with a JWT Bearer and a mailbox-routing `X-AnchorMailbox` header;
// this module is the single source of truth for assembling a correctly
// shaped request.

import * as fs from "node:fs";

import { calendarUrl, serviceSvcUrl, type Config } from "../config.js";
import { getLogger } from "../log.js";

const log = getLogger("auth/session");

// Treat a token expiring inside the next minute as expired — multi-
// second roundtrips can race the exp boundary and turn our clean error
// into an opaque 401 mid-sync.
const EXPIRY_SKEW_SEC = 60;

/** No bearer.json or cookies.json on disk — capture hasn't run yet. */
export class SessionNotCaptured extends Error {
  override readonly name = "SessionNotCaptured";
}

/** Saved bearer's exp is already in the past (or inside the skew). */
export class SessionExpired extends Error {
  override readonly name = "SessionExpired";
}

/** Shape of the on-disk `bearer.json`, as written by auth/capture.ts. */
export interface StoredBearer {
  token: string;
  expires_on: number;
  anchor_mailbox?: string;
  tenant_id?: string;
  scopes?: string;
  cached_at?: string | number | null;
  msal_key?: string;
}

/** Shape of one entry in `cookies.json` — Playwright's cookie format. */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface Session {
  bearer: StoredBearer;
  /** Headers shared across every service.svc request. */
  baseHeaders: Readonly<Record<string, string>>;
  /** `Cookie:` header value pre-assembled from cookies.json. */
  cookieHeader: string;
}

export function loadSession(cfg: Config): Session {
  if (!fs.existsSync(cfg.cookiesFile) || !fs.existsSync(cfg.bearerFile)) {
    throw new SessionNotCaptured(
      `No saved session at ${cfg.stateDir}. Run \`ete-look-sync login\` first.`,
    );
  }

  const rawCookies = JSON.parse(
    fs.readFileSync(cfg.cookiesFile, "utf8"),
  ) as PlaywrightCookie[];
  const bearer = JSON.parse(fs.readFileSync(cfg.bearerFile, "utf8")) as StoredBearer;
  guardExpiry(bearer);

  const url = calendarUrl(cfg);
  return {
    bearer,
    cookieHeader: cookieHeaderFrom(rawCookies),
    baseHeaders: Object.freeze({
      "Accept": "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${bearer.token}`,
      "X-AnchorMailbox": bearer.anchor_mailbox ?? "",
      // Drives Exchange to use immutable IDs (stable across moves)
      // and to inline third-party meeting-provider fields (Zoom, etc.)
      // on events. Value copied verbatim from observed OWA traffic.
      "Prefer":
        'IdType="ImmutableId", exchange.behavior="IncludeThirdPartyOnlineMeetingProviders"',
      "Origin": originFromReferer(url),
      "Referer": url,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    }),
  };
}

/**
 * POST to `/owa/service.svc?action=<action>&app=Calendar`.
 *
 * The `app=Calendar` query param was present on every recorded OWA
 * call and some endpoints (notably GetCalendarView) refuse without
 * it. The `Action` header must equal the `action` query param or OWA
 * returns a misleading 440 Login Timeout; centralising both avoids
 * that de-sync.
 */
export async function callService(
  session: Session,
  cfg: Config,
  action: string,
  body: unknown,
): Promise<Response> {
  log.debug(`[api] → ${action}`);
  const t0 = Date.now();
  const url = new URL(serviceSvcUrl(cfg));
  url.searchParams.set("action", action);
  url.searchParams.set("app", "Calendar");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...session.baseHeaders,
      "Action": action,
      "Cookie": session.cookieHeader,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  log.debug(
    `[api] ← ${action}  HTTP ${resp.status}  ${((Date.now() - t0) / 1000).toFixed(2)}s`,
  );
  return resp;
}

function guardExpiry(bearer: StoredBearer): void {
  const exp = Number(bearer.expires_on ?? 0);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000) + EXPIRY_SKEW_SEC) {
    throw new SessionExpired(
      `Saved bearer token is expired (exp=${exp}). Run \`ete-look-sync login\` to refresh.`,
    );
  }
}

function cookieHeaderFrom(cookies: readonly PlaywrightCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Derive `Origin` from the scheme + host of a referer URL. */
export function originFromReferer(url: string): string {
  const idx = url.indexOf("://");
  if (idx < 0) return url;
  const scheme = url.slice(0, idx);
  const rest = url.slice(idx + 3);
  const slashIdx = rest.indexOf("/");
  const host = slashIdx < 0 ? rest : rest.slice(0, slashIdx);
  return `${scheme}://${host}`;
}
