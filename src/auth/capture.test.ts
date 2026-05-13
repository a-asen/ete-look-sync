import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  OUTLOOK_AUDIENCE,
  anchorMailboxFromClaims,
  decodeJwtClaims,
  pickBestToken,
  type MsalEntry,
} from "./capture.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function entry(
  key: string,
  value: Record<string, unknown>,
): MsalEntry {
  return { key, value };
}

test("decodeJwtClaims roundtrips a payload", () => {
  const jwt = makeJwt({ aud: "https://example.com", tid: "t-1", puid: "p-1" });
  const claims = decodeJwtClaims(jwt);
  assert.ok(claims);
  assert.equal(claims!["aud"], "https://example.com");
  assert.equal(claims!["tid"], "t-1");
  assert.equal(claims!["puid"], "p-1");
});

test("decodeJwtClaims returns null on too few segments", () => {
  assert.equal(decodeJwtClaims("not-a-jwt"), null);
  assert.equal(decodeJwtClaims(""), null);
});

test("decodeJwtClaims returns null when payload is not JSON", () => {
  const broken = Buffer.from("totally not json").toString("base64url");
  assert.equal(decodeJwtClaims(`header.${broken}.sig`), null);
});

test("anchorMailboxFromClaims assembles PUID:<puid>@<tid>", () => {
  assert.equal(
    anchorMailboxFromClaims({ puid: "12345", tid: "tenant-abc" }),
    "PUID:12345@tenant-abc",
  );
});

test("anchorMailboxFromClaims tolerates missing claims", () => {
  assert.equal(anchorMailboxFromClaims({}), "PUID:@");
  assert.equal(anchorMailboxFromClaims({ puid: 42 }), "PUID:@");
});

test("pickBestToken picks the matching Outlook-audience entry", () => {
  const now = 1_700_000_000;
  const jwt = makeJwt({ aud: OUTLOOK_AUDIENCE, tid: "t1", puid: "p1" });
  const entries: MsalEntry[] = [
    entry("msal.2|h|e|accesstoken|c|t1|scope1||", {
      secret: jwt,
      expiresOn: now + 3600,
      target: "scope1 scope2",
      cachedAt: now,
    }),
  ];
  const picked = pickBestToken(entries, now);
  assert.ok(picked);
  assert.equal(picked!.token, jwt);
  assert.equal(picked!.expires_on, now + 3600);
  assert.equal(picked!.tenant_id, "t1");
  assert.equal(picked!.anchor_mailbox, "PUID:p1@t1");
  assert.equal(picked!.scopes, "scope1 scope2");
  assert.equal(picked!.cached_at, now);
  assert.equal(picked!.msal_key, "msal.2|h|e|accesstoken|c|t1|scope1||");
});

test("pickBestToken skips entries whose JWT audience is wrong", () => {
  const now = 1_700_000_000;
  const wrong = makeJwt({ aud: "https://graph.microsoft.com" });
  const entries: MsalEntry[] = [
    entry("k", { secret: wrong, expiresOn: now + 3600 }),
  ];
  assert.equal(pickBestToken(entries, now), null);
});

test("pickBestToken skips entries that already expired (within skew)", () => {
  const now = 1_700_000_000;
  const jwt = makeJwt({ aud: OUTLOOK_AUDIENCE });
  // 30s remaining — inside the 60s skew, so treated as expired.
  const entries: MsalEntry[] = [
    entry("k", { secret: jwt, expiresOn: now + 30 }),
  ];
  assert.equal(pickBestToken(entries, now), null);
});

test("pickBestToken picks the freshest among multiple valid entries", () => {
  const now = 1_700_000_000;
  const jwt = makeJwt({ aud: OUTLOOK_AUDIENCE, tid: "t", puid: "p" });
  const entries: MsalEntry[] = [
    entry("older", { secret: jwt, expiresOn: now + 600 }),
    entry("newest", { secret: jwt, expiresOn: now + 7200 }),
    entry("middle", { secret: jwt, expiresOn: now + 3600 }),
  ];
  const picked = pickBestToken(entries, now);
  assert.equal(picked!.msal_key, "newest");
  assert.equal(picked!.expires_on, now + 7200);
});

test("pickBestToken falls back to JWT exp when expiresOn is missing", () => {
  const now = 1_700_000_000;
  const jwt = makeJwt({ aud: OUTLOOK_AUDIENCE, exp: now + 7200 });
  const entries: MsalEntry[] = [entry("k", { secret: jwt })];
  const picked = pickBestToken(entries, now);
  assert.ok(picked);
  assert.equal(picked!.expires_on, now + 7200);
});

test("pickBestToken returns null on empty input", () => {
  assert.equal(pickBestToken([], 1_700_000_000), null);
});

test("pickBestToken ignores entries with non-string secret", () => {
  assert.equal(
    pickBestToken([entry("k", { secret: 42, expiresOn: 9_999_999_999 })], 0),
    null,
  );
});
