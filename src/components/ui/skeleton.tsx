import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/**
 * A decorative loading bar. It is `aria-hidden` on purpose: the container that owns a
 * group of pending slots declares ONE polite live region, so a panel of ten unresolved
 * values announces once rather than ten times.
 */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("shimmer rounded-sm bg-muted", className)} {...props} />;
}

interface SkeletonValueProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** What is loading, e.g. "Supply APY". Announced; never a value. */
  label: string;
  /**
   * Width of the slot in `ch`, taken from the widest form the slot's formatter can
   * produce (7 for "12.34%"). There is no default: a guessed width reintroduces exactly
   * the layout shift this element exists to prevent.
   */
  chars: number;
}

/**
 * SPEC §3 step 2: a renderable quantity has no visual form until its source resolves.
 * SkeletonValue is that pre-resolution form — it accepts a description and a width,
 * never a number, so a placeholder digit cannot typecheck through it.
 *
 * It carries `aria-busy` and a label but deliberately NOT `role="status"`: the owning
 * container holds the single live region for all of its slots.
 */
function SkeletonValue({ label, chars, className, style, ...props }: SkeletonValueProps) {
  return (
    <span
      aria-busy="true"
      aria-label={`${label}: loading`}
      className={cn("skeleton-value", className)}
      style={{ width: `${chars}ch`, ...style }}
      {...props}
    />
  );
}

export { Skeleton, SkeletonValue };
