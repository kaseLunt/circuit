"use client";

/**
 * The composer's chrome band: what this session IS, stated once, at the top.
 *
 * SPEC §3 step 1 requires a visible Sandbox badge, and §5 requires the state to be labelled
 * honestly rather than implied. The badge is ACHROMATIC — same grammar as the canvas AUTO
 * chip — because sandbox is the default experience, not a degraded one and not a warning.
 * Spending `--warning` here would devalue the one colour the borrow block needs in §3
 * step 3, and would tell the user something is wrong when nothing is.
 *
 * The block citation is not decoration: it is the same pinned block every provenance
 * tooltip on the screen cites, read from the snapshot rather than restated, so the chrome
 * cannot drift from the numbers.
 *
 * `h-9` is the one row height the composer uses everywhere — sidebar rows, tabs, panel rows,
 * palette rows. The chrome is a row like any other and does not get to be taller.
 */

import { AlertTriangle } from "lucide-react";
import { formatBlockTime } from "../../core/format";
import { cn } from "../../lib/utils";
import type { SnapshotState } from "./simulation-host";

interface SandboxChromeProps {
  readonly snapshot: SnapshotState;
}

/**
 * "block time", stated rather than implied. The timestamp is the SOURCE BLOCK's, not the
 * moment the RPC answered, and an unlabelled instant beside the word "reads" invites
 * exactly the wrong reading. The same vocabulary holds in every provenance tooltip.
 */
function citation(ready: Extract<SnapshotState, { status: "ready" }>): string {
  return `Block-pinned reads · block ${ready.snapshot.block} · block time ${formatBlockTime(
    Number(ready.snapshot.blockTimestamp),
  )}`;
}

export function SandboxChrome({ snapshot }: SandboxChromeProps) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      <span className="text-sm font-medium text-foreground">Circuit</span>
      <span
        className={cn(
          "rounded-sm border border-border px-1.5 py-0.5",
          "text-label uppercase tracking-wider text-muted-foreground",
        )}
      >
        Sandbox
      </span>

      {snapshot.status === "unavailable" ? (
        // The InlineError grammar, because this IS one: the read set the entire screen is
        // built on could not be loaded. Deliberately NOT truncated — a truncated failure
        // reason is a failure to report, and this is the only place the reason appears.
        <div role="alert" className={cn("ml-auto flex min-w-0 items-center gap-2 text-xs")}>
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="text-foreground">Read set unavailable — {snapshot.reason}</span>
        </div>
      ) : (
        <p className={cn("ml-auto truncate text-xs tabular-nums text-muted-foreground")}>
          {snapshot.status === "loading" ? "Reading the block-pinned set…" : citation(snapshot)}
        </p>
      )}
    </header>
  );
}
