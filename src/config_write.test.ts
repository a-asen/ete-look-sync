import { test } from "node:test";
import { strict as assert } from "node:assert";

import { upsertTomlSection } from "./config_write.js";

test("upsertTomlSection replaces existing keys in place, preserving comments + alignment", () => {
  const input = [
    "[owa]",
    'base_url = "https://x"',
    "",
    "[etebase]",
    "# pick a collection",
    'server_url     = "https://api.etebase.com"',
    'username       = ""',
    'collection_uid = ""',
    "",
    "[caldav]",
    'username = ""',
    "",
  ].join("\n");

  const out = upsertTomlSection(input, "etebase", {
    server_url: "https://api.etebase.com",
    username: "secure.t-rail",
    collection_uid: "ABC123",
  });

  // Value replaced, surrounding alignment whitespace kept verbatim.
  assert.ok(out.includes('username       = "secure.t-rail"'));
  assert.ok(out.includes('collection_uid = "ABC123"'));
  // Comment inside the section survives.
  assert.ok(out.includes("# pick a collection"));
  // Sibling [caldav] username is NOT touched (stays empty).
  assert.match(out, /\[caldav\]\nusername = ""/);
});

test("upsertTomlSection appends the section when it's absent", () => {
  const out = upsertTomlSection('[owa]\nbase_url = "x"\n', "etebase", { collection_uid: "Z" });
  assert.match(out, /\[etebase\]\ncollection_uid = "Z"/);
  assert.ok(out.includes("[owa]")); // original section preserved
});

test("upsertTomlSection inserts a missing key into an existing section", () => {
  const out = upsertTomlSection('[etebase]\nserver_url = "s"\n', "etebase", { collection_uid: "Z" });
  assert.ok(out.includes('server_url = "s"'));
  assert.ok(out.includes('collection_uid = "Z"'));
});

test("upsertTomlSection builds content from empty input", () => {
  assert.equal(upsertTomlSection("", "etebase", { collection_uid: "Z" }), '[etebase]\ncollection_uid = "Z"\n');
});

test("upsertTomlSection escapes quotes and backslashes in values", () => {
  const out = upsertTomlSection('[etebase]\nusername = ""\n', "etebase", { username: 'a"b\\c' });
  assert.ok(out.includes('username = "a\\"b\\\\c"'));
});
