/**
 * SPEC §5.5 divergence bounds: every attributed output is compared to its prediction within
 * "expected ± a named tolerance", and the constants live here — ONE module — so the session
 * service and the client machine cannot drift apart on what "within tolerance" means
 * (P3 treatment §6.2).
 *
 * The values are DERIVED FROM FORK RECEIPTS, not invented:
 *
 *  - `SANDBOX_OUTPUT_TOLERANCE.absWei = 2n`: the fork gate bounds eETH wrap round-trip dust
 *    at ≤1 integer share per wrap (`EETH_DUST_SHARES_AGGREGATE_MAX`, the constants block of
 *    `tests/fork/flagship-plan.test.ts`), and one eETH share converts to ~1.1 wei at the
 *    pinned block, so a 2-wei absolute floor covers the sub-wei directional rounding a
 *    frozen fork can produce without admitting a real modelling error.
 *  - `SANDBOX_OUTPUT_TOLERANCE.relPow = 1e6` (one part in 1e-6, relative): the clean-run
 *    ledger walk proved block-pinned predictions track execution within 1e-6 relative, the
 *    only drift being index accrual over the ~12 blocks a plan takes
 *    (`LEDGER_HF_REL_POW`, same file). At 1e-6 the stale-debt model P2 corrected would
 *    still fail — the bound discriminates.
 *  - `SANDBOX_HF_REL_POW`: the same clean-run 1e-6 bound, applied to the per-step
 *    `getUserAccountData` cross-check (SPEC §5.4 post-execution clause).
 *
 * A NOTE ON DENOMINATION, since `absWei` is not denominated in ether (W09). The floor is in
 * the ATTRIBUTED ASSET's own smallest unit, so for a six-decimal reserve 2n is 2e-6 USDC
 * rather than 2e-18 ETH — nominally looser, and harmless in direction because nothing in the
 * carry needs the slack: the borrow amount is plan-time calldata and the USDC `Transfer` the
 * pool emits echoes that exact figure, so the honest expectation there is EXACT equality. The
 * fork drill asserts `delta === 0n` for the USDC leg and the named constants remain the
 * PRODUCT bound, which is the right division — a test may demand more than the product
 * promises, and a per-asset tolerance fork would need a fork receipt forcing it rather than a
 * feeling that six decimals deserve their own number.
 *
 * Sandbox bounds are tight because the fork is frozen: only intra-plan timestamp accrual
 * moves anything. Live bounds differ — rebases land between steps — and land HERE, named,
 * with their own justification, never inlined at a call site: `LIVE_OUTPUT_TOLERANCE`,
 * `LIVE_HF_REL_POW`, and the two window constants they are derived from
 * (`LIVE_SIMULATION_MAX_AGE_MS`, `LIVE_STEP_TIMEOUT_MS`) are below.
 */

export interface OutputTolerance {
  /** Absolute floor in wei — covers sub-wei rounding dust on small outputs. */
  readonly absWei: bigint;
  /** Relative arm: the bound is predicted/relPow — covers index accrual on large outputs. */
  readonly relPow: bigint;
}

export const SANDBOX_OUTPUT_TOLERANCE: OutputTolerance = {
  absWei: 2n,
  relPow: 10n ** 6n,
};

/** SPEC §5.4 per-step HF cross-check bound, sandbox: 1 part in 1e6, relative. */
export const SANDBOX_HF_REL_POW = 10n ** 6n;

/**
 * How long a live simulation may stand before Execute re-gates (treatment §4.4; SPEC §3.7's
 * fresh-simulation gate is the floor, this is the regate on top of it).
 *
 * Two minutes is ten mainnet blocks. It is long enough for a person to read the pre-sign
 * card without the gate snatching the button away mid-sentence, and short enough that the
 * read set the gate approved — oracle price, Aave indexes, the eETH exchange rate — is still
 * the one the chain holds. Past it the quote is not refreshed silently: Execute regates and
 * the flow is labelled "Re-simulate", because a stale quote executed is the Flashbots-realism
 * failure this constant exists to refuse.
 *
 * ENFORCEMENT READS THE MONOTONIC TRACK (doctrine D9). Wall time exists only to mint the
 * T29 "Simulated at block {n} · {age}" display; a backward wall-clock correction must not be
 * able to extend this budget. The gate's inputs are named `*MonotonicMs` for that reason.
 */
export const LIVE_SIMULATION_MAX_AGE_MS = 120_000;

/**
 * How long one live step may sit unconfirmed before the machine offers the T7 timeout
 * affordance (SPEC §6 "timeout (guidance + keep-waiting option)").
 *
 * Ninety seconds is roughly seven mainnet blocks: a transaction at a fee the wallet itself
 * chose is normally included in one or two, so seven is well past "the network is busy" and
 * still short of "something is wrong and nobody said so". The state it enters CLAIMS NOTHING
 * (T32a): the chain has not spoken, so neither does the sentence — "it may still land" — and
 * the two exits are keep-waiting and give-up, never an automatic failure.
 */
export const LIVE_STEP_TIMEOUT_MS = 90_000;

/**
 * The §6.2 divergence bound for LIVE execution. Named separately from the sandbox bound and
 * never defaulted to it: `createExecutionMachine` throws for a live machine with no named
 * tolerance precisely so a silent reuse cannot happen.
 *
 * Derivation, from the two constants above rather than from taste:
 *
 *  - `absWei = 2n` is unchanged and carried for the same reason as the sandbox floor —
 *    sub-wei directional rounding on a small output does not depend on which environment
 *    produced it.
 *  - `relPow = 1e4` (one part in 1e-4, relative). Live differs from a frozen fork in exactly
 *    one way that reaches a PREDICTION: wall-clock passes between the gating simulation's
 *    pinned block and each step's execution, and two rate processes move across it — eETH's
 *    rebase (the LiquidityPool's oracle report) and Aave's index accrual. That window is
 *    BOUNDED BY CONSTRUCTION rather than hoped for: at most `LIVE_SIMULATION_MAX_AGE_MS`
 *    before the run starts, and at most `LIVE_STEP_TIMEOUT_MS` per step inside it, so for
 *    the flagship's 13 steps the whole exposure is under 22 minutes — about 4.1e-5 of a
 *    year. Single-digit-percent annual rates move a figure by ~4e-6 relative over a window
 *    that size, so 1e-4 carries better than twenty times the modelled drift.
 *
 * The bound still DISCRIMINATES, which is the only property that matters: the defects this
 * comparison exists to catch — a wrong producer's output, a balance sweep, a mis-scaled
 * decimal, a stale-debt model — are O(1) or O(1e-1) errors, four or more orders above this
 * bound. Reusing the sandbox's 1e-6 here would halt honest runs on accrual; widening past
 * 1e-4 would start admitting real modelling errors. Both failure modes are named so a future
 * change has to argue against them.
 */
export const LIVE_OUTPUT_TOLERANCE: OutputTolerance = {
  absWei: 2n,
  relPow: 10n ** 4n,
};

/**
 * SPEC §5.4 per-step HF cross-check bound, live: 1 part in 1e4, relative — the same window
 * argument as `LIVE_OUTPUT_TOLERANCE.relPow`, applied to `getUserAccountData`'s reading
 * instead of to an attributed output. The sandbox's 1e-6 stays where it was proven.
 */
export const LIVE_HF_REL_POW = 10n ** 4n;

/** The wei bound a given prediction admits — the TOLERANCE figure the divergence card renders. */
export function toleranceWeiFor(predictedWei: bigint, tolerance: OutputTolerance): bigint {
  const relative = predictedWei / tolerance.relPow;
  return relative > tolerance.absWei ? relative : tolerance.absWei;
}

export function withinOutputTolerance(
  predictedWei: bigint,
  attributedWei: bigint,
  tolerance: OutputTolerance,
): boolean {
  const diff = attributedWei > predictedWei ? attributedWei - predictedWei : predictedWei - attributedWei;
  return diff <= toleranceWeiFor(predictedWei, tolerance);
}

/** |actual − expected| ≤ expected/pow — the fork suite's relative-agreement shape. */
export function relWithin(actual: bigint, expected: bigint, pow: bigint): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff * pow <= expected;
}
