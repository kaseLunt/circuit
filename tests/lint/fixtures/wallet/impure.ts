/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail the boundary gate.
 *
 * The wallet boundary observes TRANSPORT and nothing else (treatment §1.1). Two routes out
 * of that contract are closed by name:
 *
 *  - MINTING. Nothing the wallet observes becomes `Observed`. `core/provenance`'s minter is
 *    the only construction site for the shape, and it stays unreachable from here (A19).
 *  - READING. The seam readings (`eth_getCode`, the SPEC §2 footprint predicate) come from
 *    `server/chain`'s configured RPC through the injected seam source. A client opened HERE
 *    would be a chain read performed by the wallet's own module — the shape of the defect
 *    even when the transport happens to be honest.
 *
 * ONE PROHIBITED ROUTE PER LINE, each tagged `@route:<name>`; asserted by
 * `tests/lint/w08-boundaries.test.ts`. Do not "fix" this file.
 */
import { createClient } from "viem"; // @route:wallet-viem-createClient
import { createPublicClient } from "viem"; // @route:wallet-viem-createPublicClient
import { createTestClient } from "viem"; // @route:wallet-viem-createTestClient
import { createTransport } from "viem"; // @route:wallet-viem-createTransport
import { observationMinter } from "../../../../src/core/provenance"; // @route:wallet-mints-provenance
import { captureChainSnapshot } from "../../../../src/server/chain/snapshot"; // @route:wallet-imports-server

export const clients = [createClient, createPublicClient, createTestClient, createTransport];
export const mint = observationMinter;
export const capture = captureChainSnapshot;
