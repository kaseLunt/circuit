# CLAUDE.md

Enforcement rules for this repository. The product contract lives in `SPEC.md`; the porting
contract in `TRANSPLANT.md`; session/authority protocol in `AGENTS.md` and `roadmap/RULES.md`.
These rules are binding on every change.

## Money rules (SPEC §5)

- **No silent numeric fallbacks, ever.** No `?? <number>`, no default prices/rates, no
  hand-typed contract addresses. A missing source renders an explicit unavailable state.
- Every renderable quantity is `Provenanced<T>`: `Observed` (chain read: source + block +
  fetchedAt), `Derived` (tested math over provenanced inputs), `Entered` (user input), or
  `Configured` (named constant with definition site). Nothing launders a literal into `Observed`.
- Exchange rates are read on-chain; APRs are derived from rate deltas; Aave rates are labeled
  current-rate run-rate. Prices come from the Aave Oracle in the risk path.
- Execution amounts are step-output attributions (share deltas for rebasing eETH, argument
  values for WETH withdraw, Transfer events otherwise) — never `balanceOf` sweeps.
- All finance math lives in `core/` (pure: no fetch, no I/O, no React) and consumes block-pinned
  snapshots from `server/chain/`. Transaction-transport observation (receipts, nonces, wallet
  state) is the client's and never feeds money-math.

## Taste rules (SPEC §7)

- Dark-only v1. One design language: the token system in `src/app/globals.css`. New colors,
  radii, and motion values come from tokens, not literals.
- Color is semantic (state), never decorative-per-type. No glows, no gradient text, no ambient
  backgrounds, no entrance animations, no pulse effects.
- Motion uses `--motion-fast` / `--motion-slow` / `--ease-standard`; everything animated has a
  `prefers-reduced-motion` treatment.
- `tabular-nums` wherever digits align. All number formatting through `core/format.ts` (once it
  exists) — never inline `toFixed`/`toLocaleString` in components.
- A11y floor: keyboard operability, visible focus (`.focus-ring`), ARIA on interactive controls,
  no `user-select: none`.
- React Flow chrome (when it lands) is fully custom-styled from tokens; the default stylesheet
  look never ships.

## Code hygiene

- No narrating comments, no section-banner ASCII art. Comments only for non-obvious WHY.
- No `console.log` (lint-enforced); no `any`, no `@ts-ignore`, no `eslint-disable`.
- Zero-warning lint policy; `npm run build`, `typecheck`, `lint`, `test` must be green before
  any commit that touches them.

## Porting protocol (SPEC §10)

The earlier prototype is a read-only parts bin. Only files listed in `TRANSPLANT.md` may be
opened there; `port-with-edits` files land with ALL listed edits in the same commit; anything
not in the manifest does not exist. One module per port commit, provenance in the message.

## Governance

Serial writer. Work flows through typed objects in `roadmap/` — see `AGENTS.md` for the session
protocol. Commit policy is D-002 (`roadmap/decisions/`): conventional narrative commits, no AI
attribution trailers, no hook bypasses.
