"use client";

/**
 * The tx family's action control — the B3 button system, not a new primitive (T33).
 * `primary` is the ONE terminal commit on screen (Execute, or Continue once Execute is
 * gone — never both, T3a/T25); `default` is recovery/diagnosis; `ghost` is copy
 * affordances.
 *
 * Gating is `aria-disabled` + reason, never `disabled` (T25; SPEC §6 "disabled states
 * always explain why"): a disabled control cannot be focused and so cannot explain
 * itself. The reason renders as a real, visible element wired via `aria-describedby`,
 * and the click is intercepted — the gate holds regardless of styling.
 */
import { useId, type MouseEvent, type ReactNode } from "react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

export interface TransactionButtonProps {
  readonly children: ReactNode;
  readonly onClick: () => void;
  /** Present = the action is gated; the string states WHY, and the click is intercepted. */
  readonly gateReason?: string | null;
  readonly variant?: "primary" | "default" | "ghost";
  readonly size?: "sm" | "default";
  readonly className?: string;
  readonly "aria-label"?: string;
}

export function TransactionButton({
  children,
  onClick,
  gateReason = null,
  variant = "default",
  size = "default",
  className,
  "aria-label": ariaLabel,
}: TransactionButtonProps) {
  const reasonId = useId();
  const gated = gateReason !== null;

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (gated) {
      event.preventDefault();
      return;
    }
    onClick();
  }

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        variant={variant}
        size={size}
        aria-label={ariaLabel}
        aria-disabled={gated || undefined}
        aria-describedby={gated ? reasonId : undefined}
        onClick={handleClick}
        className={gated ? "opacity-60" : undefined}
      >
        {children}
      </Button>
      {gated ? (
        <span id={reasonId} className="text-xs text-muted-foreground">
          {gateReason}
        </span>
      ) : null}
    </span>
  );
}
