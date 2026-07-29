"use client";

/**
 * The failed step's card (T21): fact, evidence, recovery — in that order.
 *
 * The frame is `border-destructive` ONLY for causes that are claims about the chain
 * (reverted, cancelled-by-replacement). A declined signature and an unwatched timeout
 * are decisions and unknowns, not failures — painting them destructive misclaims what
 * happened (T7/T22, both desks' blocking gate), so those causes keep the neutral frame
 * and their muted glyphs.
 *
 * The raw error renders in FULL, never ellipsized — evidence does not truncate — with a
 * copy affordance; a raw that never arrived (D7: failure records are durable before
 * enrichment) is stated as absent rather than faked. Focus moves to the recovery action
 * on entry (SPEC §6 a11y); it takes `.focus-ring` like everything else.
 */
import { useEffect, useRef } from "react";
import { Ban, Clock, Copy, X } from "lucide-react";
import { cn } from "../../lib/utils";
import type { FailureRecordFact } from "../../lib/execution/types";
import { Button } from "../ui/button";
import { TransactionButton } from "./transaction-button";

export interface FailureCardProps {
  readonly failure: FailureRecordFact;
  readonly recover: {
    readonly label: string;
    readonly onAct: () => void;
    readonly gateReason?: string | null;
  };
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function messageOf(failure: FailureRecordFact): string {
  const k = failure.stepIndex + 1;
  switch (failure.cause) {
    case "user-rejected":
      return `Signature declined — step ${k} was not sent.`;
    case "timeout-gave-up":
      return `Stopped watching step ${k}; its transaction had not confirmed when watching stopped.`;
    case "cancelled":
      return `Step ${k}'s transaction was replaced and did not execute.`;
    case "reverted":
      return failure.decoded === null
        ? `Step ${k} reverted on chain.`
        : failure.decoded.message;
  }
}

export function FailureCard({ failure, recover }: FailureCardProps) {
  const destructive = failure.cause === "reverted" || failure.cause === "cancelled";
  const Glyph = failure.cause === "user-rejected" ? Ban : failure.cause === "timeout-gave-up" ? Clock : X;
  const recoverRef = useRef<HTMLDivElement>(null);

  // SPEC §6: on entering the failure state, focus moves to the recovery action.
  useEffect(() => {
    const button = recoverRef.current?.querySelector("button");
    button?.focus();
  }, []);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4",
        destructive ? "border-destructive" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <Glyph
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            destructive ? "text-destructive" : "text-muted-foreground",
          )}
        />
        <p className="text-sm text-foreground">{messageOf(failure)}</p>
      </div>

      {failure.cause === "reverted" ? (
        failure.raw === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            raw error unavailable — enrichment did not complete
          </p>
        ) : (
          <div className="mt-2 flex items-start gap-1">
            <p className="min-w-0 flex-1 break-all rounded-sm bg-secondary px-2 py-1 font-mono text-xs text-muted-foreground">
              {failure.raw}
            </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy raw error"
              onClick={() => {
                if (failure.raw !== null) copyText(failure.raw);
              }}
            >
              <Copy aria-hidden="true" />
            </Button>
          </div>
        )
      ) : null}

      <div ref={recoverRef} className="mt-3">
        <TransactionButton
          onClick={recover.onAct}
          gateReason={recover.gateReason ?? null}
          size="sm"
        >
          {recover.label}
        </TransactionButton>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Sandbox recovery resets the session fork and re-simulates the plan from its base
        block — a failed run has no resumable prefix.
      </p>
    </div>
  );
}
