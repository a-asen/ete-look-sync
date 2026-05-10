import { test } from "node:test";
import { strict as assert } from "node:assert";

import { getLogger, setupLogging } from "./log.js";

/** Capture everything written to process.stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = originalWrite;
  }
  return chunks.join("");
}

test("info messages pass through without a level prefix", () => {
  setupLogging({ debug: false });
  const log = getLogger("test");
  const out = captureStderr(() => log.info("[sync] hello"));
  assert.equal(out, "[sync] hello\n");
});

test("warn and error get a level prefix", () => {
  setupLogging({ debug: false });
  const log = getLogger("test");
  const out = captureStderr(() => {
    log.warn("watch out");
    log.error("oh no");
  });
  assert.equal(out, "WARNING watch out\nERROR oh no\n");
});

test("debug is suppressed unless setupLogging({debug:true})", () => {
  setupLogging({ debug: false });
  const log = getLogger("test");

  let out = captureStderr(() => log.debug("verbose"));
  assert.equal(out, "");

  setupLogging({ debug: true });
  out = captureStderr(() => log.debug("verbose"));
  assert.equal(out, "DEBUG verbose\n");
});
