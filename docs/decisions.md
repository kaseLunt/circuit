# Engineering decisions

Short records of load-bearing choices. Governance-level decisions live in
`roadmap/decisions/`; this file records product/engineering decisions and their evidence.

## P0 (2026-07-23)

### Name: Circuit — Visual DeFi Strategy Builder

Owner decision. Brand name carries the identity ("Circuit" — block graphs are circuits you
compose); the descriptive subtitle carries the meaning; the category term stays out of the
primary name. Repo slug: `circuit`. Vercel subdomain resolved at first deploy (fallbacks
acceptable; custom domain optional later).

### Display face: system stack (revisit at P4)

Per SPEC §7: no face from the overexposed AI-landing set, and no face ships unless it earns its
place. None has yet — v1 uses the tightly-set system stacks already in the token file
(`--font-sans`, `--font-mono`), with `tabular-nums` carrying the numeric identity. The canvas is
the visual identity. Revisit as a P4 polish item; any candidate face must beat system type in a
side-by-side before it lands.

### Sandbox provider: self-hosted anvil fork

Evidence: `spikes/sandbox-proof/` — an executable proof (all checks passed, output committed)
demonstrating every SPEC §11 P0 gate item on anvil v1.7.1: fork-block identity across two
concurrent sessions, per-session isolation, `anvil_setBalance` faucet, sane gas estimation on
forked state, unsigned execution via impersonation (a real WETH deposit against forked mainnet
state), `evm_snapshot`/`evm_revert`, and 127.0.0.1-only binding.

Comparison: Tenderly Virtual TestNets offer managed hosting and public explorer links but are
paid/sales-gated with fixed sync modes and an externally-owned quota — and a second independent
review flagged their Admin-RPC exposure rules and TTL mechanics as integration risks. Anvil is
free, deterministic, self-hosted (small container at ~$5–10/mo), and doubles as the CI fork-test
runner (SPEC §8) — one tool for both the sandbox and the test suite. Trade-off accepted: no
public explorer links in sandbox mode; the step list's own receipt rendering covers that role.

Production security contract (SPEC §6) restated: the fork RPC is reachable only by the server;
the server executes only calldata it built from a validated graph; sessions are keyed, TTL'd,
and capped.

### Protocol target: pinned facts

See `docs/protocol-matrix.md` (verified 2026-07-22, block ≈25,592,355): Aave v3 Ethereum Core,
deployed revision v3.6 (custom errors), e-mode category 1 "ETH correlated" (93% LTV / 95% LT /
1% bonus; weETH collateral, WETH borrowable), weETH reserve collateral-only at ~96% supply-cap
utilization (~43k headroom — cap validation is mandatory, SPEC §5.7), WETH reserve with ample
headroom. Raw read log: `docs/protocol-matrix-reads.json`.

## W04 addenda (2026-07-23)

### Revision correction: Aave v3.7, not v3.6

The initial matrix inferred v3.6 from a stale changelog read. Corrected via implementation
mapping (matrix §2): on-chain Pool impl equals the address-book `POOL_IMPL`, and the Aave
changelog records v3.7 Part 2 reaching Ethereum Core on 2026-05-29. Recorded here because a
generated document overclaimed once; the reads script + "cite only the committed log" rule are
the structural fix.

### P3a deferred gates (sandbox operability — not proven by the W01 spike)

The anvil spike proved local primitives only. Before P3a closes, each of the following needs
its own executable proof: TTL destruction and crash cleanup; durable session ownership
(registry or provider hard-limit rejection); per-session and global rate/tx caps under
concurrent load; startup latency and memory under N concurrent forks; reverse-proxy boundary
(the negative reachability test rerun from outside the host, not just a non-loopback local
address); upstream RPC quota behavior; gas/simulation fidelity for the full 13-step bundle.
