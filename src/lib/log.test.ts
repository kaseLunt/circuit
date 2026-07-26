import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logWarn, setLogSink, type LogSink } from "./log";

interface Emission {
  level: string;
  message: string;
  detail?: unknown;
}

function installRecorder(): Emission[] {
  const emitted: Emission[] = [];
  const sink: LogSink = (level, message, detail) => {
    emitted.push({ level, message, detail });
  };
  setLogSink(sink);
  return emitted;
}

// The default sink is the thing worth testing: a replacement sink receives the raw
// detail and never exercises describe(), which is the part that must not throw.
function captureDefaultLines(run: () => void): string[] {
  const lines: string[] = [];
  setLogSink(null);
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
});

describe("setLogSink", () => {
  it("routes emissions to the installed sink instead of the host console", () => {
    const emitted = installRecorder();
    logError("plan step failed", { step: 4 });
    logWarn("rate is stale", undefined);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.level).toBe("error");
    expect(emitted[0]?.message).toBe("plan step failed");
    expect(emitted[0]?.detail).toEqual({ step: 4 });
    expect(emitted[1]?.level).toBe("warn");
  });

  it("restores the default writer when passed null", () => {
    const emitted = installRecorder();
    setLogSink(null);
    const lines = captureDefaultLines(() => {
      logError("back to stderr");
    });
    expect(emitted).toHaveLength(0);
    expect(lines).toEqual(["[error] back to stderr\n"]);
  });
});

describe("default sink line format", () => {
  it("prefixes the level and appends the described detail", () => {
    const lines = captureDefaultLines(() => {
      logWarn("stale snapshot", { block: 25592678 });
    });
    expect(lines[0]).toBe('[warn] stale snapshot {"block":25592678}\n');
  });

  it("omits the detail segment entirely when none is given", () => {
    const lines = captureDefaultLines(() => {
      logError("no detail");
    });
    expect(lines[0]).toBe("[error] no detail\n");
  });

  it("passes a string detail through verbatim", () => {
    const lines = captureDefaultLines(() => {
      logError("component stack", "\n    at BorrowBlock");
    });
    expect(lines[0]).toBe("[error] component stack \n    at BorrowBlock\n");
  });

  it("prefers an Error's stack over its shape", () => {
    const lines = captureDefaultLines(() => {
      logError("boundary caught", new Error("exchange rate read reverted"));
    });
    expect(lines[0]).toContain("Error: exchange rate read reverted");
  });
});

describe("describe() never throws on this codebase's payloads", () => {
  it("serialises a bigint payload — JSON.stringify alone throws on one", () => {
    const lines = captureDefaultLines(() => {
      logError("plan step failed", { amount: 10n ** 18n });
    });
    expect(lines[0]).toBe('[error] plan step failed {"amount":"1000000000000000000n"}\n');
  });

  it("serialises a circular payload — the strategy graph is cycle-shaped", () => {
    const node: { id: string; parent?: unknown } = { id: "borrow-1" };
    node.parent = node;
    const lines = captureDefaultLines(() => {
      logError("cycle", node);
    });
    expect(lines[0]).toBe('[error] cycle {"id":"borrow-1","parent":"[circular]"}\n');
  });

  it("marks a payload JSON cannot represent instead of emitting undefined", () => {
    const lines = captureDefaultLines(() => {
      logError("callback", () => undefined);
    });
    expect(lines[0]).toBe("[error] callback [unserializable]\n");
  });
});
