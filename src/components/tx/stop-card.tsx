"use client";

/**
 * The designed-stop card grammar (T27): every mechanical refusal and terminal session
 * state renders as a STATE on this card — never a toast; no toast primitive exists in
 * this repo and none may enter it. Left-aligned on the card surface: glyph inline-left,
 * title, an explanation that states the mechanism honestly, ONE action.
 *
 * `tone` selects the halted family's achromatic maximum-contrast frame (T18 — the only
 * `border-foreground` in the product, shared with the divergence card) for stops that
 * belong to it (wallet-changed); every mechanical refusal stays neutral chroma — the P2
 * connection-line rule: mechanical refusal is not an emergency.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { TransactionButton } from "./transaction-button";

export interface StopCardProps {
  readonly icon: LucideIcon;
  readonly title: string;
  /** The mechanism, stated honestly, in prose. */
  readonly explanation: ReactNode;
  /** ONE action (T27). Verb labels: "Retry", "Start a fresh session", "Re-simulate". */
  readonly action?: {
    readonly label: string;
    readonly onAct: () => void;
    readonly gateReason?: string | null;
  };
  readonly tone?: "neutral" | "halted";
}

export function StopCard({ icon: Icon, title, explanation, action, tone = "neutral" }: StopCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-4",
        tone === "halted" ? "border-foreground" : "border-border",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            tone === "halted" ? "text-foreground" : "text-muted-foreground",
          )}
        />
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{explanation}</div>
      {action === undefined ? null : (
        <div className="mt-3">
          <TransactionButton
            onClick={action.onAct}
            gateReason={action.gateReason ?? null}
            size="sm"
          >
            {action.label}
          </TransactionButton>
        </div>
      )}
    </div>
  );
}
