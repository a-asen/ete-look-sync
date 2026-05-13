import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { Config } from "../config.js";
import type { Event } from "../models.js";
import {
  type Backend,
  BackendConfigError,
  openBackend,
  type PushResult,
} from "./backend.js";

// Minimal Config that exercises only the fields openBackend reads.
// We don't call loadConfig here because we'd rather not depend on
// XDG paths or file IO in this test.
function cfg(backend: Config["backend"]): Config {
  return {
    stateDir: "/tmp",
    profileDir: "/tmp",
    cookiesFile: "/tmp/c",
    bearerFile: "/tmp/b",
    dbFile: "/tmp/db",
    etebaseBlobFile: "/tmp/e",
    owaBaseUrl: "",
    backend,
    etebaseServerUrl: "",
    etebaseUsername: "",
    etebaseCollectionUid: "",
    caldavUrl: "",
    caldavUsername: "",
    caldavPassword: "",
    caldavCalendarName: "",
    daysBack: 0,
    daysForward: 0,
    freezePastDays: 0,
    intervalMinutes: 0,
  };
}

test("openBackend(etebase) throws BackendConfigError pending phase 10", async () => {
  await assert.rejects(
    () => openBackend(cfg("etebase")),
    (err: unknown) => {
      assert.ok(err instanceof BackendConfigError);
      assert.match((err as Error).message, /phase 10/);
      return true;
    },
  );
});

test("openBackend(caldav) errors when caldavUrl is unset", async () => {
  // CalDAVBackend.open requires `caldavUrl` — our `cfg()` helper
  // builds a Config with an empty URL, so this should fail with a
  // helpful "url is unset" message rather than crashing on the
  // network.
  await assert.rejects(
    () => openBackend(cfg("caldav")),
    (err: unknown) => {
      assert.ok(err instanceof BackendConfigError);
      assert.match((err as Error).message, /caldav\.url is unset/);
      return true;
    },
  );
});

test("BackendConfigError is an Error subclass with a stable name", () => {
  const err = new BackendConfigError("nope");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "BackendConfigError");
});

// Type-level sanity: a plausible mock satisfies the Backend interface.
// If the interface drifts in a way that breaks downstream backends,
// this test will fail to typecheck before it fails at runtime.
test("Backend interface accepts a minimal mock implementation", async () => {
  class FakeBackend implements Backend {
    pushes: Array<{ itemId: string; existingId: string | undefined }> = [];
    deletes: string[] = [];
    closed = false;

    async upsert(event: Event, opts?: { existingId?: string }): Promise<PushResult> {
      this.pushes.push({ itemId: event.itemId, existingId: opts?.existingId });
      return { remoteId: "rid-" + event.itemId, remoteEtag: "etag-1" };
    }

    async delete(remoteId: string): Promise<void> {
      this.deletes.push(remoteId);
    }

    close(): void {
      this.closed = true;
    }
  }

  const b = new FakeBackend();
  const r1 = await b.upsert(makeEvent("a"));
  assert.equal(r1.remoteId, "rid-a");
  const r2 = await b.upsert(makeEvent("b"), { existingId: "rid-b-old" });
  assert.equal(b.pushes[1]!.existingId, "rid-b-old");
  await b.delete("rid-a");
  assert.deepEqual(b.deletes, ["rid-a"]);
  b.close();
  assert.equal(b.closed, true);
  assert.equal(r2.remoteEtag, "etag-1");
});

function makeEvent(id: string): Event {
  return {
    itemId: id,
    changeKey: "ck",
    subject: "s",
    startIso: "2026-01-01T00:00:00Z",
    endIso: "2026-01-01T01:00:00Z",
    isAllDay: false,
    location: "",
    bodyText: "",
    organizerEmail: "",
    organizerName: "",
    attendees: [],
    isRecurring: false,
    isCancelled: false,
    lastModifiedIso: "",
    webLink: "",
  };
}
