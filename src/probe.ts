// Smoke probe: confirm a saved session can read the calendar end-to-end.
//
// Two requests, in order, because they tell us different things when
// they fail:
//
//   1. GetOwaUserConfiguration — cheapest authenticated call OWA
//      supports. If this 401s the captured cookies or bearer are
//      stale and nothing else will work; short-circuit with a clear
//      hint.
//
//   2. fetchCalendarView for the next seven days — exercises exactly
//      the production fetch path the periodic sync uses, so a green
//      probe means parser, pagination, and Event construction all
//      work.

import { callService, loadSession, SessionExpired, SessionNotCaptured } from "./auth/session.js";
import { loadConfig } from "./config.js";
import { fetchCalendarView, FetchError } from "./fetch/owa.js";

export async function runProbe(): Promise<number> {
  const cfg = loadConfig();
  let session;
  try {
    session = loadSession(cfg);
  } catch (err) {
    if (err instanceof SessionNotCaptured || err instanceof SessionExpired) {
      process.stderr.write(`[probe] ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  process.stdout.write(
    `[probe] bearer anchor=${session.bearer.anchor_mailbox ?? ""}\n`,
  );

  const cfgResp = await callService(session, cfg, "GetOwaUserConfiguration", {
    __type: "GetOwaUserConfigurationJsonRequest:#Exchange",
  });
  await printResponseDiagnostics("GetOwaUserConfiguration", cfgResp);
  if (cfgResp.status !== 200) {
    process.stdout.write("\n[probe] auth ping failed — do NOT trust later calls. Re-run login.\n");
    return 1;
  }

  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const end = new Date(now.getTime() + 7 * 86400_000);
  let events;
  try {
    events = await fetchCalendarView(session, cfg, now, end);
  } catch (err) {
    if (err instanceof FetchError) {
      process.stderr.write(`\n[probe] fetch failed: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  process.stdout.write(`\n# fetchCalendarView (next 7d): ${events.length} events parsed\n`);
  if (events.length > 0) {
    const starts = events.map((e) => e.startIso).sort();
    process.stdout.write(
      `  date range: ${starts[0]!.slice(0, 16)}  →  ${starts[starts.length - 1]!.slice(0, 16)}\n`,
    );
    for (const ev of events.slice(0, 20)) {
      const loc = ev.location ? `  @ ${ev.location}` : "";
      process.stdout.write(`   - ${ev.startIso.slice(0, 16)}  ${ev.subject}${loc}\n`);
    }
  }
  return 0;
}

async function printResponseDiagnostics(label: string, resp: Response): Promise<void> {
  const text = await resp.text();
  process.stdout.write(`\n# ${label}: HTTP ${resp.status}  (${text.length} bytes)\n`);
  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    process.stdout.write(`  content-type=${JSON.stringify(ct)}  (not JSON — likely a login redirect page)\n`);
    process.stdout.write(text.slice(0, 400) + "\n");
    return;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch (err) {
    process.stdout.write(`  failed to parse JSON: ${String(err)}\n`);
    process.stdout.write(text.slice(0, 400) + "\n");
    return;
  }
  const body = (data["Body"] as Record<string, unknown> | undefined) ?? {};
  const keys = Object.keys(body).sort().slice(0, 10);
  process.stdout.write(`  Body keys: [${keys.join(", ")}]\n`);
  if (body["ExceptionName"]) {
    process.stdout.write(JSON.stringify(body, null, 2).slice(0, 600) + "\n");
  }
}
