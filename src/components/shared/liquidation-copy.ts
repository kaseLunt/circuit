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

/**
 * WHICH WAY THE DEBT ASSET CUTS — treatment §2.5's risk-direction note (W09 objective 3:
 * "the risk labels state which way a depeg cuts").
 *
 * The carry borrows a stablecoin against weETH, and the consequence is counterintuitive
 * enough that no user should have to derive it: the borrowed asset is the DEBT, so a fall in
 * its oracle price SHRINKS the debt and RAISES the health factor. Nothing in the product said
 * so, and the ratio above cannot say it — a ratio is symmetric prose about two prices, while
 * this is a claim about which side of the position each asset sits on.
 *
 * WHEN IT RENDERS, and why that is a read rather than a classification. Only where NO e-mode
 * category governs the position. That is the protocol's own statement that it does not treat
 * these two reserves as a correlated pair — the same `categoryId` the regime sentence beside
 * this one already quotes, so the note and the regime cannot disagree. For a category-governed
 * pair the note would be worse than redundant: weETH is priced through eETH/ETH, so "a fall in
 * WETH raises the health factor" is false for the loop, and treatment §2.5 bans the
 * correlated-pair depeg wording outright. Correlation is therefore never asserted here; the
 * absence of a governing category is, and it is read off the ceiling.
 *
 * WHAT IT DOES NOT SAY. §2.5 also records that USDC's feed caps the UPSIDE (a CAPO adapter).
 * That is a property of the feed's own description, which this module has not read, so it is
 * not stated — the oracle's semantics reach the screen through the provenance trail, where
 * they are quoted rather than paraphrased.
 *
 * The asset names come from the pair `core/risk.ts` minted with the ratio. No symbol is
 * authored here, so a third template borrowing something else inherits the sentence.
 */
export function debtDirectionNote(
  pair: LiquidationPair | null,
  categoryId: number | null,
): string | null {
  if (pair === null || categoryId !== null) return null;
  return (
    `${pair.debt} is this position's debt, so a fall in its oracle price shrinks the debt and ` +
    `raises the health factor. What liquidates this position is ${pair.collateral} falling ` +
    `against ${pair.debt}.`
  );
}
