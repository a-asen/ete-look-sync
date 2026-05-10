# etesync-outlook-calendar-sync — port plan

A Node/TypeScript rewrite of [`etesync-outlook-calendar-scraper-sync`](https://github.com/a-asen/etesync-outlook-calendar-scraper-sync)
(Python). Same goal — headless mirror of a UiT Outlook calendar to a personal
EteSync calendar — but built around the actively-maintained `etebase` npm SDK
instead of the abandoned Python `etebase` package.

This file is the roadmap. As phases land it gets pruned; once the rewrite
ships, it's deleted in favour of the README.

---

## Why a rewrite, not a port

* **Etebase**: the Python SDK (PyPI `etebase`, last released 2021) no longer
  builds on modern rustc — its Rust bindings transitively pin `socket2 0.3.12`
  which fails compilation. The npm `etebase` package (`^0.43`) is what
  `ete-stethic` already uses and is actively maintained.
* **Stack consolidation**: keeping Python only for the scraper while talking
  to Etebase via Node would leave a permanent hybrid. One language, one
  runtime, one dep tree is simpler to operate.
* **Better libraries on the Node side for what we need**:
  `playwright`, `better-sqlite3`, `tsdav`, native `fetch`, `etebase`.
* **Type-sharing potential** with `ete-stethic` (also TypeScript) if the two
  ever grow into something cohesive.

The current Python repo keeps working unchanged during the rewrite; cutover
is a one-time migration of `events.sqlite`.

---

## Module map (Python → TypeScript)

| Python (`src/outlook_sync/…`) | TypeScript (`src/…`) | Notes |
|---|---|---|
| `models.py` | `models.ts` | `Event` interface + content-hash helper |
| `config.py` | `config.ts` | TOML + env var resolution |
| `log.py` | `log.ts` | Thin wrapper over `pino` (or `console` if minimal) |
| `auth/capture.py` | `auth/capture.ts` | Playwright MSAL token capture |
| `auth/session.py` | `auth/session.ts` | Bearer + cookie load, expiry check |
| `fetch/owa.py` | `fetch/owa.ts` | `FindItem` + chunked `GetItem` against `service.svc` |
| `fetch/parse.py` | `fetch/parse.ts` | OWA JSON → `Event` |
| `store/db.py` | `store/db.ts` | `better-sqlite3` wrapper |
| `sync/differ.py` | `sync/differ.ts` | Pure logic, no deps |
| `sync/ics.py` | `sync/ics.ts` | `Event` → iCalendar bytes |
| `sync/backend.py` | `sync/backend.ts` | `Backend` interface (already shaped this way in Python) |
| `sync/caldav_writer.py` | `sync/backends/caldav.ts` | `tsdav`-based |
| *(new)* | `sync/backends/etebase.ts` | `etebase` npm SDK |
| `sync/orchestrator.py` | `sync/orchestrator.ts` | Wires fetch → diff → push |
| `cli.py` | `cli.ts` | `commander` or `node:util.parseArgs` |
| `timer.py` | `timer.ts` | systemd unit string generation |
| `probe.py` | `probe.ts` | Smoke test — auth + small fetch |

Tests live next to each module as `*.test.ts` using `node:test` + `tsx`.

---

## Library choices

| Concern | Library | Rationale |
|---|---|---|
| Runtime | Node 22 LTS | Native `fetch`, native `--watch`, `node:util.parseArgs`, stable |
| Language | TypeScript (strict) | Catch shape errors at compile time; good ergonomic match for OWA's nested JSON |
| Package mgr | `npm` | Already used by `ete-stethic`; keeps tooling consistent across your repos |
| Browser auth | `playwright` | Same library as the Python version — port is mostly mechanical |
| HTTP | native `fetch` | Built into Node 22; no `axios`/`undici` wrapper needed |
| SQLite | `better-sqlite3` | Synchronous, prepared-statement-friendly; ideal for our short CLI runs |
| iCalendar | `ical-generator` | Active, sane API for writing VEVENTs |
| TOML | `smol-toml` | Spec-compliant, zero-dep, MIT |
| CalDAV | `tsdav` | Most maintained CalDAV/CardDAV client in npm |
| EteSync | `etebase` (`^0.43`) | First-class Etebase SDK; same one `ete-stethic` uses |
| CLI | `commander` | Mature subcommand support; Python's argparse equivalent |
| Logging | `pino` | Structured, JSON-by-default, fast; mirrors `log.py`'s posture |
| Testing | `node:test` + `tsx` | No Jest, no ts-jest config; runs `*.test.ts` directly |

---

## Phase plan (one phase = one commit, roughly)

| # | Phase | Deliverable |
|---|---|---|
| 0 | **Bootstrap** | `package.json`, `tsconfig.json`, `.gitignore`, README, this PLAN |
| 1 | **Models + config** | `Event`, content-hash, TOML/env resolution, XDG paths |
| 2 | **Logging** | `log.ts` thin wrapper |
| 3 | **Store** | SQLite schema (backend-agnostic columns: `remote_id`, `remote_etag`), Store class, smoke tests |
| 4 | **Auth** | Playwright capture + session load + silent-refresh |
| 5 | **Fetch** | OWA `FindItem` paging, chunked `GetItem`, parse → `Event` |
| 6 | **Differ** | Pure-logic diff, port the freeze-past + window-scoped delete rules; tests |
| 7 | **ICS render** | `Event` → iCalendar bytes, including the Outlook-specific fields the Python version handles |
| 8 | **Backend interface** | `Backend` interface + `openBackend(cfg)` factory |
| 9 | **CalDAV backend** | `tsdav` implementation; tombstone-retry behaviour preserved |
| 10 | **Etebase backend** | `etebase` SDK implementation + login subcommand |
| 11 | **Orchestrator + CLI** | `sync-once`, `fix-errors`, `export-ics`, `probe`, `login`, `diagnose`, `setup-timer` |
| 12 | **Systemd timer** | unit generation, parity with the Python `timer.py` |
| 13 | **Docs** | README + config-example.toml + example service section |
| 14 | **Migration** | One-shot tool: import `events.sqlite` from the Python repo so cutover preserves push history |

Each phase should land independently runnable in some sense (tests pass,
imports resolve, the slice it owns is exercised by at least one test or by
the next phase's smoke run).

---

## State directory layout (target)

Same XDG-aware shape as the Python version, so users can keep a single
`~/.local/state/outlook-sync/` directory across the cutover:

```
~/.local/state/outlook-sync/
├── bearer.json        # OWA Bearer JWT — written by auth/capture
├── cookies.json       # Browser cookies replayed on every API call
├── profile/           # Playwright user-data dir (MFA trusted-device cookie)
├── events.sqlite      # Local mirror; columns generalised to remote_id/remote_etag
└── etebase.bin        # Saved Etebase Account blob, mode 600 (NEW)
```

`config.toml` lives at `~/.config/outlook-sync/config.toml` as before.

---

## Backend selection (target shape)

```toml
[sync]
backend = "etebase"          # default; "caldav" still supported

[etebase]
server_url     = "https://api.etebase.com"
username       = "you@example.com"   # for diagnostics; not required for restore
collection_uid = "<filled-by-login-etebase>"

[caldav]
url      = "http://localhost:37358/<account>/<calendar-id>/"
username = "..."
password = "..."
```

Default is `"etebase"` from day one of the rewrite — there is no historic
caldav-only deployment for this codebase to be backwards-compatible with.

---

## Migration from the Python repo

A one-shot `import-legacy` command (Phase 14) reads
`~/.local/state/outlook-sync/events.sqlite` from the Python project,
maps `caldav_href` → `remote_id`, `caldav_etag` → `remote_etag`, and
populates the new schema. After that, the next normal sync sees the
existing rows and only pushes deltas — no full re-upload of years of
history.

---

## Out of scope (for now)

* Cross-platform support (Windows, macOS) — Linux/systemd only, mirroring the
  Python version's footprint.
* GUI / Tauri integration with `ete-stethic`.
* Multi-account / multi-calendar support — one Outlook → one EteSync calendar
  per install, same as today.
* Switching away from Playwright (e.g. to a headless capture without a real
  browser); the MSAL flow still requires a real Chromium.

---

## Cutover criteria

The Python repo gets archived (read-only) only once the Node version:

1. Has run unattended for ≥1 week against the same Outlook tenant.
2. Has migrated and synced the user's `events.sqlite` without dropping rows.
3. Has parity for: `sync-once`, `fix-errors`, `export-ics`, `setup-timer`,
   `login`, `probe`, `diagnose`.
4. Has the README + example systemd units in place.

Until then the Python tool keeps the user's calendar in sync.
