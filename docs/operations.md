# Operating `ete-look-sync` as a service

How to install the periodic sync as a systemd user service, what it
does unattended, and how to monitor its health.

This is the operator's reference. For what the tool *is*, see the
[README](../README.md).

---

## 1. Install the service

The timer runs the **globally installed** `ete-look-sync` binary (it
resolves the absolute path via `which` at setup time and pins it into
the unit). So a code change isn't live until you reinstall and
regenerate the units:

```bash
npm i -g .                  # publish the build to the global shim
ete-look-sync login         # capture a fresh OWA session (interactive)
ete-look-sync setup-timer   # write + enable the systemd units
ete-look-sync sync-once     # verify immediately, don't wait for a tick
```

- `login` opens a real Chromium. It is **required** before the timer
  is useful, and again whenever the saved session can no longer be
  refreshed silently (see §3).
- `setup-timer` is idempotent — re-run it after any reinstall to
  regenerate the units. Preview first with
  `ete-look-sync setup-timer --dry-run`.

### What gets installed

Three units in `~/.config/systemd/user/`:

| Unit | Role |
|---|---|
| `ete-look-sync.timer` | Fires on a clock boundary every `interval_minutes` (default 30). `Persistent=true` catches up one missed run after suspend/shutdown. |
| `ete-look-sync.service` | `oneshot` that runs `ete-look-sync sync-once`. Has `OnFailure=ete-look-sync-notify.service`. |
| `ete-look-sync-notify.service` | `oneshot` triggered **only** when a sync exits non-zero. Fires a critical `notify-send` desktop popup pointing at `ete-look-sync login`. Degrades to a no-op if `notify-send` isn't installed. |

Remove everything with `ete-look-sync remove-timer` (stops, disables,
deletes all three units, reloads systemd).

### Custom config + state locations

By default config lives in `~/.config/ete-look-sync/config.toml` and
state in `~/.local/state/ete-look-sync/`. Override either with an
environment variable:

| Variable | Overrides |
|---|---|
| `ETE_LOOK_SYNC_CONFIG` | Full path to the `config.toml` file. |
| `ETE_LOOK_SYNC_STATE_DIR` | Directory holding the browser profile, cookies, bearer token, sqlite DB, and Etebase blob. |

A systemd user service starts with a stripped environment, so
`setup-timer` **pins whatever paths are in effect at setup time** into
the `.service` unit as `Environment=` lines (the same way it pins the
absolute bin/node paths). Set the vars in your shell *before* running
`setup-timer`, and re-run `setup-timer` if you later move the paths.
Confirm what got baked in with `setup-timer --dry-run`.

---

## 2. How a run behaves unattended

Each timer tick runs `sync-once`, which:

1. **Attempts a silent token refresh first.** If the saved bearer is
   within ~2h of expiry, it replays the persistent Chromium profile
   *headlessly* to mint a fresh token — no human involvement. If the
   token still has headroom this is a fast no-op.
2. Loads the session and runs the diff-only sync.
3. On **any** non-zero exit, systemd's `OnFailure=` fires the notify
   unit → you get a desktop notification.

The practical effect: routine token expiry **self-heals**. You only
need to act when silent refresh *can't* recover — which is when
Microsoft forces a fresh MFA interaction (the profile's
trusted-device session has aged out). That is the one case the
notification is for.

---

## 3. Monitoring

### Is it scheduled and when does it run next?

```bash
systemctl --user list-timers ete-look-sync.timer
```

Shows `NEXT` (next fire), `LAST` (last fire), and `PASSED`. If the
timer is missing here, it isn't enabled — re-run `setup-timer`.

### Is the timer healthy?

```bash
systemctl --user status ete-look-sync.timer
```

Expect `Active: active (waiting)`. The **timer** stays active even
when individual runs fail — don't mistake a failed `.service` for a
dead timer.

### Did the last run succeed?

```bash
systemctl --user status ete-look-sync.service
```

- `Active: inactive (dead)` with `status=0/SUCCESS` on the last
  `ExecStart` → last run was fine (a `oneshot` is *meant* to go
  inactive after finishing).
- `Active: failed` / `status=1/FAILURE` → last run failed; read the
  logs below.

### Logs

```bash
# Live tail
journalctl --user -u ete-look-sync.service -f

# Last run only, newest at the bottom
journalctl --user -u ete-look-sync.service -e

# Last 24h
journalctl --user -u ete-look-sync.service --since "1 day ago"

# Just the failures
journalctl --user -u ete-look-sync.service -p err
```

A healthy run logs the sync window and per-phase counts. The two
signals that mean **act now**:

```
ERROR [sync] Saved bearer token is expired (exp=…). Run `ete-look-sync login` to refresh.
[sync] silent refresh failed — MFA interaction required.
```

Both mean silent refresh couldn't recover → run `ete-look-sync login`.

### The failure notification

When a run fails you should see a critical desktop popup ("Outlook
calendar sync failed …"). It is best-effort: it needs `notify-send`
(package `libnotify-bin` on Debian/Ubuntu) and a reachable desktop
session bus. If you run headless or don't see popups, rely on the
journal instead — `OnFailure` still fires, the notify command just
no-ops. To check the notify unit itself:

```bash
systemctl --user status ete-look-sync-notify.service
journalctl --user -u ete-look-sync-notify.service -e
```

### On-demand health check

```bash
systemctl --user start ete-look-sync.service   # run a sync right now
ete-look-sync probe                            # session smoke-test + 7-day fetch
```

`probe` is the fastest way to confirm the saved session still talks to
`service.svc` without performing a full sync.

---

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `.service` failed; log says **token expired** or **silent refresh failed — MFA required** | Trusted-device session aged out; silent refresh can't recover | `ete-look-sync login`, then `ete-look-sync sync-once` |
| Every run fails right after a code change | Timer still runs the old global binary | `npm i -g .` then `ete-look-sync setup-timer` |
| Timer not in `list-timers` | Units not enabled | `ete-look-sync setup-timer` |
| Runs fail but no desktop popup | `notify-send` missing or no session bus | Install `libnotify-bin`; meanwhile monitor via `journalctl` |
| `setup-timer` says it can't locate the executable | No global install on `PATH` | `npm i -g .` from the repo |
| Sync aborts refusing to delete everything | Upstream fetch returned zero events (safety guard) | Expected; investigate connectivity. Override only if intentional with `--allow-empty-fetch` |

### Escalation path

1. `systemctl --user status ete-look-sync.service` — failed or just inactive?
2. `journalctl --user -u ete-look-sync.service -e` — read the actual error.
3. Token/MFA error → `ete-look-sync login`.
4. Still failing → `ete-look-sync probe` to isolate session vs. backend.
5. Capture a full run for a bug report:
   `systemctl --user start ete-look-sync.service && journalctl --user -u ete-look-sync.service -e`

---

## 5. Source-of-truth mirror (`mirror_foreign`)

By default the sync only deletes items it created (UID ends
`@ete-look-sync`); anything else in the collection is treated as a real
event and left alone. Set `mirror_foreign = true` (env
`ETE_LOOK_SYNC_MIRROR_FOREIGN`) to make the collection a **strict
mirror of the source calendar** within the managed window
(`days_back` past … `days_forward` future):

- Any remote item in the window that does not correspond to a fetched
  Outlook event is **deleted, regardless of who created it** (a
  previous tool, a manual entry, an old duplicate).
- Remote items that DO match a source event are adopted (recorded
  against the event) so later edits update them in place instead of
  re-creating.
- Matching is by content — subject + start + end — computed the same
  way from an Outlook event and from a remote ICS.
- The window IS the freeze: past events within `days_back` are
  eligible too, so late cancellations/reschedules land.
- Anything outside the window is untouched.

Deletion is aggressive: foreign/manual future entries in the window are
removed. There is no per-item "keep" override — the source calendar is
the single source of truth.

Preview it safely before turning it on:

```bash
ete-look-sync sync-once --dry-run   # shows "would delete (mirror — not in source)"
```

The empty-fetch safety guard covers the prune pass too: if Exchange
returns zero events, nothing is deleted unless `--allow-empty-fetch` is
passed, so a failed/oversized window can't wipe the calendar.
