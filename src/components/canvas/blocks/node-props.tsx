import type { NodeProps } from "@xyflow/react";
import type { BlockData, StrategyBlock } from "../../../lib/strategy/types";

/**
 * React Flow's node props, narrowed to ONE member of the `BlockData` union.
 *
 * `NodeProps<StrategyBlock>` hands every custom node the whole union, which is how the
 * prototype ended up writing `data as unknown as InputBlockData` in five files — a
 * double cast that silences the compiler in exactly the place a mis-registered
 * `nodeTypes` entry would show up. Substituting the member instead keeps each component
 * checked against its own data shape with no cast anywhere, and `BLOCK_COMPONENTS` is
 * the single place the mapping from type string to component is stated.
 */
export type NodePropsFor<T extends BlockData> = Omit<NodeProps<StrategyBlock>, "data"> & {
  data: T;
};
