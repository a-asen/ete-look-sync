import { test } from "node:test";
import { strict as assert } from "node:assert";

import { caldavUid, contentHash } from "../models.js";
import { bodyToText, collectAttendees, parseEvent } from "./parse.js";

function htmlBody(value: string): Record<string, unknown> {
  return { BodyType: "HTML", Value: value };
}

function textBody(value: string): Record<string, unknown> {
  return { BodyType: "Text", Value: value };
}

test("parseEvent maps the OWA shape onto Event", () => {
  const event = parseEvent({
    ItemId: { Id: "AAA", ChangeKey: "BBB" },
    Subject: "Standup",
    Start: "2026-05-13T08:00:00Z",
    End: "2026-05-13T08:30:00Z",
    IsAllDayEvent: false,
    Location: { DisplayName: "Room 1" },
    Body: htmlBody("<p>hello <b>world</b></p>"),
    Organizer: { Mailbox: { EmailAddress: "alice@example.com", Name: "Alice" } },
    RequiredAttendees: [
      { Mailbox: { EmailAddress: "Bob@example.com" } },
    ],
    IsRecurring: true,
    IsCancelled: false,
    LastModifiedTime: "2026-05-12T10:00:00Z",
    WebClientReadFormQueryString: "https://outlook/x",
  });

  assert.equal(event.itemId, "AAA");
  assert.equal(event.changeKey, "BBB");
  assert.equal(event.subject, "Standup");
  assert.equal(event.startIso, "2026-05-13T08:00:00Z");
  assert.equal(event.endIso, "2026-05-13T08:30:00Z");
  assert.equal(event.isAllDay, false);
  assert.equal(event.location, "Room 1");
  assert.equal(event.bodyText, "hello world");
  assert.equal(event.organizerEmail, "alice@example.com");
  assert.equal(event.organizerName, "Alice");
  assert.deepEqual(event.attendees, ["bob@example.com"]);
  assert.equal(event.isRecurring, true);
  assert.equal(event.isCancelled, false);
  assert.equal(event.lastModifiedIso, "2026-05-12T10:00:00Z");
  assert.equal(event.webLink, "https://outlook/x");
});

test("parseEvent fills sane defaults when fields are missing", () => {
  const event = parseEvent({});
  assert.equal(event.itemId, "");
  assert.equal(event.changeKey, "");
  assert.equal(event.subject, "");
  assert.equal(event.startIso, "");
  assert.equal(event.endIso, "");
  assert.equal(event.isAllDay, false);
  assert.equal(event.location, "");
  assert.equal(event.bodyText, "");
  assert.equal(event.organizerEmail, "");
  assert.equal(event.organizerName, "");
  assert.deepEqual(event.attendees, []);
  assert.equal(event.isRecurring, false);
  assert.equal(event.isCancelled, false);
});

test("bodyToText preserves block structure as newlines", () => {
  const text = bodyToText(htmlBody("<p>line one</p><p>line two</p>"));
  assert.equal(text, "line one\nline two");
});

test("bodyToText turns <br> into newlines", () => {
  assert.equal(bodyToText(htmlBody("a<br>b<br/>c<br />d")), "a\nb\nc\nd");
});

test("bodyToText strips inline tags but keeps text", () => {
  assert.equal(bodyToText(htmlBody("<b>bold</b> and <i>italic</i>")), "bold and italic");
});

test("bodyToText decodes common HTML entities", () => {
  assert.equal(
    bodyToText(htmlBody("Tom &amp; Jerry &lt;3 &quot;quoted&quot;")),
    'Tom & Jerry <3 "quoted"',
  );
});

test("bodyToText decodes numeric entities", () => {
  assert.equal(bodyToText(htmlBody("hi &#33; &#x21;")), "hi ! !");
});

test("bodyToText decodes &nbsp; and folds it into normal space", () => {
  assert.equal(bodyToText(htmlBody("a&nbsp;b")), "a b");
});

test("bodyToText collapses repeated newlines and trims", () => {
  assert.equal(
    bodyToText(htmlBody("<p>a</p><p></p><p></p><p>b</p>")),
    "a\n\nb",
  );
});

test("bodyToText leaves plain-text bodies unchanged but trims", () => {
  assert.equal(bodyToText(textBody("  hello\nworld  ")), "hello\nworld");
});

test("bodyToText folds literal NBSP into spaces in text bodies too", () => {
  assert.equal(bodyToText(textBody("a b")), "a b");
});

test("collectAttendees dedupes across required, optional, resources", () => {
  const attendees = collectAttendees({
    RequiredAttendees: [
      { Mailbox: { EmailAddress: "Alice@example.com" } },
      { Mailbox: { EmailAddress: "alice@example.com" } },
    ],
    OptionalAttendees: [{ Mailbox: { EmailAddress: "BOB@example.com" } }],
    Resources: [{ Mailbox: { EmailAddress: "room@example.com" } }],
  });
  assert.deepEqual(attendees, [
    "alice@example.com",
    "bob@example.com",
    "room@example.com",
  ]);
});

test("collectAttendees ignores entries with no email", () => {
  const attendees = collectAttendees({
    RequiredAttendees: [
      { Mailbox: {} },
      { Mailbox: { EmailAddress: "  " } },
      { Mailbox: { EmailAddress: "user@x.com" } },
    ],
  });
  assert.deepEqual(attendees, ["user@x.com"]);
});

// Pinned end-to-end snapshot of the OWA-dict → Event pipeline. Any
// drift in HTML stripping, attendee normalisation, contentHash, or
// caldavUid would silently re-push every event on the next sync, so
// these values gate every release.
const SAMPLE_RAW = {
  ItemId: { Id: "AAA", ChangeKey: "BBB" },
  Subject: "Standup",
  Start: "2026-05-13T08:00:00Z",
  End: "2026-05-13T08:30:00Z",
  IsAllDayEvent: false,
  Location: { DisplayName: "Room 1" },
  Body: {
    BodyType: "HTML",
    Value: "<p>hello <b>world</b></p><p>line two &amp; more&nbsp;text</p>",
  },
  Organizer: { Mailbox: { EmailAddress: "alice@example.com", Name: "Alice" } },
  RequiredAttendees: [
    { Mailbox: { EmailAddress: "Bob@example.com" } },
    { Mailbox: { EmailAddress: "alice@example.com" } },
  ],
  OptionalAttendees: [{ Mailbox: { EmailAddress: "carol@example.com" } }],
  IsRecurring: true,
  IsCancelled: false,
  LastModifiedTime: "2026-05-12T10:00:00Z",
  WebClientReadFormQueryString: "https://outlook/x",
};

const EXPECTED_BODY = "hello world\nline two & more text";
const EXPECTED_ATTENDEES = ["alice@example.com", "bob@example.com", "carol@example.com"];
const EXPECTED_HASH =
  "6fecc0e73e715c704f8f04ea646ba15b2ca5d5fd40d8faf075b5c5d4b28e1670";
const EXPECTED_UID = "ocs-cb1ad2119d8fafb69566510ee712661f@ete-look-sync";

test("parseEvent end-to-end shape stays pinned", () => {
  const event = parseEvent(SAMPLE_RAW);
  assert.equal(event.bodyText, EXPECTED_BODY);
  assert.deepEqual(event.attendees, EXPECTED_ATTENDEES);
  assert.equal(contentHash(event), EXPECTED_HASH);
  assert.equal(caldavUid(event), EXPECTED_UID);
});

test("collectAttendees returns sorted order", () => {
  const attendees = collectAttendees({
    RequiredAttendees: [
      { Mailbox: { EmailAddress: "zach@x" } },
      { Mailbox: { EmailAddress: "amy@x" } },
      { Mailbox: { EmailAddress: "mark@x" } },
    ],
  });
  assert.deepEqual(attendees, ["amy@x", "mark@x", "zach@x"]);
});
