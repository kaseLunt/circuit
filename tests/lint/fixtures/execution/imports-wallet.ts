/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * `src/lib/execution/` is pure by contract: no React, no framework, no chain client — and,
 * from W08 on, no wallet boundary either. The execution machine is HANDED
 * `WalletSession.address` by its driver; a module that could reach for the wallet itself
 * would have reached for React and connector I/O with it, and the purity contract the rest
 * of the block enforces would be moot.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; asserted by
 * `tests/lint/w08-boundaries.test.ts`. Do not "fix" this file.
 */
import * as walletGate from "../../../../src/lib/wallet/gate"; // @route:execution-imports-wallet-file
import * as walletDir from "../../../../src/lib/wallet"; // @route:execution-imports-wallet-dir

export const gate = walletGate;
export const boundary = walletDir;
