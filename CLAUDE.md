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
| **4. Auth (Playwright + MSAL capture)** | **← next** |
| 5+. Fetch / differ / ICS / backends / CLI / timer / docs / migration | not started |

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
and `PYTHON_CALDAV_UID` constants).

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

## Phase 4 (auth) — what to read before starting

Reference Python sources, in this order:

1. `outlook-calendar-scraper-sync/src/outlook_sync/auth/capture.py` —
   the Playwright MSAL flow. Watches for OWA's MSAL JS cache writes,
   extracts the Bearer JWT (`aud = https://outlook.office.com`), saves
   bearer.json + cookies.json + the user-data dir.

2. `outlook-calendar-scraper-sync/src/outlook_sync/auth/session.py` —
   loads bearer.json, checks expiry, exposes a `requests`-style client.
   In TS this becomes a thin wrapper around `fetch()` that injects the
   bearer + cookies on every call.

3. The orchestrator's `_maybe_silent_refresh()` in `sync/orchestrator.py`
   — runs Playwright headless to refresh the token before sync if it's
   <2h from expiry. Critical for unattended systemd operation.

**Bearer file format must remain readable by the Python tool** during
the cutover window: same JSON keys (`access_token`, `expires_on`,
`anchor_mailbox`, etc.). Don't reorganize.

**Heavy step warning:** phase 4 starts with `npm install playwright`
followed by `npx playwright install chromium`, which downloads ~200 MB.
Don't run those in a tight loop.

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
