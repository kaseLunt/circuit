/**
 * Bounded-call policy for the session service (Codex round-2 finding 1). Every remote
 * await in the fork layer runs under a PER-REQUEST deadline, and every polling loop
 * under an OVERALL operation budget, so a stalled socket can never hold the session
 * mutex forever — the await FAILS, bounded, and the execute path's classification
 * (dispatch intent → `reconcile-required`) does the rest. This module is the covered,
 * pure home of that policy; `fork-session.ts` only threads it onto raw sockets.
 */

export class DeadlineExceededError extends Error {
  constructor(
    readonly what: string,
    readonly afterMs: number,
  ) {
    super(`${what} exceeded its ${afterMs}ms deadline`);
  }
}

/**
 * Per-request ceiling for a single fork-RPC round trip. A session fork answers reads
 * from memory or its (possibly cold) upstream cache; twenty seconds is generous for one
 * request and small enough that no polling loop's total stays unbounded.
 */
export const SANDBOX_RPC_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Overall budget for confirming one dispatched transaction. Anvil auto-mines, so a
 * healthy confirmation is sub-second; ninety seconds distinguishes "slow" from "stalled"
 * with a wide margin, and past it the step classifies as dispatch-unresolved — the
 * intent and hash already persist, so recovery is discovery, never a re-send.
 */
export const SANDBOX_CONFIRM_BUDGET_MS = 90_000;

/**
 * viem read-client timeout for session-fork reads (shares, allowance, HF). Reads hit at
 * most a handful of storage slots; thirty seconds bounds a stalled read without tripping
 * on a cold upstream fetch. Snapshot CAPTURE keeps its own larger bound — a full capture
 * is hundreds of multicalled reads against a cold cache.
 */
export const SANDBOX_READ_TIMEOUT_MS = 30_000;

/**
 * Run `run` with an AbortSignal that fires at the deadline. The promise REJECTS with
 * `DeadlineExceededError` at the deadline even if `run` ignores the signal entirely —
 * that guarantee is what makes every downstream await bounded, and it is the property
 * the unit tests pin. An abort-caused rejection from `run` itself is normalized to the
 * same error so callers classify one way.
 */
export function withDeadline<T>(
  what: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceededError(what, ms));
    }, ms);
    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(controller.signal.aborted ? new DeadlineExceededError(what, ms) : cause);
      },
    );
  });
}

/** An overall budget a polling loop draws down; the clock is injectable for tests. */
export interface OperationBudget {
  remainingMs(): number;
  exceeded(): boolean;
}

/**
 * The default clock is MONOTONIC (Codex round-3 finding 2): `Date.now` is an adjustable
 * wall clock, and a backward host-clock correction would inflate `remainingMs` and hold
 * `exceeded()` false — letting a polling loop (and the session mutex behind it) run past
 * its promised bound. `performance.now` only moves forward. The injectable clock exists
 * for tests alone; production callers take the default.
 */
export function operationBudget(
  totalMs: number,
  now: () => number = () => performance.now(),
): OperationBudget {
  const deadline = now() + totalMs;
  return {
    remainingMs: () => Math.max(0, deadline - now()),
    exceeded: () => now() >= deadline,
  };
}

/** The per-request window inside an overall budget: the request ceiling, clipped to what
 *  remains, floored at 1ms so an exhausted budget still fails fast instead of hanging. */
export function requestWindow(budget: OperationBudget, requestTimeoutMs: number): number {
  return Math.max(1, Math.min(requestTimeoutMs, budget.remainingMs()));
}

export interface ReadyPollOptions<T> {
  readonly what: string;
  /** Overall budget for the whole poll, on the monotonic clock. */
  readonly budgetMs: number;
  /** Wait between failed probes. */
  readonly intervalMs: number;
  /** Per-probe request ceiling; each probe receives its clipped window. */
  readonly requestTimeoutMs: number;
  readonly probe: (requestWindowMs: number) => Promise<T>;
  /** Checked before every probe: a non-null error aborts the poll immediately —
   *  e.g. the child process died, so readiness can never arrive. */
  readonly fatal?: () => Error | null;
  /** Timeout error factory, so the caller can attach diagnostics (a stderr tail);
   *  defaults to `DeadlineExceededError`. */
  readonly onTimeout?: () => Error;
  /** Test-only seams. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until `probe` succeeds, under the same monotonic budget discipline as every
 * other bound in this module (Codex round-4 finding): the anvil readiness loop
 * previously carried its own `Date.now()` deadline, which a backward host-clock
 * correction could hold open indefinitely — pending spawn, port lease, and capacity
 * slot all occupied. The retry/expiry decisions live HERE, covered; the caller only
 * supplies the probe.
 */
export async function pollUntilReady<T>(options: ReadyPollOptions<T>): Promise<T> {
  const budget = operationBudget(options.budgetMs, options.now);
  const sleep =
    options.sleep !== undefined
      ? options.sleep
      : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (;;) {
    const fatal = options.fatal !== undefined ? options.fatal() : null;
    if (fatal !== null) throw fatal;
    if (budget.exceeded()) {
      throw options.onTimeout !== undefined
        ? options.onTimeout()
        : new DeadlineExceededError(options.what, options.budgetMs);
    }
    try {
      return await options.probe(requestWindow(budget, options.requestTimeoutMs));
    } catch {
      await sleep(options.intervalMs);
    }
  }
}
