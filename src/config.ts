// Runtime configuration: filesystem paths, OWA settings, sync windows,
// and the selected backend (Etebase or CalDAV) plus its credentials.
//
// Settings are resolved in priority order (highest first):
//   1. Environment variables (always override everything)
//   2. ~/.config/outlook-sync/config.toml (or $OUTLOOK_SYNC_CONFIG)
//   3. Built-in defaults
//
// The TOML file is optional — if absent, env vars and defaults still
// produce a usable Config.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";

export type BackendName = "etebase" | "caldav";

export interface Config {
  // --- filesystem paths ------------------------------------------------
  stateDir: string;
  profileDir: string;        // Playwright user-data dir
  cookiesFile: string;       // Browser cookies replayed on every API call
  bearerFile: string;        // OWA Bearer JWT
  dbFile: string;            // Local mirror of seen events
  etebaseBlobFile: string;   // Saved Etebase Account blob (mode 600)

  // --- OWA -------------------------------------------------------------
  owaBaseUrl: string;

  // --- backend selection ----------------------------------------------
  backend: BackendName;

  // --- Etebase target -------------------------------------------------
  etebaseServerUrl: string;
  etebaseUsername: string;       // diagnostics only; not required for restore
  etebaseCollectionUid: string;  // filled by `login etebase`

  // --- CalDAV target --------------------------------------------------
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
  caldavCalendarName: string;

  // --- sync window defaults -------------------------------------------
  daysBack: number;
  daysForward: number;
  freezePastDays: number;
  intervalMinutes: number;
}

export function serviceSvcUrl(cfg: Config): string {
  return `${cfg.owaBaseUrl.replace(/\/+$/, "")}/owa/service.svc`;
}

export function calendarUrl(cfg: Config): string {
  return `${cfg.owaBaseUrl.replace(/\/+$/, "")}/calendar/`;
}

export function loadConfig(): Config {
  const toml = loadToml();
  const owaToml = sectionOf(toml, "owa");
  const syncToml = sectionOf(toml, "sync");
  const etebaseToml = sectionOf(toml, "etebase");
  const caldavToml = sectionOf(toml, "caldav");

  const stateDir =
    process.env["OUTLOOK_SYNC_STATE_DIR"] ??
    path.join(xdgStateHome(), "outlook-sync");
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    stateDir,
    profileDir: path.join(stateDir, "profile"),
    cookiesFile: path.join(stateDir, "cookies.json"),
    bearerFile: path.join(stateDir, "bearer.json"),
    dbFile: path.join(stateDir, "events.sqlite"),
    etebaseBlobFile: path.join(stateDir, "etebase.bin"),

    owaBaseUrl: stringSetting(
      "OUTLOOK_SYNC_OWA_URL", owaToml, "base_url",
      "https://outlook.cloud.microsoft",
    ),

    backend: parseBackend(
      stringSetting("OUTLOOK_SYNC_BACKEND", syncToml, "backend", "etebase"),
    ),

    etebaseServerUrl: stringSetting(
      "OUTLOOK_SYNC_ETEBASE_SERVER_URL", etebaseToml, "server_url",
      "https://api.etebase.com",
    ),
    etebaseUsername: stringSetting(
      "OUTLOOK_SYNC_ETEBASE_USERNAME", etebaseToml, "username", "",
    ),
    etebaseCollectionUid: stringSetting(
      "OUTLOOK_SYNC_ETEBASE_COLLECTION_UID", etebaseToml, "collection_uid", "",
    ),

    caldavUrl: stringSetting(
      "OUTLOOK_SYNC_CALDAV_URL", caldavToml, "url", "",
    ),
    caldavUsername: stringSetting(
      "OUTLOOK_SYNC_CALDAV_USERNAME", caldavToml, "username", "",
    ),
    caldavPassword: stringSetting(
      "OUTLOOK_SYNC_CALDAV_PASSWORD", caldavToml, "password", "",
    ),
    caldavCalendarName: stringSetting(
      "OUTLOOK_SYNC_CALDAV_CALENDAR", caldavToml, "calendar", "",
    ),

    daysBack: intSetting("OUTLOOK_SYNC_DAYS_BACK", syncToml, "days_back", 7),
    daysForward: intSetting("OUTLOOK_SYNC_DAYS_FORWARD", syncToml, "days_forward", 365),
    freezePastDays: intSetting("OUTLOOK_SYNC_FREEZE_PAST_DAYS", syncToml, "freeze_past_days", 2),
    intervalMinutes: intSetting("OUTLOOK_SYNC_INTERVAL_MINUTES", syncToml, "interval_minutes", 30),
  };
}

// ---------- internals ----------

function xdgStateHome(): string {
  return process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state");
}

function xdgConfigHome(): string {
  return process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config");
}

function loadToml(): Record<string, unknown> {
  const configPath =
    process.env["OUTLOOK_SYNC_CONFIG"] ??
    path.join(xdgConfigHome(), "outlook-sync", "config.toml");
  if (!fs.existsSync(configPath)) return {};
  const parsed = parseToml(fs.readFileSync(configPath, "utf8"));
  return isPlainObject(parsed) ? parsed : {};
}

function sectionOf(toml: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = toml[key];
  return isPlainObject(v) ? v : {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringSetting(
  envVar: string,
  section: Record<string, unknown>,
  key: string,
  defaultValue: string,
): string {
  const env = process.env[envVar];
  if (env !== undefined) return env;
  const v = section[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return defaultValue;
}

function intSetting(
  envVar: string,
  section: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const env = process.env[envVar];
  if (env !== undefined) {
    const n = Number(env);
    if (!Number.isFinite(n)) {
      throw new Error(`${envVar} must be an integer; got ${JSON.stringify(env)}`);
    }
    return Math.trunc(n);
  }
  const v = section[key];
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return defaultValue;
}

function parseBackend(value: string): BackendName {
  const v = value.toLowerCase();
  if (v === "etebase" || v === "caldav") return v;
  throw new Error(
    `Unknown sync backend ${JSON.stringify(value)}; expected "etebase" or "caldav"`,
  );
}
