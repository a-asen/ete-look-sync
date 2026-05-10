import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, contentHash, type Event } from "./models.js";

const sample: Event = {
  itemId: "AAA=",
  changeKey: "ck1",
  subject: "Stand-up — møte",
  startIso: "2026-05-10T09:00:00",
  endIso: "2026-05-10T09:30:00",
  isAllDay: false,
  location: "Room 4.124",
  bodyText: "Daily sync.\nAgenda: Q&A",
  organizerEmail: "alice@example.com",
  organizerName: "Alice",
  attendees: ["bob@example.com", "carol@example.com"],
  isRecurring: true,
  isCancelled: false,
  lastModifiedIso: "2026-05-09T15:00:00",
  webLink: "https://outlook.cloud.microsoft/...",
};

// These golden values were computed by the Python implementation in the
// predecessor repo against the same `sample` event (modulo field naming).
// If either of these assertions ever fails, byte-for-byte cross-language
// compatibility has broken — the migration tool in phase 14 will then
// see every imported event as "changed" and re-push the entire history.
const PYTHON_CONTENT_HASH =
  "d0fb97b8eee7e1d3488e93ea6944e85c05cc0855a869419465fb93d23f91a524";
const PYTHON_CALDAV_UID =
  "ocs-e2d4768b3472b90ca749600da34e6221@outlook-sync";

test("contentHash matches the Python implementation byte-for-byte", () => {
  assert.equal(contentHash(sample), PYTHON_CONTENT_HASH);
});

test("caldavUid matches the Python implementation byte-for-byte", () => {
  assert.equal(caldavUid(sample), PYTHON_CALDAV_UID);
});

test("contentHash is deterministic", () => {
  assert.equal(contentHash(sample), contentHash(sample));
});

test("contentHash ignores fields the user cannot see", () => {
  const noisy: Event = {
    ...sample,
    changeKey: "different",
    lastModifiedIso: "1999-01-01T00:00:00",
    webLink: "https://example.invalid/other",
    raw: { junk: "ignored" },
  };
  assert.equal(contentHash(noisy), contentHash(sample));
});

test("contentHash changes when a user-visible field changes", () => {
  const renamed: Event = { ...sample, subject: "Stand-up — moved" };
  assert.notEqual(contentHash(renamed), contentHash(sample));
});

test("caldavUid is stable for the same itemId", () => {
  assert.equal(caldavUid(sample), caldavUid(sample));
});

test("caldavUid differs for different itemIds", () => {
  const other: Event = { ...sample, itemId: "BBB=" };
  assert.notEqual(caldavUid(other), caldavUid(sample));
});
