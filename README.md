# Circuit — Visual DeFi Strategy Builder

> Compose DeFi strategies as visual circuits — every number on screen carries its provenance (observed
> on chain, derived by tested math, or entered by you), every money-path is unit- and
> fork-tested, and the execution UX is the part I'm proudest of.

**Status: in development (P0 — bootstrap).** This README grows with the product; nothing is
claimed here before CI proves it.

## What it will be

Compose DeFi strategies as a typed block graph — stake (EtherFi/Lido), wrap, supply and borrow
(Aave v3 Ethereum Core) — with live on-chain rates, health factor rendered on the canvas as you
drag allocations, honest simulation, and a sandboxed forked-mainnet execution mode anyone can
try without a wallet.

## Principles

- **Every number is real.** No hardcoded prices, no fabricated APYs, no silent fallbacks —
  enforced by typed provenance (`Provenanced<T>`) and lint rules, proven by unit and
  pinned-mainnet-fork tests in CI.
- **Finance before polish.** The 13-step flagship plan must execute green against a mainnet fork
  in CI before any canvas work begins.
- **Scope restraint.** Ethereum mainnet only, one Aave market, five block types. Anything else
  is a recorded decision, not scope drift.

## Stack

Next.js 16 · React 19 · TypeScript (strict) · Tailwind 4 · viem/wagmi · React Flow · vitest ·
anvil fork tests · Playwright

## Development

```bash
npm ci
npm run dev        # dev server
npm run build      # production build (no env vars required)
npm run typecheck  # tsc --noEmit
npm run lint       # zero-warning policy
npm test           # vitest
```

Project governance lives in `roadmap/` (typed work objects, evidence receipts); the product
contract is `SPEC.md`.

## License

MIT
