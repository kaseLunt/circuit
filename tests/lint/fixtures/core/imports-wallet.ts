/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * The W08 half of the money↔transport quarantine: `src/core/` may not reach the wallet stack.
 * The injected provider is attacker-controllable (treatment §1.1, seam A1), so a `core/`
 * module able to import wagmi — or the wallet boundary that wraps it — could read a forged
 * balance straight into money-math.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; the exact (route, ruleId)
 * multiset is asserted by `tests/lint/w08-boundaries.test.ts` (doctrine D5 — gaps AND surplus
 * both fail). Do not "fix" this file: deleting a violation deletes the evidence.
 */
import { createConfig } from "wagmi"; // @route:core-imports-wagmi
import { injected } from "wagmi/connectors"; // @route:core-imports-wagmi-subpath
import * as walletFile from "../../../../src/lib/wallet/gate"; // @route:core-imports-wallet-file
import * as walletDir from "../../../../src/lib/wallet"; // @route:core-imports-wallet-dir

export const config = createConfig;
export const connector = injected;
export const gate = walletFile;
export const boundary = walletDir;
