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
| **10. Etebase backend (etebase npm SDK)** | **← next** |
| 11+. CLI / timer / docs / migration | not started |

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

## Phase 10 (Etebase backend) — what to read before starting

The Python tool doesn't have an Etebase backend (its PyPI `etebase`
package no longer builds — that's the whole reason for this
rewrite). The reference shape is the `Backend` interface and the
existing CalDAV implementation; PLAN.md picks the npm `etebase`
package (^0.43) and notes that `ete-stethic` already uses it.

Sketch:
- A `login` subcommand (lands in phase 11 with the CLI) persists a
  saved Account blob to `cfg.etebaseBlobFile` (mode 600) and the
  resolved collection UID into config.
- `EtebaseBackend.open(cfg)` restores the Account from the blob,
  opens the collection by UID, and binds it to a connected client.
- Items are stored with the VCALENDAR string as the content and the
  Exchange itemId as the item-meta UID; the Etebase item UID itself
  is what we persist as `remote_id`.
- `remote_etag` maps to the Etebase item's `etag` (it's already an
  opaque string the SDK round-trips for conditional updates).

Wire `openBackend(cfg)` to dynamic-import `./backends/etebase.js`
the same way CalDAV does, to keep the `etebase` dep off the path of
commands that don't push.

**Carrying over from earlier phases:**
- Bearer JSON key set is fixed (`token`, `expires_on`, `tenant_id`,
  `anchor_mailbox`, `scopes`, `cached_at`, `msal_key`); Python's
  `outlook_sync.auth.session` reads the same keys.
- `auth/session.callService()` is the only path that should hit
  `service.svc`.
- `fetch/owa.fetchCalendarView(session, cfg, start, end)` is the
  production entry point; tests use `fetchCalendarViewWith(call, ...)`
  with an injected `ServiceCaller` so no HTTP is involved.
- `sync/differ.computeDiff(events, rows, opts)` is pure logic;
  orchestrator binds it as
  `computeDiff(freshEvents, store.iterRows(), { fetchStart, fetchEnd })`.
- `sync/ics.renderEvent(event)` returns a complete VCALENDAR string;
  pass `{ now }` in tests to pin DTSTAMP.
- `sync/backend.Backend` is the interface; `openBackend(cfg)` is the
  factory. CalDAV is wired up via `./backends/caldav.js`; mirror that
  pattern for Etebase.
- `tsdav` is imported as a default + destructure (`import tsdav from
  "tsdav"; const { createCalendarObject, … } = tsdav;`) because
  tsx-under-Node-22 wraps its CJS export as a default. The same
  pattern is likely needed for any other CJS-only dep.

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
