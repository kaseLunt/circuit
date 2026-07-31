/**
 * The ONE liquidation sentence, and the ONE pair label under it.
 *
 * Three surfaces say this: the borrow block on the canvas, the simulation panel beside it,
 * and the execution review's receipt. They used to author it twice — the block named the
 * pair, the other two printed a generic "collateral/debt oracle ratio" — which meant a
 * weETH/USDC carry and a weETH/WETH loop rendered IDENTICAL sentences everywhere except the
 * canvas. The ratio alone cannot carry the difference: "liquidates … at 0.9123" is a
 * different fact about each pair, and a reader outside the canvas had no way to tell which
 * one they were looking at.
 *
 * So the words live here and the three surfaces render them. What each surface still owns is
 * its own JSX — ramp, slot width, wrapper — because those are layout, not claims.
 *
 * THE NULL-TOGETHER INVARIANT. `core/risk.ts` mints `liquidationRatioWad` and
 * `liquidationPair` from one derivation over one checkpoint, so they are null together
 * (pinned in `risk.test.ts`). The generic label below is therefore the genuinely-unknown
 * case ONLY: the ratio is unavailable in the same breath, and the sentence is about an
 * absence rather than about a position.
 */
import type { LiquidationPair } from "../../lib/strategy/types";

/**
 * The label a position with no single quotable pair gets. Honest and useless on its own —
 * which is why it may only ever appear where the ratio is unavailable too.
 */
const UNKNOWN_PAIR = "collateral/debt";

/** The prose a settled-but-empty risk read gets. Never a dash, never a zero. */
const LIQUIDATION_UNAVAILABLE = "Liquidation level unavailable. The risk read did not resolve.";

/**
 * The two reserves the ratio divides, in numerator/denominator order — never re-derived from
 * a block's own params. The pair is a fact about the POSITION at the minimum-HF checkpoint,
 * which is not something any one block knows.
 */
export function liquidationPairLabel(pair: LiquidationPair | null): string {
  return pair === null ? UNKNOWN_PAIR : `${pair.collateral}/${pair.debt}`;
}

/**
 * The words a visible row wraps around the `SourcedValue` that renders the ratio. Split from
 * the whole sentence so the figure can stay provenanced inline instead of being flattened
 * into a string.
 */
export function liquidationPrefix(pair: string): string {
  return `Liquidates if ${pair} falls to `;
}

/**
 * The whole sentence as one string — what a control announces, and what the unavailable and
 * in-flight states render verbatim. The pointer path and the keyboard path therefore cannot
 * say different things, the defect two independent authorings guarantee.
 */
export function liquidationSentence(pair: string, ratio: string | null, pending: boolean): string {
  if (ratio !== null) return `${liquidationPrefix(pair)}${ratio}.`;
  return pending ? `Liquidation level for ${pair} loading.` : LIQUIDATION_UNAVAILABLE;
}

/**
 * The ratio slot's accessible name. It names the pair too: a screen-reader user reaching the
 * figure through the disclosure gets the same two assets the sentence around it states.
 */
export function liquidationRatioLabel(pair: string): string {
  return `Liquidation ratio, ${pair}`;
}
