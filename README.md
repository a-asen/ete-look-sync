# etesync-outlook-calendar-sync

Headless mirror of an Outlook (Microsoft 365 / OWA) calendar to a
personal EteSync calendar — or any CalDAV server.

Node/TypeScript rewrite of
[`ete-look-sync--py--old`](https://github.com/a-asen/ete-look-sync--py--old)
(Python). Same goal, but built around the actively-maintained
`etebase` npm SDK instead of the abandoned Python one. The Etebase
backend is the default; CalDAV is also supported.

> The CLI binary is **`ete-look-sync`** (a portmanteau of EteSync +
> Outlook). State lives in `~/.local/state/ete-look-sync/`, config in
> `~/.config/ete-look-sync/`, and every environment variable is named
> `ETE_LOOK_SYNC_*`.

## How it works

1. A one-time `ete-look-sync login` opens a real Chromium via
   Playwright, drives Microsoft's sign-in flow, and saves the cookies
   plus the MSAL Bearer token to `~/.local/state/ete-look-sync/`.
2. Every `ete-look-sync sync-once` replays that session against
   `service.svc`, fetches all events in a rolling
   (`days_back`/`days_forward`) window, and pushes only the changes
   to the configured backend.
3. A local SQLite mirror tracks what's been pushed so re-runs are
   diff-only. Past events older than `freeze_past_days` are never
   touched once they've landed.

The orchestrator never sees CalDAV hrefs or Etebase item UIDs — both
backends sit behind the same `(remoteId, remoteEtag)` interface.

## Requirements

- Node ≥ 22 (uses native `fetch`, `node:util.parseArgs`, etc.)
- Linux + systemd if you want the periodic timer (the only OS we
  currently generate units for; the CLI itself is cross-platform).
- For the **Etebase** backend: an EteSync account with at least one
  `etebase.vevent` collection.
- For the **CalDAV** backend: any CalDAV server — `etesync-dav`
  exposing one URL per calendar is the original target shape.

## Install

```bash
git clone https://github.com/<you>/etesync-outlook-calendar-sync.git
cd etesync-outlook-calendar-sync
npm install
npm run build
npm install -g .     # puts `ete-look-sync` on $PATH

# One-time Playwright browser download:
npx playwright install chromium
```

## Configure

Copy the example and fill in the bits you need:

```bash
mkdir -p ~/.config/ete-look-sync
cp config-example.toml ~/.config/ete-look-sync/config.toml
chmod 600 ~/.config/ete-look-sync/config.toml
```

The file is optional — every setting also has an environment
variable. See `config-example.toml` for the full list. Defaults are
sane for the common case (Etebase backend, 7d/365d sync window,
30-minute timer).

## First-time login

You need two logins: Microsoft (for the OWA bearer token) and Etebase
(for the destination collection). Both produce on-disk state in
`~/.local/state/ete-look-sync/`.

```bash
# 1. Microsoft sign-in — opens a browser window.
ete-look-sync login

# 2. Etebase server + collection picker — only if backend = "etebase".
ete-look-sync login-etebase
```

The `login-etebase` command prints a `[etebase]` block to copy into
your `config.toml` (the chosen `collection_uid` in particular).

## Run a sync

Always start with a dry run to see the plan:

```bash
ete-look-sync sync-once --dry-run
```

Once that looks right:

```bash
ete-look-sync sync-once
```

Common flags:

- `--days-back N` / `--days-forward N` — override the window for a
  one-off run.
- `--no-freeze-past` — push historical events too. Use **once** on
  initial backfill.
- `--allow-empty-fetch` — bypass the safety check that aborts when
  Exchange returns 0 events but local rows would be deleted (usually
  means the window was rejected silently).

## Periodic runs (systemd)

```bash
ete-look-sync setup-timer --dry-run   # preview unit files
ete-look-sync setup-timer             # install + enable
```

This writes **three** units to `~/.config/systemd/user/`: the
`.service`, the `.timer`, and an `ete-look-sync-notify.service` that
fires a desktop notification when a run fails. Before loading the
session each run also attempts a headless silent token refresh, so
routine token expiry self-heals without a manual `login`.

```ini
# ete-look-sync.service
[Unit]
Description=Outlook calendar → personal calendar sync (one-shot)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/ete-look-sync sync-once
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ete-look-sync
OnFailure=ete-look-sync-notify.service

[Install]
WantedBy=default.target
```

```ini
# ete-look-sync.timer
[Unit]
Description=Run ete-look-sync every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
```

Operate it like any user timer:

```bash
systemctl --user list-timers ete-look-sync.timer
journalctl --user -u ete-look-sync.service -f
systemctl --user start ete-look-sync.service   # run now
ete-look-sync remove-timer                     # uninstall (all 3 units)
```

For setup, unattended refresh behaviour, monitoring, and a
troubleshooting table, see **[docs/operations.md](docs/operations.md)**.

## Other subcommands

| Command            | What it does                                                     |
|--------------------|------------------------------------------------------------------|
| `probe`            | Smoke-test the saved session against `service.svc` + a 7-day fetch. |
| `fix-errors`       | Re-push events with a recorded `push_error`, no Exchange round-trip. |
| `export-ics PATH`  | Dump all locally stored events to a single `.ics` backup file.   |

## State directory

```
~/.local/state/ete-look-sync/
├── bearer.json        # OWA Bearer JWT — written by `login`
├── cookies.json       # Browser cookies replayed on every API call
├── profile/           # Playwright user-data dir (MFA trusted-device cookie)
├── events.sqlite      # Local mirror of pushed events
└── etebase.bin        # Saved Etebase Account blob, mode 600
```

`config.toml` lives at `~/.config/ete-look-sync/config.toml`. Both
locations honour `XDG_STATE_HOME` / `XDG_CONFIG_HOME` overrides.

## Backends

The same fetch/diff path feeds either backend. Switch with:

```toml
[sync]
backend = "etebase"   # or "caldav"
```

### Etebase (default)

- Pure end-to-end-encrypted: the server only sees ciphertext.
- Item UID stays stable across updates; ETag advances per revision.
- `login-etebase` writes the saved Account blob to
  `~/.local/state/ete-look-sync/etebase.bin` at mode 600.

### CalDAV

- Two URL shapes both work: a direct calendar URL (preferred for
  etesync-dav) or a server/principal URL + a `[caldav].calendar`
  display name.
- Tombstones (HTTP 500 on a re-used UID) trigger an automatic one-shot
  retry with a `-r2@ete-look-sync` UID suffix; the new href is then
  persisted as `remote_id` so subsequent updates skip the retry.

## Architecture

```
auth/capture (Playwright) ─► auth/session ─► fetch/owa
                                              │
                                              ▼
                                       sync/differ ◄─ store (SQLite)
                                              │
                                              ▼
                                       sync/orchestrator
                                              │
                                              ▼
                                       sync/backend
                                              ├── backends/etebase
                                              └── backends/caldav
                                                      └─ tsdav
```

Each phase has its own module + unit tests; `npm test` runs the full
suite. The orchestrator and backends both use dep-injection seams
(`SyncDeps`, `DavOps`, `EtebaseOps`) so the tests never touch real
HTTP.

## Determinism

`contentHash()` and `caldavUid()` (in `src/models.ts`) produce the
same output for the same `Event` on every run — the differ uses
`contentHash` to decide whether anything changed, and the backends
key items by `caldavUid`, so any silent drift in either would
trigger spurious re-pushes on the next sync. Both shapes are pinned
by golden values in `src/models.test.ts` and `src/fetch/parse.test.ts`
(full OWA-dict → Event round-trip).

## Development

```bash
npm run dev          # tsx src/cli.ts ...
npm test             # node:test + tsx, glob src/**/*.test.ts
npm run typecheck    # tsc --noEmit (strict, NodeNext, exact optional types)
npm run build        # tsc → dist/
```

See [`CLAUDE.md`](CLAUDE.md) for the operational gotchas (use `.js`
in imports, `npm run typecheck` not `npx tsc`, etc.).

## License

MIT.
