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

// Pinned golden values: if either changes the serialisation shape of
// contentHash() or caldavUid() drifted. The differ uses contentHash
// to decide what to push, and the backends key items by caldavUid —
// breaking either would make every event re-push on the next sync.
const EXPECTED_CONTENT_HASH =
  "d0fb97b8eee7e1d3488e93ea6944e85c05cc0855a869419465fb93d23f91a524";
const EXPECTED_CALDAV_UID =
  "ocs-e2d4768b3472b90ca749600da34e6221@ete-look-sync";

test("contentHash matches the pinned shape", () => {
  assert.equal(contentHash(sample), EXPECTED_CONTENT_HASH);
});

test("caldavUid matches the pinned shape", () => {
  assert.equal(caldavUid(sample), EXPECTED_CALDAV_UID);
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
