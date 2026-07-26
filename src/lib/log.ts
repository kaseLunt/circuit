// The single sanctioned console writer in src/**: eslint.config.mjs scopes
// `no-console: off` to this one file, so every other module stays console-free without
// an eslint-disable (CLAUDE.md bans those). This is the client-side twin of
// tests/fork/harness.ts `record` and scripts/protocol-reads.mjs `out`/`fail`. On the
// server the line goes straight to stderr; the browser has no stderr, so it reaches the
// host console here and nowhere else.
// `describe` must never throw: it runs inside componentDidCatch, and this codebase's
// payloads are bigint-bearing and graph-shaped — both defeat a bare JSON.stringify, and a
// throw there escapes the boundary whose entire job is containing throws.
type LogLevel = "warn" | "error";

export type LogSink = (level: LogLevel, message: string, detail?: unknown) => void;

function describe(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    const seen = new WeakSet<object>();
    const json: string | undefined = JSON.stringify(detail, (_key, value: unknown) => {
      if (typeof value === "bigint") return `${value}n`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
    return json ?? "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}

function defaultSink(level: LogLevel, message: string, detail?: unknown): void {
  const line =
    detail === undefined ? `[${level}] ${message}` : `[${level}] ${message} ${describe(detail)}`;
  const stderr = typeof process === "undefined" ? undefined : process.stderr;
  if (stderr) {
    stderr.write(`${line}\n`);
    return;
  }
  console.error(line);
}

let sink: LogSink = defaultSink;

/** Redirect log output (tests assert on emitted lines instead of the host console). */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

export function logError(message: string, detail?: unknown): void {
  sink("error", message, detail);
}

export function logWarn(message: string, detail?: unknown): void {
  sink("warn", message, detail);
}
