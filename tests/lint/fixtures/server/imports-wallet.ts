/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * Seam A1 stated from the money side. `src/server/**` is where every money-bearing read is
 * performed — the attribution receipts, the allowance reads, the `getUserAccountData`
 * cross-check. If a server module could reach the wallet stack, one of those reads could be
 * answered by the injected provider, which is the single route the whole boundary exists to
 * close ("a malicious extension can forge receipt logs", treatment §1.1).
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; asserted by
 * `tests/lint/w08-boundaries.test.ts`. Do not "fix" this file.
 */
import { createConfig } from "wagmi"; // @route:server-imports-wagmi
import * as connectors from "wagmi/connectors"; // @route:server-imports-wagmi-subpath
import * as walletDir from "../../../../src/lib/wallet"; // @route:server-imports-wallet-dir
import * as walletFile from "../../../../src/lib/wallet/gate"; // @route:server-imports-wallet-file

export const config = createConfig;
export const available = connectors;
export const boundary = walletDir;
export const gate = walletFile;
