/**
 * Observed-exit tracking and memoized destruction for session anvil children
 * (Codex round-3 finding 1). Two properties the raw ChildProcess API makes easy to get
 * wrong, stated here as the module's contract and pinned by unit tests:
 *
 *  1. EXIT IS OBSERVED, NEVER INFERRED — the exit listener is installed the moment the
 *     tracker is created (spawn time), so a destroy that begins after the one-shot
 *     event has already fired can never wait on it; and "has exited" reads BOTH exit
 *     records, because Node reports signal termination as `exitCode === null` with
 *     `signalCode` populated.
 *  2. DESTRUCTION IS MEMOIZED — every destroy call returns the SAME promise, so a
 *     second destroy (registry sweep racing an owner destroy, reset cleanup after a
 *     signal death) can neither re-kill nor wait forever on an event that already fired.
 *
 * The module is pure decision logic over a `ProcessLike` handle (option-(a) discipline):
 * unit tests drive spawn/exit/signal sequences through a fake; `fork-session.ts` only
 * binds it to the real ChildProcess and ties the port-lease release to the settled
 * destruction promise.
 */

/** The minimal process surface the tracker needs — ChildProcess satisfies it, and so
 *  does a test fake. */
export interface ProcessLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/** Node's two exit records: normal exit carries `exitCode`, signal death carries
 *  `signalCode` with `exitCode` null. Either one means the process is gone. */
export function hasExitRecord(child: Pick<ProcessLike, "exitCode" | "signalCode">): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export interface ProcessExitTracker {
  /** True once the process's exit has been observed (event or exit record). */
  exited(): boolean;
  /** Resolves when the exit is observed; resolves immediately if it already was. */
  waitForExit(): Promise<void>;
  /**
   * Terminate and wait for the OBSERVED exit: SIGTERM, then SIGKILL after `graceMs`,
   * resolution only on the exit event (or an existing exit record). Memoized — every
   * call returns the same promise, and a process that never spawned (no pid) or has
   * already exited resolves immediately without a kill.
   */
  destroy(graceMs: number): Promise<void>;
}

export function trackProcessExit(child: ProcessLike): ProcessExitTracker {
  let exitObserved = hasExitRecord(child);
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  if (exitObserved) {
    resolveExit();
  } else {
    // Installed NOW, at tracker creation, so no later destroy can miss the one-shot.
    child.once("exit", () => {
      exitObserved = true;
      resolveExit();
    });
  }

  function exited(): boolean {
    if (!exitObserved && hasExitRecord(child)) {
      // Belt: an exit record that appeared through a path our listener did not see
      // (e.g. the tracker was created between record-write and event-emit) still
      // counts as observed and settles the wait.
      exitObserved = true;
      resolveExit();
    }
    return exitObserved;
  }

  let destruction: Promise<void> | null = null;

  return {
    exited,
    waitForExit() {
      exited();
      return exitPromise;
    },
    destroy(graceMs: number) {
      if (destruction === null) {
        destruction = (async () => {
          if (exited()) return;
          // A process that never spawned has nothing to kill and will never emit exit.
          if (child.pid === undefined) return;
          child.kill();
          const force = setTimeout(() => {
            if (!exited()) child.kill("SIGKILL");
          }, graceMs);
          try {
            // Resolution only on the OBSERVED exit — including after SIGKILL.
            await exitPromise;
          } finally {
            clearTimeout(force);
          }
        })();
      }
      return destruction;
    },
  };
}
