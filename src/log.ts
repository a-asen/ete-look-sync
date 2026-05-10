// Package-level logging.
//
// Output format mirrors the Python predecessor:
//   - INFO  → message as-is (preserves the [tag] ... style call sites already use)
//   - DEBUG → "DEBUG <message>"
//   - WARN  → "WARNING <message>"
//   - ERROR → "ERROR <message>"
//
// All output goes to stderr so stdout stays clean for machine-readable
// output (dry-run plans, export-ics results).

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: Level = "info";

/** Configure the package logger. Safe to call multiple times. */
export function setupLogging(opts: { debug?: boolean } = {}): void {
  currentLevel = opts.debug ? "debug" : "info";
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Returns a logger tagged with `module`. The tag is currently unused —
 * accepted in the API so per-module levels can be added later without
 * touching every call site.
 */
export function getLogger(_module: string): Logger {
  return {
    debug: (msg) => emit("debug", msg),
    info:  (msg) => emit("info",  msg),
    warn:  (msg) => emit("warn",  msg),
    error: (msg) => emit("error", msg),
  };
}

function emit(level: Level, msg: string): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const prefix =
    level === "info"  ? "" :
    level === "warn"  ? "WARNING " :
    level === "debug" ? "DEBUG " :
                        "ERROR ";
  process.stderr.write(`${prefix}${msg}\n`);
}
