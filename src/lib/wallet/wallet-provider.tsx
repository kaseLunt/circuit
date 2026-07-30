"use client";

/**
 * The wallet boundary's only React surface.
 *
 * It does three things and nothing else: it mounts wagmi, it narrows wagmi's account state
 * into the ONE shape the rest of the app may see (`WalletSession`), and it fetches the seam
 * readings the pure gate consumes. Every decision that follows — chain refusal, the
 * `eth_getCode` refusal, the footprint refusal, the freshness regate, whether a wallet
 * change is a departure — is imported from `gate.ts` (doctrine D10: this file is mechanical
 * thread-through of decisions taken in covered pure code).
 *
 * Nothing here mints provenance, and nothing here can: `WalletSession` carries an address, a
 * chain id and a connector id, and the `{ kind: "observed" }` literal ban plus the absence of
 * any `ObservationMinter` outside `server/chain` make the transport→money route unreachable
 * rather than merely discouraged (seam A19).
 *
 * The address crosses toward money-math exactly once, as the `user` argument of
 * `captureChainSnapshot` — which is the consumer's call, made server-side, not this file's.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { getAddress } from "viem";
import { createWalletConfig, MOCK_ACCOUNTS, type WalletConfig } from "./config";
import { unavailableReadings, type WalletSeamSource } from "./seam";
import type { WalletConnection, WalletSeamReadings, WalletSession } from "./types";

/** A connector as the connect surface renders it — id and name, nothing executable. */
export interface ConnectorChoice {
  readonly id: string;
  readonly name: string;
}

export interface WalletBoundary {
  readonly connection: WalletConnection;
  /** Present exactly when `connection.kind === "connected"`. */
  readonly session: WalletSession | null;
  /**
   * The seam readings for the connected address. Until they resolve they are the explicit
   * unknown state, so the gate refuses rather than admits — a pending read is not a clear
   * one (SPEC §5).
   */
  readonly readings: WalletSeamReadings;
  readonly connectors: readonly ConnectorChoice[];
  connect(connectorId: string): void;
  disconnect(): void;
  /**
   * A monotonic reading, for the freshness gate's enforcement clock (D9). Wall time is the
   * display track and lives elsewhere; nothing that GATES may read it.
   */
  monotonicNow(): number;
}

const SEAM_PENDING_REASON = "the wallet's chain readings have not resolved yet";
const NO_SEAM_REASON =
  "no mainnet chain source is configured in this deployment, so the wallet's code and Aave footprint cannot be read";

const BoundaryContext = createContext<WalletBoundary | null>(null);

/**
 * The default seam in a build with no chain source wired: it answers "unknown", which the
 * gate turns into a stated refusal. It never answers "clear".
 */
const defaultSeam: WalletSeamSource = {
  read: () => Promise.resolve(unavailableReadings(NO_SEAM_REASON)),
};

export interface WalletProviderProps {
  readonly children: ReactNode;
  /** Injected in tests; production composes one from `createWalletConfig`. */
  readonly config?: WalletConfig;
  readonly seam?: WalletSeamSource;
  /**
   * The enforcement clock, injectable for the same reason the seam is: a freshness bound that
   * can only be observed by waiting two real minutes is a bound no test can hold to account.
   * Production passes nothing and gets `performance.now()` below — the monotonic reading D9
   * requires. A test's clock is still monotonic; it is merely one the test advances.
   */
  readonly monotonicNow?: () => number;
}

export function WalletProvider({ children, config, seam, monotonicNow }: WalletProviderProps) {
  // One config and one query client per mount. wagmi keys its whole store off the config
  // object, so recreating it on render would drop the connection every time.
  const [walletConfig] = useState(() => config ?? createWalletConfig());
  const [queryClient] = useState(() => new QueryClient());
  return (
    /*
     * `reconnectOnMount={false}` is the other half of `storage: null` (config.ts): nothing
     * is persisted, so there is nothing to restore, and asking wagmi to try leaves
     * `useAccount().status` sitting at "reconnecting" forever — which read as "a connect is
     * in flight" and GATED the connect button permanently. Connecting is an explicit act
     * once per session; the mount does not pretend otherwise.
     */
    <WagmiProvider config={walletConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <BoundaryBridge
          seam={seam ?? defaultSeam}
          monotonicNow={monotonicNow ?? monotonicPerformanceNow}
        >
          {children}
        </BoundaryBridge>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** Narrow wagmi's account state to `WalletSession`, or to a stated non-session. */
function connectionOf(
  address: `0x${string}` | undefined,
  chainId: number | undefined,
  connector: Connector | undefined,
  status: ReturnType<typeof useAccount>["status"],
  failure: string | null,
): WalletConnection {
  if (failure !== null) return { kind: "connect-failed", detail: failure };
  // "reconnecting" is deliberately NOT "connecting": with nothing persisted there is no
  // restore in flight, and reporting one would gate the connect control on a wait that
  // never ends. Only an explicit connect attempt is `connecting`.
  if (status === "connecting") return { kind: "connecting" };
  if (status !== "connected" || address === undefined || chainId === undefined) {
    return { kind: "disconnected" };
  }
  return {
    kind: "connected",
    session: {
      address: getAddress(address),
      chainId,
      // wagmi always supplies a connector on a connected account; the fallback names the
      // absence rather than inventing an id, and no gate reads this field.
      connectorId: connector === undefined ? "unknown" : connector.id,
    },
  };
}

function BoundaryBridge({
  seam,
  monotonicNow,
  children,
}: {
  readonly seam: WalletSeamSource;
  readonly monotonicNow: () => number;
  readonly children: ReactNode;
}) {
  const account = useAccount();
  const { connectors, connect: wagmiConnect, error: connectError } = useConnect();
  const { disconnect: wagmiDisconnect } = useDisconnect();

  const failure = connectError === null || connectError === undefined ? null : connectError.message;
  const connection = connectionOf(
    account.address,
    account.chainId,
    account.connector,
    account.status,
    failure,
  );
  const session = connection.kind === "connected" ? connection.session : null;
  const address = session === null ? null : session.address;
  // The connector rides along to the seam because WHICH source may answer is a fact about the
  // session's transport (src/lib/live/readiness-source.ts) — it is not read as a gate input
  // here or anywhere below.
  const connectorId = session === null ? null : session.connectorId;
  const identity = session === null ? null : `${session.address}@${session.connectorId}`;

  const [readings, setReadings] = useState<WalletSeamReadings>(() =>
    unavailableReadings(SEAM_PENDING_REASON),
  );
  // The IDENTITY the current readings belong to, tracked as RENDER-TIME state adjustment (the
  // pattern this codebase uses instead of a setState in an effect body). The readings reset
  // to the explicit unknown state in the same render the identity changes, so no frame ever
  // pairs one wallet's footprint with another's address — the split-position mistake the
  // whole seam exists to refuse. The effect below only adopts what the async read returns.
  //
  // Address AND connector, because the two together are what a reading is about: the same
  // address arriving by a different transport is answered by a different source, so carrying
  // the old reading across would be exactly the mismatch this reset exists to prevent.
  const [readFor, setReadFor] = useState<string | null>(identity);
  if (readFor !== identity) {
    setReadFor(identity);
    setReadings(unavailableReadings(SEAM_PENDING_REASON));
  }
  // A reading that resolves for a wallet that has since changed is DISCARDED. `live` covers
  // unmount and re-run; the identity comparison covers the case where a stale promise settles
  // after the identity moved on.
  const liveRead = useRef<string | null>(null);
  useEffect(() => {
    liveRead.current = identity;
    if (address === null || connectorId === null) return;
    let current = true;
    seam
      .read({ address, connectorId })
      .then((next) => {
        if (current && liveRead.current === identity) setReadings(next);
      })
      .catch((cause: unknown) => {
        if (!current || liveRead.current !== identity) return;
        const detail = cause instanceof Error ? cause.message : String(cause);
        setReadings(unavailableReadings(`the wallet's chain readings failed: ${detail}`));
      });
    return () => {
      current = false;
    };
  }, [address, connectorId, identity, seam]);

  const choices = useMemo(
    () => connectors.map((connector) => ({ id: connector.id, name: connector.name })),
    [connectors],
  );

  const connect = useCallback(
    (connectorId: string) => {
      const connector = connectors.find((candidate) => candidate.id === connectorId);
      if (connector === undefined) return;
      wagmiConnect({ connector });
    },
    [connectors, wagmiConnect],
  );

  const disconnect = useCallback(() => wagmiDisconnect(), [wagmiDisconnect]);

  const boundary: WalletBoundary = {
    connection,
    session,
    readings,
    connectors: choices,
    connect,
    disconnect,
    monotonicNow,
  };

  return <BoundaryContext.Provider value={boundary}>{children}</BoundaryContext.Provider>;
}

/**
 * `performance.now()` where it exists, and a stated refusal to pretend where it does not:
 * the enforcement clock must be monotonic (D9), and `Date.now()` is not — a backward wall
 * correction would extend the freshness budget. Server renders never gate, so returning 0
 * there is not a fallback, it is the absence of a gate.
 */
function monotonicPerformanceNow(): number {
  if (typeof performance === "undefined") return 0;
  return performance.now();
}

/** The connect surface's hook. Throws outside the provider — a wiring bug, not a state. */
export function useWalletBoundary(): WalletBoundary {
  const boundary = useContext(BoundaryContext);
  if (boundary === null) {
    throw new Error("useWalletBoundary must be used inside <WalletProvider>");
  }
  return boundary;
}

/** True when this build configured mock accounts — the CI/demo wiring, never production. */
export function hasMockConnector(): boolean {
  return MOCK_ACCOUNTS.length > 0;
}
