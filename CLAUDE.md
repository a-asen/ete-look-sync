# CLAUDE.md — orientation for AI sessions picking this up cold

For the project's *roadmap*, read [`PLAN.md`](PLAN.md) — it has the
Python→TypeScript module map, library choices, and full 15-phase plan.
This file is just the operational stuff a fresh session would otherwise
have to re-derive.

---

## Current status

| Phase | Status |
|---|---|
| 0. Bootstrap | ✅ done |
| 1. Models + config | ✅ done |
| 2. Logger | ✅ done |
| 3. Store | ✅ done |
| 4. Auth (Playwright + MSAL capture) | ✅ done |
| 5. Fetch (OWA FindItem + GetItem → Event) | ✅ done |
| 6. Differ (freeze-past + window-scoped delete rules) | ✅ done |
| 7. ICS render (Event → iCalendar bytes) | ✅ done |
| 8. Backend interface + factory | ✅ done |
| 9. CalDAV backend (tsdav) | ✅ done |
| 10. Etebase backend (etebase npm SDK) | ✅ done |
| 11. Orchestrator + CLI subcommands | ✅ done |
| 12. Systemd timer | ✅ done |
| 13. Docs (README + config example + service example) | ✅ done |
| **14. Migration tool (import legacy events.sqlite)** | **← next** |

`git log --oneline` is the source of truth. All tests green
(`npm test`); typecheck and build clean.

---

## Sibling Python repo (the source we're porting from)

```
/home/steff/Documents/Github/outlook-calendar-scraper-sync/
```

This is the *working* tool the user runs daily. **Do not modify it as
part of the rewrite.** It stays the production version until cutover
(see PLAN.md → "Cutover criteria"). Read it freely as reference.

The Python conda env (used for cross-language verification, see below):

```bash
source ~/miniconda3/etc/profile.d/conda.sh && conda activate outlook-sync
```

---

## Tooling gotchas (real things that bit me)

1. **CWD resets between Bash tool calls.** Always prefix:
   ```
   cd /home/steff/Documents/Github/etesync-outlook-calendar-sync && <cmd>
   ```
   Don't trust an earlier `cd` to persist.

2. **Use `.js` extension in `import` statements, not `.ts`.**
   tsconfig is NodeNext + strict; `import "./foo.ts"` errors with TS5097.
   Source files are `.ts`; imports reference them as `.js`. tsx resolves
   at runtime, tsc passes the `.js` through to `dist/`.

3. **Use the npm scripts, not raw `npx`:**
   - `npm run typecheck` — `npx tsc` resolves to a SQUATTED package on
     npm called `tsc` (not the TypeScript compiler).
   - `npm test` — `npx tsx --test "src/**/*.test.ts"` doesn't glob;
     finds zero tests.
   - `npm run build` — emits to `dist/`.
   - `npm run dev` — runs `src/cli.ts` via tsx.

4. **Tests use `node:test` + `assert.strict`.** No Jest, no Vitest.
   Sample test scaffolding lives in `src/*.test.ts` — copy patterns
   from the existing files (`tempDb()`, `withIsolatedEnv()`, the
   `process.stderr.write` override in `log.test.ts`).

---

## Cross-language compatibility (the migration concern)

`contentHash()` and `caldavUid()` in `src/models.ts` produce **byte-for-byte
identical** output to their Python counterparts. This is verified and
pinned by golden values in `src/models.test.ts` (the `PYTHON_CONTENT_HASH`
and `PYTHON_CALDAV_UID` constants) and reinforced by an end-to-end
parity test in `src/fetch/parse.test.ts` (the `PYTHON_PARSED_*`
constants) that runs a real OWA dict through both parsers and asserts
they agree.

**Why this matters:** the migration tool in phase 14 reads the user's
existing Python `events.sqlite` and imports rows. If TS hashes diverge
from Python's, every imported event looks "changed" and gets re-pushed
on the next sync — wiping the entire push history.

**To verify against Python for any new shared logic:**

```bash
cd /home/steff/Documents/Github/outlook-calendar-scraper-sync && \
  source ~/miniconda3/etc/profile.d/conda.sh && conda activate outlook-sync && \
  python -c "from outlook_sync.models import Event; e = Event(...); print(e.content_hash)"
```

Any function that touches data crossing the migration boundary
(currently: hash, UID; later: ICS rendering, possibly the JSON we put
in `record_json`) needs this same treatment.

---

## Phase 14 (migration) — what to read before starting

One-shot importer: read the Python tool's `events.sqlite` and
populate the new schema so cutover preserves push history.

Mapping:
- `item_id`     → `item_id`         (unchanged; primary key)
- `change_key`  → `change_key`
- `content_hash` → `content_hash`   (must remain valid — that's why
  parse + ICS parity is pinned in tests)
- `caldav_uid`  → `caldav_uid`
- `caldav_href` → `remote_id`       (CalDAV-only legacy)
- `caldav_etag` → `remote_etag`
- start_iso, subject, last_modified_iso, first_seen_at, last_seen_at,
  last_pushed_at, push_error → carry over verbatim.
- `backend`     → `"caldav"`        (legacy rows were all CalDAV)
- `record_json` is rebuilt from the legacy column values where
  possible, else default-filled.

Wire as a `migrate-legacy` (or `import-legacy`) CLI subcommand that
takes the legacy DB path. After import, on the next sync the TS
hash must equal the stored hash → row stays unchanged → no
re-push.

**Carrying over from earlier phases (the runtime contract):**
- `auth/session.callService(session, cfg, action, body)` is the
  only path to `service.svc`.
- `fetch/owa.fetchCalendarView(session, cfg, start, end)` is the
  production entry; tests use `fetchCalendarViewWith(call, …)`.
- `sync/differ.computeDiff(events, rows, opts)` is pure logic.
- `sync/ics.renderEvent(event)` returns a VCALENDAR string.
- `sync/backend.openBackend(cfg)` lazy-imports the configured
  backend; both `./backends/caldav.js` and `./backends/etebase.js`
  are wired up.
- `sync/orchestrator.runSyncOnce(cfg, opts)` and `runFixErrors(cfg,
  opts)` are the orchestrator entry points; both have `*With`
  variants that take a `SyncDeps` stub for tests.
- CLI is `src/cli.ts` (commander). Subcommands:
  `login`, `login-etebase`, `probe`, `sync-once`, `fix-errors`,
  `export-ics`, `setup-timer`, `remove-timer`, `diagnose` (stub).
- `timer.runSetupTimer(cfg, { dryRun? })` writes the systemd units;
  `runRemoveTimer()` undoes it. The bin path is resolved with
  `which outlook-sync` and falls back to `process.argv[1]`.

---

## Conventions in TS code (so far)

- **Free functions over methods** for stateless logic (e.g. `contentHash(event)`,
  not `event.contentHash`). Class only for resources with lifecycle (`Store`).
- **Interfaces, not classes**, for plain data (`Event`, `StoredRow`, `Config`).
- **Strict mode is loud**: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`. Don't relax tsconfig
  to make a type error go away — narrow the type instead.
- **Don't add a runtime dep without a justification in the commit.**
  Each phase's commit message names the new dep and why.
- **No comments that explain *what* the code does** — well-named
  identifiers carry that. Comment *why* something is non-obvious
  (e.g. `models.ts`'s note about Python `json.dumps` separator quirks).
