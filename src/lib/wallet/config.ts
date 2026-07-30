/**
 * The wagmi configuration — the ONLY place a connector is constructed.
 *
 * What this client is for, exactly: connector state (`accountsChanged`/`chainChanged`),
 * `eth_requestAccounts`, and — when live execution is wired — `eth_sendTransaction` and
 * signing. That is the whole list. Money-bearing reads never travel it (treatment §1.1,
 * seam A1): the injected provider is attacker-controllable, a malicious extension can forge
 * receipt logs, and attribution therefore reads the chain-record facet through our own
 * configured RPC in `server/chain`. The boundary is lint-enforced, not promised.
 *
 * The mock connector is configured from a build-time env var so a production build carries
 * exactly one connector — `injected`. It is IDENTIFIABLE (`connectorId`) and never SPECIAL:
 * nothing in `core/`, in the gate, or in the execution machine branches on which connector
 * produced a `WalletSession` (treatment §1.2, last row).
 */
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { mainnet } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";
import { getAddress, isAddress, type Address, type Transport } from "viem";
import { mockConnectorIdAt } from "./connectors";

/**
 * The id vocabulary lives in `./connectors.ts` — wagmi-free, so a module that only needs to
 * ask whether a session came from a fabricated wallet does not import the connector stack to
 * find out. Re-exported here because this file is where a reader looks for it.
 */
export { INJECTED_CONNECTOR_ID, MOCK_CONNECTOR_ID, isMockConnectorId } from "./connectors";

/**
 * Demo/CI accounts for the mock connector, comma-separated, checksummed or lowercase.
 *
 * Read as a literal member expression because that is the form Next inlines at build time.
 * A malformed entry THROWS rather than being skipped: a test wallet that silently failed to
 * configure would make SPEC §3 step 7 pass by not running, which is the failure mode the
 * whole evidence discipline exists to refuse.
 */
const MOCK_ACCOUNTS_RAW = process.env.NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS;

export function parseMockAccounts(raw: string | undefined): readonly Address[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      if (!isAddress(entry)) {
        throw new Error(
          `NEXT_PUBLIC_WALLET_MOCK_ACCOUNTS contains a value that is not an address: ${entry}`,
        );
      }
      return getAddress(entry);
    });
}

export const MOCK_ACCOUNTS = parseMockAccounts(MOCK_ACCOUNTS_RAW);

/**
 * Which of the mock accounts the demo seam reports as already holding an Aave Core position,
 * and which as code-bearing. Both drive REFUSALS and nothing else: no money-math reads them,
 * no quantity is derived from them, and a production build (no mock accounts) has no scenario
 * table at all. Named separately from the account list so the scenario is stated, not
 * inferred from position in an array.
 */
export const MOCK_OCCUPIED_ACCOUNTS = parseMockAccounts(
  process.env.NEXT_PUBLIC_WALLET_MOCK_OCCUPIED,
);
export const MOCK_CODE_BEARING_ACCOUNTS = parseMockAccounts(
  process.env.NEXT_PUBLIC_WALLET_MOCK_CODE_BEARING,
);

/**
 * ONE mock connector per configured account, so a test can choose WHICH wallet connects.
 *
 * wagmi's `mock` fixes its connector id, and two connectors sharing an id cannot be told
 * apart by the connect surface — so every mock past the first is re-identified. Nothing but
 * display and selection reads the id (treatment §1.2, last row); no gate, no money-math and
 * no execution state branches on it.
 */
function mockConnectorFor(account: Address, index: number): CreateConnectorFn {
  const base = mock({
    accounts: [account],
    features: {
      // The mock signs nothing by itself; W08 gates live execution before any signature
      // request, and the sandbox arc is where a full run is proven. Leaving this false
      // means a test that reached a signature request would FAIL rather than fabricate a
      // hash — an optimistic-UX tripwire (A15) rather than a convenience.
      defaultConnected: false,
    },
  });
  if (index === 0) return base;
  return (config) => ({
    ...base(config),
    id: mockConnectorIdAt(index),
    name: `Mock Wallet ${index + 1}`,
  });
}

function connectorsFor(mockAccounts: readonly Address[]): readonly CreateConnectorFn[] {
  const injectedConnector = injected({ shimDisconnect: true });
  return [injectedConnector, ...mockAccounts.map(mockConnectorFor)];
}

/**
 * Storage is deliberately absent. Auto-reconnect on load would put the app in Live mode
 * before the user asked for it, and a reconnect racing hydration is exactly the class of
 * bug the composer's arrival path was built to avoid. Connecting is an explicit act, once
 * per session.
 *
 * `ssr: false` follows from the same choice: with nothing persisted there is no server-side
 * state to hydrate, so the first client paint and the prerender agree — disconnected.
 */
export function createWalletConfig(
  mockAccounts: readonly Address[] = MOCK_ACCOUNTS,
  /**
   * The chain transport wagmi uses for CONNECTOR STATE ONLY — chain id, connection status,
   * and the requests a connector forwards rather than answers itself. It is NOT the money
   * read path and must never become one; attribution reads through `server/chain`'s
   * configured RPC (seam A1). Injectable so a test can run the real connector code with no
   * socket: a suite that reached the public RPC would be asserting the internet's uptime.
   */
  transport: Transport = http(),
) {
  return createConfig({
    chains: [mainnet],
    connectors: [...connectorsFor(mockAccounts)],
    transports: { [mainnet.id]: transport },
    storage: null,
    ssr: false,
  });
}

export type WalletConfig = ReturnType<typeof createWalletConfig>;
