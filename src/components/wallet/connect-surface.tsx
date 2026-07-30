"use client";

/**
 * The connect surface and the live-mode refusal card — SPEC §3 step 7's visible half.
 *
 * It decides nothing. The mode, the refusal, and the sentence that explains it all come from
 * `src/lib/wallet/gate.ts`, which is pure and unit-proven; this file maps a verdict to the
 * T27 designed-stop grammar and a connector list to buttons. That split is doctrine D10, and
 * it is why "the footprint predicate refuses a wallet already holding a position" is provable
 * without a browser.
 *
 * Chroma: none. A refusal here is MECHANICAL — the P2 connection-line rule, restated by T27:
 * mechanical refusal is not an emergency. `wallet-changed` is the one member of the halted
 * family and takes the achromatic maximum-contrast frame (T18); everything else is neutral.
 */
import { Wallet, WalletMinimal } from "lucide-react";
import type { LiveExecuteRefusal } from "../../lib/wallet/gate";
import { useWalletBoundary } from "../../lib/wallet/wallet-provider";
import { StopCard } from "../tx/stop-card";
import { TransactionButton } from "../tx/transaction-button";

/** Sandbox until a wallet is connected; Live the moment one is (SPEC §3 step 7). */
export type ComposerMode = "sandbox" | "live";

/**
 * The T27 copy for every live refusal, stating the MECHANISM — never a verdict about the
 * user and never a safety claim. Two of these are quoted from the taste treatment verbatim
 * (`wallet-changed`, `contract-wallet`); the rest follow their grammar.
 */
export function liveRefusalCopy(refusal: LiveExecuteRefusal): {
  readonly title: string;
  readonly explanation: string;
} {
  switch (refusal.kind) {
    case "not-connected":
      return {
        title: "No wallet connected",
        explanation: "Live execution signs from a wallet. Connect one to continue.",
      };
    case "wrong-chain":
      return {
        title: "Wrong network",
        explanation: `This strategy's calldata addresses Ethereum mainnet (chain ${refusal.expected}). The wallet is on chain ${refusal.chainId}, where the same bytes reach different contracts.`,
      };
    case "code-bearing-wallet":
      return {
        title: "This wallet has code deployed",
        explanation:
          "Plans containing a WETH withdrawal can fail in code-bearing wallets, so execution is refused. WETH9 sends ETH with a 2300-gas stipend, and a delegated or contract account can exhaust it.",
      };
    case "code-unknown":
      return {
        title: "The wallet's code could not be read",
        explanation: `This plan contains a WETH withdrawal, which needs a code-free account, and the check did not resolve: ${refusal.reason}.`,
      };
    case "existing-footprint":
      return {
        title: "This wallet already has an Aave position",
        explanation:
          "Live mode opens a new position and does not merge into an existing one — any aToken balance or debt on Aave Core, collateral-enabled or not. Merging would change the risk numbers this screen shows.",
      };
    case "footprint-unknown":
      return {
        title: "The wallet's Aave position could not be read",
        explanation: `Live mode refuses a wallet that already holds a position, and the check did not resolve: ${refusal.reason}.`,
      };
    case "no-fresh-simulation":
      return {
        title: "No simulation against this wallet's balances yet",
        explanation:
          "Live execution is gated on a fresh simulation run against the connected wallet's real balances. Nothing has been simulated for this wallet.",
      };
    case "stale-simulation":
      return {
        title: "The simulation is out of date",
        explanation: `It was run ${Math.round(refusal.ageMs / 1000)}s ago and live execution regates past ${Math.round(
          refusal.maxAgeMs / 1000,
        )}s. Re-simulate to price it against current state.`,
      };
    case "simulation-address-drift":
      return {
        title: "The simulation belongs to a different wallet",
        explanation: `It was run against ${refusal.simulatedFor}, and ${refusal.connected} is connected. A simulation against another wallet's balances answers a different question.`,
      };
    case "plan-drift":
      return {
        title: "The strategy changed after it was simulated",
        explanation:
          refusal.current === null
            ? "The document no longer produces a plan over the captured chain state, so the simulated result is about a strategy that no longer exists. Re-simulate to price what is on the canvas now."
            : "The plan on the canvas is not the plan that was simulated — an edit changed its steps or amounts. A drifted simulation is not stale, it answers a different question; re-simulate to price this one.",
      };
    case "snapshot-drift":
      return {
        title: "The simulation is pinned to different chain state",
        explanation: `It priced against block ${refusal.simulatedAt.block}${
          refusal.current === null
            ? ", and no captured chain state is currently in hand"
            : `, and the capture in hand is block ${refusal.current.block}`
        }. Re-simulate so the result and the state it is about are the same thing.`,
      };
  }
}

/**
 * The chrome's connect control. Disconnected, it offers each configured connector by name;
 * connected, it states the address and offers Disconnect. No chroma, no icon-only mystery
 * button — the wallet is named.
 */
export function ConnectSurface() {
  const wallet = useWalletBoundary();
  const connection = wallet.connection;

  if (connection.kind === "connected") {
    const { address, connectorId } = connection.session;
    return (
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="font-mono text-xs tabular-nums text-muted-foreground"
          title={address}
          data-testid="wallet-address"
        >
          {`${address.slice(0, 6)}…${address.slice(-4)}`}
        </span>
        <span className="text-label uppercase tracking-wider text-muted-foreground">
          {connectorId}
        </span>
        <TransactionButton size="sm" variant="ghost" onClick={wallet.disconnect} gateReason={null}>
          Disconnect
        </TransactionButton>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {connection.kind === "connect-failed" ? (
        <span role="alert" className="text-xs text-muted-foreground">
          {`Connect failed: ${connection.detail}`}
        </span>
      ) : null}
      {wallet.connectors.map((connector) => (
        <TransactionButton
          key={connector.id}
          size="sm"
          variant="default"
          onClick={() => wallet.connect(connector.id)}
          gateReason={connection.kind === "connecting" ? "Connecting…" : null}
        >
          {`Connect ${connector.name}`}
        </TransactionButton>
      ))}
    </div>
  );
}

/**
 * The live refusal, rendered where the Execute control would be. `wallet-changed` is not
 * handled here — it is a MACHINE state (`halted-wallet-changed`) and renders through the
 * execution flow's halted family, because by then money has already moved.
 */
export function LiveRefusalCard({
  refusal,
  onReconnect,
}: {
  readonly refusal: LiveExecuteRefusal;
  readonly onReconnect?: () => void;
}) {
  const copy = liveRefusalCopy(refusal);
  const icon = refusal.kind === "not-connected" ? WalletMinimal : Wallet;
  return (
    <StopCard
      icon={icon}
      title={copy.title}
      explanation={copy.explanation}
      {...(onReconnect === undefined
        ? {}
        : { action: { label: "Reconnect", onAct: onReconnect, gateReason: null } })}
    />
  );
}
