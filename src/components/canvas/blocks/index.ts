import type { RenderableBlockType } from "./base-block";
import { AutoWrapBlock } from "./auto-wrap-block";
import { BorrowBlock } from "./borrow-block";
import { InputBlock } from "./input-block";
import { LendBlock } from "./lend-block";
import { StakeBlock } from "./stake-block";

export {
  BaseBlock,
  BlockRuntimeProvider,
  RATE_SLOT_CHARS,
  useBlockRuntime,
  useWriteRejection,
} from "./base-block";
export type {
  BaseBlockProps,
  BlockRuntime,
  BlockState,
  RenderableBlockType,
  WriteRejection,
} from "./base-block";
export { BlockValueBadge, BlockValueZone } from "./block-value-badge";
export type { NodePropsFor } from "./node-props";
export { BORROW_STEP_BPS } from "./borrow-block";
export { PROTOCOL_LABEL } from "./lend-block";
export { STAKE_PROTOCOLS } from "./stake-block";
export { AutoWrapBlock, BorrowBlock, InputBlock, LendBlock, StakeBlock };

/**
 * The block family, keyed by the view model's block type.
 *
 * `canvas.tsx` owns `nodeTypes` and passes this straight to React Flow; nothing is
 * registered here, so the canvas keeps one registration site and the family keeps one
 * export. The `satisfies` clause makes a missing or invented key a compile error while
 * leaving each component's precise props type intact — which is what lets a node
 * component keep a narrowed `data` instead of casting.
 *
 * `swap` is absent on purpose: `core/graph.ts` has no swap block, so a swap node could
 * never reach a plan, and a nodeTypes entry for it would be an affordance for a graph
 * `validateGraph` rejects. The canvas maps core's `wrap` and `unwrap` onto `auto-wrap`.
 */
export const BLOCK_COMPONENTS = {
  input: InputBlock,
  stake: StakeBlock,
  lend: LendBlock,
  borrow: BorrowBlock,
  "auto-wrap": AutoWrapBlock,
} satisfies Record<RenderableBlockType, unknown>;
