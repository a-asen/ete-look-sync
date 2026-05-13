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
| **8. Backend interface + factory** | **← next** |
| 9+. CalDAV / Etebase backends / CLI / timer / docs / migration | not started |

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

## Phase 8 (backend interface) — what to read before starting

Reference Python source:
`outlook-calendar-scraper-sync/src/outlook_sync/sync/backend.py`.

The `Backend` interface is the seam between the orchestrator (which
owns the diff + store) and a concrete protocol (CalDAV in phase 9,
Etebase in phase 10). At minimum it needs to:

- open / authenticate (per backend type)
- create an item from an ICS payload, returning (remoteId, remoteEtag)
- update an item by (remoteId, remoteEtag), returning new etag
- delete an item by (remoteId, remoteEtag), tolerating "already gone"

Plus a factory `openBackend(cfg)` that picks CalDAV vs Etebase from
`cfg.backend`. The interface should be thin enough that both real
backends and the orchestrator's tests can implement it without
contortions.

No on-disk state belongs in this phase — that arrives with each
concrete backend. The store's `remote_id` / `remote_etag` / `backend`
columns already exist and are the only persistence layer the
interface needs to know about.

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
