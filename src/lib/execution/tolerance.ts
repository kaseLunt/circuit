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
 * Sandbox bounds are tight because the fork is frozen: only intra-plan timestamp accrual
 * moves anything. Live bounds (P3b) may differ — rebases land between steps — and must be
 * added HERE, named, with their own justification, never inlined at a call site.
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
