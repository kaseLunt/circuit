import { cn } from "../../lib/utils";

type AssetChipSize = "sm" | "md";

interface AssetChipProps {
  /** Rendered in full and case-preserved. */
  symbol: string;
  /** The asset's full name, announced in place of the symbol when the caller knows it. */
  name?: string;
  size?: AssetChipSize;
  className?: string;
}

const SIZE_CLASSES: Record<AssetChipSize, string> = {
  sm: "h-5 text-micro",
  md: "h-6 text-xs",
};

/**
 * Monochrome asset marker. Colour is reserved for state (SPEC §7), so an asset gets its
 * symbol and nothing else — no per-token hue, no remote logo.
 *
 * The symbol renders in full because abbreviation collides on this product's own assets:
 * two glyphs turn both WETH and weETH into "WE" and both USDC and USDT into "US", and the
 * flagship Leveraged Restake Loop holds WETH and weETH at the same time. Colour is
 * (correctly) unavailable to disambiguate, so the glyphs must carry it.
 */
export function AssetChip({ symbol, name, size = "sm", className }: AssetChipProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm border border-border",
        "bg-transparent px-1.5 font-mono font-medium leading-none text-muted-foreground",
        SIZE_CLASSES[size],
        className,
      )}
    >
      {name === undefined ? (
        symbol
      ) : (
        <>
          <span aria-hidden="true">{symbol}</span>
          <span className="sr-only">{name}</span>
        </>
      )}
    </span>
  );
}
