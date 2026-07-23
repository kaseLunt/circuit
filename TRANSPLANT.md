# TRANSPLANT.md — vetted parts manifest

> Generated from a 15-agent per-file vetting pass over the earlier private
> prototype, 2026-07-22. Governed by SPEC.md §10 porting protocol:
> only files listed here may be opened in the old repo; port-with-edits files land
> with ALL listed edits applied in the same commit; rebuild-reference files are
> read for ideas and rewritten, never copied; anything not listed does not exist.

**Result: 59 files vetted — 0 port-clean, 32 port-with-edits, 23 rebuild-reference, 4 reject.**
Zero files were clean enough to copy unmodified. This is why the repo is fresh.

## Porting order (dependency-driven)

| Phase | Modules |
|---|---|
| P0 | globals.css (token ranges only), lib/utils.ts, components/ui/* |
| P1 | strategy/types.ts → route-optimizer.ts → store (rebuild) → templates (rebuild) → canvas + blocks + edges + sidebar + save-modal |
| P2 | core/ (health-factor ← liquidation.ts ref; format ← utils+portfolio-utils ref; plan ← builder.ts ref), server/lib/rpc.ts, rate-limiter.ts, etherfi-contracts.ts, protocol-metadata.ts |
| P3 | transactions/approvals.ts, execution UI (transaction-preview port; modal/results rebuild), use-transaction-execution (rebuild), tenderly plumbing (services/simulation.ts ref) |
| P5 | sse-connection.ts, pyth/websocket-client.ts, use-live-prices.ts |

## Rejected (do not open)

- **src/components/shared/chain-badge.tsx** (76 loc) — File itself is defect-free (null-guards unknown chains), but the new repo is Ethereum-mainnet-only (§2 cuts multi-chain): a chain badge encodes zero information and drags the multi-chain CHAIN_INFO table. Trivial to rebuild if Base lands in P5.
- **src/lib/transactions/multicall.ts** (491 loc) — Fundamentally unsound, not just fake savings: batching approve/supply/stake via Multicall3 from an EOA makes msg.sender the Multicall3 contract — approvals granted from the wrong account, and aggregate3Value staking would mint stETH/eETH to Multicall3, permanently losing funds. Also decorative: encodeBatch has zero importers; execution sends steps individually while the UI shows fabricated savings (confirmed :442, derived from hardcoded 21000n/2500n at 88-91). Dead var batchedStepCount at 221. The one good idea — batched allowance reads — is viem built-in.
- **src/server/routers/price.ts** (104 loc) — Prisma-coupled (getCachedPrices L78-103, syncPrices L69-75 uses protectedProcedure — auth cut). Spec §5 replaces the CoinGecko price architecture with on-chain rates and priced quotes; new repo's routers are rates/quotes/simulate. Remainder is thin zod boilerplate with zero reference value. Nothing hidden found beyond the coupling.
- **src/server/lib/redis.ts** (117 loc) — Spec §4 is explicit: no Redis in v1, Next runtime cache instead — reject, not hold (porting protocol has no hold state; unlisted files don't exist). File also has defects: L63 eager module-level client duplicates the lazy _redis path (two connections), L62 'backward compatibility' comment for a consumer that never shipped, silent catch-all failure everywhere. If Redis returns in P5, rewrite fresh.

---

## PORT WITH EDITS (32 files)

Every edit below is mandatory and lands in the porting commit itself.

### src/lib/strategy/types.ts
*255 loc · bundle: strategy-types-store*

Block-graph schema core is genuinely good: discriminated union on type, Node<BlockData,BlockType> generics, apy:number|null with null-means-unknown matching SPEC §5.4. Defects are scope bloat, missing WETH, missing AutoWrapBlockData (defined divergently in two other files), and fabrication-inviting SimulationResult fields. All edits mechanical; only dep is @xyflow/react.

**Required edits:**

- L19-20: remove "lp" and "loop" from BlockType — both cut per SPEC §2 v1 block list (keep "auto-wrap", it is the Wrap block)
- L23: AssetType — add "WETH" (SPEC §3 leveraged-loop template borrows WETH; currently unrepresentable); remove "USDT", "rETH", "cbETH", "sfrxETH" (outside v1 scope)
- L25: StakeProtocol — trim to "lido" | "etherfi" per SPEC §2
- L26: LendProtocol — trim to "aave-v3" per SPEC §2
- L32-39: BaseBlockData — declare isAutoInserted?: boolean (store.ts:928 currently reads it via `as Record<string, unknown>` cast; undeclared field)
- L61: LendBlockData.chain: number — delete; v1 is mainnet-only (SPEC §4)
- L64-65: LendBlockData.maxLtv/liquidationThreshold — must be populated from Aave reserve reads, never defaulted (companion fix in rates layer; store.ts:262 currently hardcodes 80/82.5)
- L68-73: BorrowBlockData — add amount config per SPEC §5.3; ltvPercent alone cannot produce calldata. Do NOT add a rate-mode field: Aave v3.2 removed stable borrowing; interestRateMode is hardcoded to 2 (variable) in core/plan.ts
- L83-87: delete LoopBlockData (loop block cut)
- L89-95: BlockData union — drop LoopBlockData; ADD AutoWrapBlockData here as the canonical definition (currently defined divergently in route-optimizer.ts:334 and components/strategy-builder/blocks/auto-wrap-block.tsx:29)
- L128-129: Strategy.createdAt/updatedAt: Date — change to epoch number; Date does not survive JSON round-trip through localStorage/share-URL persistence (SavedSystem L253-254 already does this correctly)
- L140: YieldSource.type — drop "lp" member
- L156-157, L161, L165, L168: SimulationResult — delete projectedValue1Y/projectedYield1Y, protocolFees, riskScore, maxDrawdown unless each gets an honest data source; these fields invited fabricated numbers in the predecessor's simulation engine (SPEC §5/§7). Keep grossApy/netApy/gasCostUsd/healthFactor/liquidationPrice/leverage — all sourceable
- L197-225: ProtocolYield/StakeProtocolInfo/LendProtocolInfo — drop chain/chainId (L199-200) and tvl/logo breadth, or delete the three interfaces entirely if the protocol-catalog module (protocols.ts) is not ported
- L236: StrategyTemplate.estimatedApy: string — delete; hand-written APY claim ("3-4%") violates SPEC §3.2 live-sourced-numbers rule; templates derive APY from live rates

**Drags:** @xyflow/react

### src/lib/strategy/route-optimizer.ts
*697 loc · bundle: optimizer-templates*

Core algorithms (findWrapPath, wrap-preference selection, edge rewiring with position interpolation) are genuinely sound and the spec names this a port. But the praise missed two real bugs: unroutable edges silently pass validation (dead error branch), and beforeBlockId dangles via double Date.now(). Plus fabricated unwrap methods, wrong eETH deposit contract, console.logs, dead import.

**Required edits:**

- L9: delete dead import LENDING_PROTOCOLS (never used in file) — keep STAKING_PROTOCOLS only
- L29-84: trim TOKEN_WRAPPERS to new-spec pairs (ETH→stETH, stETH→wstETH, ETH→eETH, eETH→weETH); delete rETH L61-67, cbETH L68-75, sfrxETH L76-83 (rocketpool/coinbase/frax are out of scope, and their deposit contracts are fabricated anyway — cbETH is not mintable-by-deposit at all)
- L46-52: ETH→eETH entry is wrong for execution: wrapperContract points at the eETH token 0x35fA164735182de50811E8e2E824cFb9B6118ac2 but deposit() lives on the EtherFi LiquidityPool 0x308861A430be4cce5502d0A12724771Fc6DaF216; fix address/target
- L35+L50: unwrapMethod 'withdraw' for stETH and eETH is fabricated — neither token has withdraw(); Lido/EtherFi exit via withdrawal-queue contracts. Remove the unwrap direction for ETH-level pairs or model it honestly (swap-out instead)
- L90-95: PROTOCOL_ACCEPTED_ASSETS — keep only aave-v3 (delete compound-v3, morpho, spark rows); reconcile 'ETH' entry with plan.ts (Aave v3 takes WETH or the WrappedTokenGateway, not raw ETH) and align asset list with what core/rates.ts actually reads
- L101-119: TOKEN_ADDRESSES — delete Arbitrum L111-114 and Base L115-118 (mainnet only per spec §2); then remove the chainId parameter from getAssetAddress L124-126 and the chain lookup L478-480 (blockData.chain ?? 1 silent default)
- L189, L194, L198, L201: silent fallbacks — unknown stake protocol falls back to ['ETH'], unknown lend protocol `PROTOCOL_ACCEPTED_ASSETS[protocol ?? ''] ?? ['ETH']`, swap fromAsset `?? 'ETH'`. Spec §7 bans this family: an unconfigured/unknown block must be invalid, not silently ETH-accepting
- L298-323 + L551-559: LOGIC BUG — analyzeRouteCompatibility only pushes an incompatibility when bestPath is non-null (L314), so edges with NO wrap path vanish; validateRoute's incompatible_tokens branch (gated on requiredWrapSteps.length === 0) is unreachable dead code and impossible routes validate clean. Change the contract: push with empty/null requiredWrapSteps so validation actually fires; add a unit test for an unroutable edge
- L400: block IDs embed Date.now() — non-deterministic, breaks spec §8 plan-snapshot tests; derive IDs from edge id + step index
- L440-442: LOGIC BUG — beforeBlockId for non-final steps is computed with a fresh Date.now() that will not match the next block's actual ID (dangling reference on ms tick). Note insertedWrapSteps is consumed nowhere in the old repo (store.ts uses only autoInsertedBlockIds): either delete the field or fix + test it
- L412, L424, L482: delete three console.log debug lines (banned per spec §8)
- L428-430: remove unnecessary `"auto-wrap" as BlockType` cast; kill `as unknown as BlockData` by adding AutoWrapBlockData to the BlockData union in types.ts (also deletes the diverged duplicate AutoWrapBlockData in auto-wrap-block.tsx:28)
- L484-491: writes untyped `asset` (raw address string) and `assetSymbol` into target block data via the [key: string]: unknown index signature — LendBlockData has no such fields. Add typed fields to the block schema (spec §5.3 end-to-end type-checking)
- L563-580: disconnected-block warning reuses type 'high_gas' — semantically wrong; add a proper warning type
- L602-697: extract translateError/ERROR_PATTERNS/SuggestedFix into the components/tx revert-decoding module — error UX copy does not belong in the pure graph module (spec §4 core/ purity); its only consumer is simulation-results.tsx

**Drags:** @xyflow/react (via ./types Node/Edge), src/lib/strategy/types.ts (AssetType, StrategyBlock, StrategyEdge, BlockType, BlockData), src/lib/strategy/protocols.ts (STAKING_PROTOCOLS only — WARNING: rest of protocols.ts is contaminated with hardcoded APYs/TVLs/GAS_COSTS; port only the id/inputAsset/outputAsset slice)

### src/components/strategy-builder/canvas.tsx
*654 loc · bundle: canvas*

Core wiring is the keeper: type registration, provider wrapper, store-driven nodes/edges, sidebar drag/drop, full keyboard suite (undo/redo/copy/paste/duplicate/select-all), Shift box-select, delete keys. Hidden garbage: selection-expanding 'workaround' heuristic, Ctrl+C preventDefault-before-guard bug, attribution hiding, console.logs. Roughly 200 lines of banned decoration strip cleanly without touching interaction logic.

**Required edits:**

- L3-9: rewrite header comment; drop 'ambient background effects and connection celebrations' narration
- L29: remove framer-motion import (only decoration uses it; nothing remains after strips below)
- L41 + L539: remove AuroraBackground import and render (SPEC §7: no ambient/aurora backgrounds)
- L44-125: delete ConnectionCelebration component entirely (neon particle burst, glow box-shadows — banned decoration; hardcoded cyberpunk palette #00FFD0/#A855F7/#FF0080/#00D4FF/#FFD000)
- L127-160 + L542: delete CyberGrid (animated scan lines, purple grid, corner accents — banned; drags cyber-grid-animated class from old globals.css)
- L191-198 note: keep module-level clipboard (L198) but delete CelebrationState interface (L191-195)
- L205-207, L349-352, L544-554: delete celebrations state, handleCelebrationComplete, and AnimatePresence render block
- L323-347: reduce onConnect to addEdge(connection) only — strip celebration positioning math
- L228-280: DELETE the 'box selection last node workaround' — it silently adds unselected connected nodes to the user's selection via magic-number geometry (x < maxX+400, y ±100); misdiagnosed-bug smell, violates user intent. Replace with plain setSelectedNodes(selectedByReactFlow). Also memoize the onChange callback with useCallback per React Flow 12 docs (currently inline, re-registers every render)
- L293-294: replace hardcoded approximate node dims (200/100) with node.measured?.width/height (React Flow 12 provides measured); if unmeasured, return null rather than guess
- L224 + L370-375: strip saved-system drop branch (placeSystem, 'application/saved-system' dataTransfer) — saved-systems feature not in SPEC v1 scope
- L403: substr() is deprecated → slice(); prefer crypto.randomUUID() for paste IDs
- L425, L468: delete console.log calls (banned SPEC §8)
- L473-527: keyboard handler fixes — (a) Ctrl+C calls preventDefault before checking selectedNodes.length, killing native text copy page-wide when no nodes selected; guard first (same for Ctrl+V with empty clipboard); (b) also exclude e.target.isContentEditable, not just input/textarea; (c) consider scoping listener to the wrapper instead of window (global Ctrl+A hijack)
- L516-519 + L563-565: setTimeout(handlePaste, 0) is unnecessary — clipboard is a synchronous module-level variable; call handlePaste() directly
- L532: add getNodes/setNodes to effect deps for exhaustive-deps lint-clean
- L183-185, L588: hardcoded background #0a0a0f → design token
- L601: connectionLineStyle stroke #735CFF (purple skin) → obsidian-teal token
- L604-609: Background color rgba(120,0,255,0.15) → token
- L611, L616: Controls/MiniMap hardcoded !bg-[#12121a] !border-[#2a2a3a] → tokens
- L615-637: MiniMap per-block-type hue map violates SPEC §7 (block type gets icon+label, not hue identity; color is semantic only) — use single neutral token color or drop MiniMap
- L602: remove proOptions={{ hideAttribution: true }} — hiding React Flow attribution without a Pro subscription violates xyflow terms; especially bad in a public repo
- L596-600: keep defaultEdgeOptions but confirm animated:true edge treatment respects prefers-reduced-motion in the ported FlowEdge (SPEC §7 motion policy)

**Drags:** @xyflow/react, react, @/lib/strategy/store, @/lib/strategy/types, ./blocks/input-block, ./blocks/stake-block, ./blocks/lend-block, ./blocks/borrow-block, ./blocks/swap-block, ./blocks/auto-wrap-block, ./edges/flow-edge, ./selection-action-bar, ./canvas-empty-state, framer-motion (DROPPED after edits — decoration only), ./aurora-background (DROPPED after edits)

### src/components/strategy-builder/selection-action-bar.tsx
*135 loc · bundle: canvas*

Interaction pattern is worth keeping: 150ms delayed visibility so the bar doesn't fight box-selection drag, count badge, duplicate/delete actions fed by canvas. Real defects: broken centering (framer clobbers static transform), dead AnimatePresence, fabricated Ctrl+Shift+S hint, missing aria-label. After stripping Save-as-Loop it becomes a small clean toolbar.

**Required edits:**

- L13, L30-33, L57-66, L86-94, L127-132: strip 'Save as Loop' feature — SaveSystemModal import, capturedNodeIds state, handleOpenSaveModal/handleCloseSaveModal, save button, modal render. Saved-systems ('loops') is not in SPEC v1 scope (§2) and drags save-system-modal.tsx plus store savedSystems/placeSystem. Remove selectedNodeIds prop from the interface once stripped (L17, L24)
- L79-83: BUG — static transform: 'translateX(-50%)' in style is overwritten by framer-motion's animated transform (it animates y/scale), so horizontal centering silently fails. Fix with motion value x: '-50%' in initial/animate/style, or drop framer and center via CSS (left + margin-left calc)
- L68 + L72-125: AnimatePresence is dead code — the component returns null at L68 before AnimatePresence mounts, so exit animations never play. Either lift AnimatePresence into canvas.tsx around <SelectionActionBar/> or remove it and the exit variant; a CSS transition satisfies SPEC §7 motion policy and drops the framer-motion dep
- L90: tooltip advertises '(Ctrl+Shift+S)' — shortcut is wired nowhere in the codebase; fabricated hint (moot after save-button strip, but must not be carried)
- L111-117: delete button is icon-only with title but no aria-label and no visible text — add aria-label='Delete selection' (SPEC §7 a11y floor); audit the other buttons' hover-hue classes
- L36: NodeJS.Timeout type in a client component → ReturnType<typeof setTimeout>
- L85-120: hardcoded palette — bg-[#1a1a24]/95, purple/blue hover hues → obsidian-teal tokens; keep red on delete (semantic, allowed)
- L3-8: trim header comment ('Save as Loop' mention) after strip

**Drags:** react, framer-motion (droppable if exit animation replaced with CSS), lucide-react, ./save-system-modal (DROPPED after edits)

### src/components/strategy-builder/blocks/base-block.tsx
*290 loc · bundle: Blocks*

The keeper of the bundle: props contract, handle placement, header/content/error slots, blockValue lookup (L108-111), and the over-allocation detection + badge (L120-136, L227-242) are exactly the structural composition the spec wants. Roughly half the file is skin to strip; what remains is clean and correct.

**Required edits:**

- L13 + L139-146: remove framer-motion import and replace motion.div wrapper (entrance animation + whileHover scale) with plain div — spec §7 bans entrance animations on blocks
- L105, L114-117: delete hasAnimated state and its timeout effect (dead once motion wrapper is gone)
- L40-84: delete the blockColors 5-hue map (border/bg/glow/glowRgb/icon/gradient per type) — replace with semantic-state colors (valid/warning/error/executing) from the ported token system
- L157-161: delete per-type hover glow shadow classes; L163-171: delete per-type neon ring/glow selected variants — replace with one token-based selected ring
- L176-182: delete the holographic gradient hover overlay div
- L246-262: delete the 4 corner-accent motion.divs; L264-274: delete the radial inner-glow motion.div
- L152, L164, L189, L221: replace hardcoded hexes #12121a/#0d0d14/#0a0a0f/#2a2a3a with CSS tokens; L190, L220-222: #735CFF (purple-gaming accent) must not enter the new repo
- L26: blockType union lacks a wrap type; after the color map is deleted blockType's only remaining use disappears — either drop the prop or repurpose it for icon/label only per §7
- L240: replace the ⚠ emoji with a lucide AlertTriangle icon
- L150: `glass-depth-2` requires the class from old globals.css:1043 — confirm the token-system port includes it or substitute
- L128: `data?.flowPercent ?? 100` is a structural edge default (typed 'default 100' in StrategyEdgeData), not a price fallback — allowed, leave as is

**Drags:** react, @xyflow/react, framer-motion (removable after edits), @/lib/utils (cn), @/lib/strategy/store, @/lib/strategy/types, src/components/strategy-builder/block-value-badge.tsx, globals.css .glass-depth-2 (line 1043)

### src/components/strategy-builder/blocks/input-block.tsx
*117 loc · bundle: Blocks*

Cleanest block in the bundle: no hardcoded prices, no fallback APYs, sensible controlled inputs with nodrag handling. The only real defect is the `|| 0` coercion; everything else is scope trimming and token swaps.

**Required edits:**

- L21-26: trim ASSETS to ETH only — spec §2 v1 Input block is 'ETH amount'; USDC/USDT/DAI options are out of scope (drop the selector or keep it single-option)
- L47: `parseFloat(e.target.value) || 0` silently coerces empty/invalid input to 0 — hold the raw string, validate explicitly; invalid input should mark the block invalid, not become 0
- L108: `blockData.amount.toLocaleString()` — route through core/format.ts per §7
- L104-111: row is labeled 'Value' but displays amount+asset, not a USD value — relabel 'Amount' or wire a genuinely priced USD value
- L69, L91: hardcoded #1a1a24 and blue-500 type-hue focus colors — replace with tokens/semantic focus style
- L33: `data as unknown as InputBlockData` double-cast — type the NodeProps generic properly in the new repo's stricter TS config

**Drags:** react, @xyflow/react, lucide-react, src/components/strategy-builder/blocks/base-block.tsx, @/lib/strategy/store, @/lib/strategy/types

### src/components/strategy-builder/blocks/stake-block.tsx
*128 loc · bundle: Blocks*

Structure is right — live-APY-over-cached principle, protocol select, In/Out asset flow footer. But the 'live' APY bottoms out in hardcoded defaults with no unavailable state, and it persists a dead apy field into graph state. All fixable with listed edits.

**Required edits:**

- L21-32: trim STAKE_PROTOCOLS to etherfi + lido (spec §2 v1); delete rocketpool/frax/coinbase; replace emoji logos (🔷🔵🚀⚡🔹) with icon+label per §7
- L49: getStakingApy silently falls back to hardcoded DEFAULT_APYS (old protocols.ts:247, via store.ts:846-847) — new store getter must return number|null; render explicit unavailable state + sourced/timestamped tooltip per §5.1/§7
- L60-66: stop writing `apy: getStakingApy(protocol)` into block data — the component's own comment (L48) says cached block apy is ignored; dead write and staleness trap
- L62 and L118: `?? "eETH"` silent asset fallbacks — make the protocol→outputAsset map exhaustive (2 protocols in v1) with no fallback branch
- L103: '...' text while loading violates 'skeletons, never placeholders' (§3.2) — use a skeleton; format the rate through core/format.ts
- L87-88, L100, L104, L117: purple type-hue classes — replace with semantic tokens

**Drags:** react, @xyflow/react, lucide-react, src/components/strategy-builder/blocks/base-block.tsx, @/lib/strategy/store (drags protocols.ts DEFAULT_APYS unless getter is rewritten), @/lib/strategy/types

### src/components/strategy-builder/blocks/lend-block.tsx
*180 loc · bundle: Blocks*

The incoming-asset detection via edge traversal (L64-82) is good structural composition and seeds the HF-on-canvas feature. But it hardcodes protocol risk params (80/82.5/83/85/86/91.5) in the UI — precisely what §5 forbids — and duplicates formatting logic.

**Required edits:**

- L34-45: delete hardcoded maxLtv/liquidationThreshold risk params from LEND_PROTOCOLS — spec §5.1: Aave reserve data is read from Pool/DataProvider contracts, never hardcoded in a UI component; trim to aave-v3 only (v1) and drop emoji logos
- L96-102: `?? 80` and `?? 82.5` numeric fallbacks on risk params — banned pattern; risk params must flow from chain reads with an unknown state when absent
- L22-32: delete local formatApy — §7 mandates a single core/format.ts formatting module (this is one of at least three divergent formatters in the bundle)
- L64-82: incomingAsset returns 'ETH' for any non-stake source including swap blocks — a swap→lend chain displays the wrong supply asset; handle swap sources or show an explicit unknown, and remove the L67 'ETH' default-when-unconnected in favor of an unconnected state
- L143: '...' loading placeholder → skeleton; getLendingApy inherits the store's DEFAULT_APYS fallback chain (store.ts:876-878) — same rewire as stake-block: number|null + unavailable state + sourced tooltip
- L146-148: `incomingAsset !== "ETH" && liveSupplyApy < 1` heuristic to show '+ staking yield' — hand-wavy inference from rate magnitude; derive from rate-source metadata or delete
- L123-124, L136, L142, L172: green type-hue classes and #1a1a24 hex — replace with semantic tokens

**Drags:** react, @xyflow/react, lucide-react, src/components/strategy-builder/blocks/base-block.tsx, @/lib/strategy/store, @/lib/strategy/types

### src/components/strategy-builder/blocks/swap-block.tsx
*151 loc · bundle: Blocks*

Clean form shell (from/to/slippage). The slippage select (L127-137) is an explicit user choice, not a fallback — fine. The two real defects are the fabricated fee row and selection implying validity without a quote. Quote wiring is new P2 work, not a port edit.

**Required edits:**

- L141-145: delete the 'Swap Fee ~0.3%' row — fabricated number (assumed Uniswap fee tier); §5.2: swaps are quoted, never stubbed; replace with quote-driven price impact + minReceived when quote integration lands (P2)
- L46-61: handlers set isValid:true on any asset selection — §5.2: a swap block with no quote is an invalid block; validity must be derived from quote presence, not selection (wire to quote state in P2)
- L21-31: replace emoji icons (🔵🔷🚀 etc.) with labels/icons per §7; revisit the asset list against the new repo's v1 asset scope
- L86-88, L100, L111-113, L130-131, L142-144: cyan type-hue classes and #1a1a24 hexes — replace with semantic tokens
- L37: `data as unknown as SwapBlockData` double-cast — type properly

**Drags:** react, @xyflow/react, lucide-react, src/components/strategy-builder/blocks/base-block.tsx, @/lib/strategy/store, @/lib/strategy/types

### src/components/strategy-builder/blocks/auto-wrap-block.tsx
*226 loc · bundle: Blocks*

The compact dashed auto-inserted treatment with Auto badge is exactly the spec's wrap-block concept — the visual distinction encodes real information, keep it. Hidden garbage: the never-rendering tooltip with a narrating comment that lies about its content, plus three dead interface props. Note it drags route-optimizer for one type import — consider moving WrapStep into the graph types.

**Required edits:**

- L75-81: remove entrance animation (motion.div initial/animate/transition) — §7
- L137-147: remove the infinite x-oscillation on the arrow (repeat: Infinity — pulse-class motion, banned); static arrow, honoring prefers-reduced-motion
- L206-221: tooltip is dead code — `group-hover:opacity-100` with no `group` class on any ancestor, so it never displays; comment L205 claims it 'shows contract address' but renders a static string; either add the group class and actually render data.wrapperContract (truncated) or delete the tooltip entirely
- L38-40: delete dead props icon/slippage/estimatedOutput from AutoWrapBlockData — never rendered here; estimatedOutput is only ever set to null (old store.ts:283)
- L49-64: replace emoji TOKEN_ICONS map (incl. `?? "🪙"` fallback at L63) with icon+label treatment per §7
- L71: `wrapStep?.isWrap ?? true` — defensive fallback on a field the interface types as required; drop the fallback
- L88, L119, L186-187: hardcoded hexes #1a1a24/#12121a/#0a0a0f — replace with tokens; keep the dashed border + 'Auto' badge (semantic, information-encoding — good)

**Drags:** react, @xyflow/react, framer-motion (removable after edits), @/lib/utils (cn), @/lib/strategy/types, @/lib/strategy/route-optimizer (WrapStep type only)

### src/components/strategy-builder/block-value-badge.tsx
*108 loc · bundle: Blocks*

Good idea, honest display: renders only what simulationResult.blockValues provides, including gas cost — no fallbacks of its own. In the new repo it becomes trustworthy automatically once simulation is honest. Two formatters duplicating core/format.ts and one dead conditional are the only rot.

**Required edits:**

- L19-42: delete local formatAmount/formatUsd — §7 single formatting module (core/format.ts); formatUsd also renders '$0' for tiny nonzero values and drops cents below $1000
- L78: `{isInput ? "↓" : "↓"}` — dead conditional, both branches identical; was presumably ↓/↑ for input/output direction; fix or replace with a direction icon
- L56-61 + L10: remove AnimatePresence/motion entrance pop-in (initial/animate/exit) per no-entrance-animation policy; keep the value-change flash (L81-84, L90-96) via CSS transition so framer-motion can be dropped
- L72-75, L78: blue/green input/output hues — direction color is legitimately semantic, but map to the token system rather than raw Tailwind hues

**Drags:** react, framer-motion (removable after edits), @/lib/strategy/types (ComputedBlockValue, AssetType)

### src/components/strategy-builder/save-system-modal.tsx
*174 loc · bundle: sidebar-save*

Audit claim is WRONG for this file: Save button IS wired (line 160 onClick={handleSave} -> store.saveSystem -> localStorage, store.ts:706-752). The dead Save/Share buttons are actually in src/app/strategies/page.tsx:316-332, a cut legacy page — reject that file separately. This modal fits the new repo's localStorage persistence model exactly; small, functional, honest state. Entrance/exit fade-scale is functional motion, within §7 policy — keep AnimatePresence.

**Required edits:**

- Lines 27, 40-47, 161, 165: delete the fake 200ms setTimeout 'visual feedback' delay and the isSaving state entirely — localStorage save is synchronous; fabricated latency is decoration (SPEC §7). handleSave becomes sync.
- Lines 100-105: X close button is icon-only — add aria-label="Close" (§7 a11y floor).
- Lines 77-83: modal container needs role="dialog", aria-modal="true", aria-labelledby pointing at the h2 (line 92).
- Lines 120-122 and 136-139: labels are not associated with their inputs — add htmlFor/id pairs.
- Lines 53-61: Escape only closes while an input has focus (handleKeyDown lives on the inputs) — move Escape handling to the dialog level (onKeyDown on the modal root or a document listener while open).
- Lines 140-147: textarea reuses handleKeyDown so plain Enter submits instead of inserting a newline — scope Enter-to-save to the name input only; give textarea its own Escape-only handler.
- Line 84: hardcoded bg-[#12121a] — replace with ported HSL token (§7 single design language).
- Lines 88-89, 129, 146, 162: purple accent family (bg-purple-500/20, focus:border-purple-500/50, bg-purple-500 hover:bg-purple-600) — retheme to obsidian-teal tokens; purple-gaming skin does not port (§7).
- Lines 3-7: trim the narrating header comment block to one line or delete.

**Drags:** react, framer-motion, lucide-react, @/lib/strategy/store (saveSystem/blocks — store drags zustand, @/lib/strategy/types, and its localStorage persistence; store must be transplanted first)

### src/components/strategy-builder/execution/transaction-preview.tsx
*534 loc · bundle: execution-ui*

Best file of the three. Step rows with expandable calldata detail (contract, est. gas, ETH value), token in→out flow, plan-expiry banner, and simulate-gate-before-execute are exactly the §6 preview craft. Per-step 'Already Approved'/skip visuals (L356-370, L339-350) are honest — backed by real allowance reads in transaction.ts:505-555 — keep them. The fabricated-savings banners and dead batching UI are the garbage; all removals are mechanical.

**Required edits:**

- L94-114: delete ApprovalStats/ApprovalSavings/BatchingSummary interfaces — savings numbers are fabricated upstream (approvals.ts:137 flat 46000n per approval; multicall.ts:225-233 estimated constants) and no caller ever passes these props (only call sites execution-modal.tsx:95,121 pass neither)
- L122-124 and L160-162: delete approvalStats/approvalSavings/batchingSummary props; approvalStats is additionally never referenced in the body at all (dead prop)
- L166-174: delete hasApprovalOptimizations/hasBatchingOptimizations/totalGasSavings computation
- L231-296: delete both 'Saving ~X gas' optimization banners and combined-savings summary — the flagged multicall gas-savings lie; multicall batching is not in the new spec
- L43-47, L73, L309-310, L371-382: delete SerializedBatchInfo, batchInfo field, isBatched, isFirstInBatch (computed, never used — dead variable), and batch badge with three step.batchInfo! non-null assertions and brittle batchId.replace("batch-", "") string surgery
- L132-148: replace emoji ACTION_CONFIG (✓↓⚡📦💰💸🔄🎁) with lucide icons and drop per-action hue mapping — §7: color is semantic only, block type gets icon+label not hue identity; also removes the L301-305 gray fallback config
- L35-88: replace locally duplicated serialized plan/step types with imports from new repo's core/plan.ts — current copy-paste divergence with use-transaction-execution.ts and routers/transaction.ts
- L188-194: replace formatAmount (Number(formatUnits(...)) precision loss) with core/format.ts
- L196-199, L221-223: expiry countdown is computed once per render — the m:ss counter never ticks and isExpired never flips without an external re-render; add a 1s interval keyed on plan.expiresAt
- L477-478: guard estimatedTotalGasUsd — builder.ts:151 hardcodes 0 pre-simulation so this renders '(~$0.00)' as a real price; render explicit 'pending simulation' state when unset (§7 no-silent-fallback)
- L327-330: add aria-expanded, aria-controls, and type="button" to the step toggle button (§7 a11y floor)
- L313-317: remove staggered entrance animation (delay: index * 0.05) or gate behind prefers-reduced-motion
- After above: prune now-unused imports (Sparkles, ShieldCheck, Layers, Zap from lucide-react)

**Drags:** react, framer-motion, lucide-react, viem, @/lib/utils, @/components/ui/button, @/components/ui/card, core/plan.ts types (after edit 7), core/format.ts (after edit 8)

### src/components/ui/button.tsx
*60 loc · bundle: ui-shared*

Praised focus-visible ring verified at L7: ring-2 ring-ring + ring-offset-background, disabled:pointer-events-none, svg pointer-events guards — correct. Clean cva structure, asChild/Slot done right. Only garbage is the dead glow variant and tinted shadows.

**Required edits:**

- L23-24: delete the `glow` variant — zero usages repo-wide (grep confirmed) and §7 bans glow decoration; it duplicates `default` with a heavier colored shadow
- L12, L14: reduce `shadow-lg shadow-primary/25 hover:shadow-primary/40` (and destructive equivalent) to a neutral elevation shadow — primary-tinted glow shadows violate §7 restraint

**Drags:** @radix-ui/react-slot, class-variance-authority, clsx, tailwind-merge, src/lib/utils (cn)

### src/components/ui/card.tsx
*84 loc · bundle: ui-shared*

Standard shadcn card, correctly typed forwardRefs, no hidden garbage beyond two inert/decorative classes. CardTitle as div (not h3) matches current shadcn.

**Required edits:**

- L13: remove `backdrop-blur-sm` — inert decoration: bg-card is an opaque token, so nothing behind it can blur
- L12: remove `hover:shadow-md transition-all duration-300` from the base Card — hover affordance on non-interactive containers is decoration (§7); add at genuinely clickable call sites instead

**Drags:** clsx, tailwind-merge, src/lib/utils (cn)

### src/components/ui/dialog.tsx
*118 loc · bundle: ui-shared*

Faithful stock shadcn dialog; a11y (Portal, Title, Description, sr-only Close) intact. The only defect is the repo-wide dead-animation-class issue — these transitions never actually ran in the predecessor.

**Required edits:**

- L20, L37: animate-in/animate-out/fade-out-0/fade-in-0/zoom-*/slide-* classes are DEAD — no tailwindcss-animate or tw-animate-css exists in this repo and Tailwind 4 silently drops unknown utilities. In new repo add `@import "tw-animate-css"` to globals.css, or strip these classes
- L43: change close-button `focus:outline-none focus:ring-2` to focus-visible: variants for §7 consistency

**Drags:** @radix-ui/react-dialog, lucide-react, src/lib/utils (cn), tw-animate-css (NEW dep, required if animation classes are kept)

### src/components/ui/dropdown-menu.tsx
*85 loc · bundle: ui-shared*

Well-curated subset — only Root/Trigger/Content/Item/Label/Separator exported, no dead CheckboxItem/RadioGroup/Sub exports (genuine restraint vs full shadcn). focus:bg-accent keyboard highlighting correct via Radix.

**Required edits:**

- L39: remove `select-none` from DropdownMenuItem — SPEC §7 hard rule: no user-select:none
- L21: same dead animation classes as dialog.tsx — add tw-animate-css in new repo or strip

**Drags:** @radix-ui/react-dropdown-menu, src/lib/utils (cn), tw-animate-css (NEW dep if animations kept)

### src/components/ui/sheet.tsx
*130 loc · bundle: ui-shared*

Built directly on DialogPrimitive with a plain sheetVariants map instead of cva — fine. The div-for-Description swap is the hidden a11y garbage the audit missed. Needed only if Positions view (P4) uses a detail sheet.

**Required edits:**

- L107-117: SheetDescription renders a plain div instead of DialogPrimitive.Description — breaks Radix aria-describedby wiring and triggers missing-Description console warnings; restore the primitive (a11y regression vs stock shadcn)
- L19, L34-39, L51: same dead animation classes (animate-in/out, slide-in-from-*, slide-out-to-*) — add tw-animate-css or strip
- L58: close-button focus: → focus-visible: for §7 consistency

**Drags:** @radix-ui/react-dialog, lucide-react, src/lib/utils (cn), tw-animate-css (NEW dep if animations kept)

### src/components/ui/skeleton.tsx
*57 loc · bundle: ui-shared*

Clean and small. Spec §3 demands skeletons-never-placeholders, so this ports. Verify the ported globals.css wraps the 2s-infinite shimmer in prefers-reduced-motion handling (§7).

**Required edits:**

- L20-22: delete SkeletonText — dead export, zero usages repo-wide (Skeleton/SkeletonCircle/SkeletonCard/SkeletonRow are all used)

**Drags:** src/lib/utils (cn), globals.css `.shimmer` class + keyframes (L379-394, part of the §7 token-system port)

### src/components/ui/sparkline.tsx
*170 loc · bundle: ui-shared*

Praised math verified: flat-line guard (data.every === data[0]) also catches the single-point division-by-zero; midpoint-quadratic smoothing is the standard correct construction; area path closes properly; empty data renders explicit '--', never a fake line. Call site feeds real price history. Core is genuinely good — strip the four items above.

**Required edits:**

- L152-170: delete generateMockSparklineData — dead export (zero importers) that fabricates price-shaped data with sin/cos noise; §5/§7 ban, exactly the audit's fabricated-data class
- L91: gradientId from Math.random() regenerates every render and mismatches on SSR hydration — replace with React.useId()
- L124, L136: remove drop-shadow glow filters on line and end-dot — §7: no glow filters
- L73-74: replace hardcoded #34d399/#f87171 and rgba glowColor with semantic tokens (hsl(var(--success))/hsl(var(--destructive))) so both themes stay consistent

**Drags:** react, src/lib/utils (cn)

### src/components/shared/token-icon.tsx
*112 loc · bundle: ui-shared*

Hidden garbage found: the DOM-manipulation error fallback is the anti-React defect the audit missed. L43 `?? "#6B7280"` is a color fallback, not a banned numeric fallback — fine. TokenWithChain's chainColor dot is optional; harmless single-chain.

**Required edits:**

- L51-66: replace the imperative onError fallback (document.createElement + appendChild inside React) with a useState failed-flag that renders the fallback div — current code appends a NEW fallback node per error event, so retries/re-renders accumulate duplicate DOM outside React's tree
- L46: raw <img> trips @next/next/no-img-element under §8 zero-warnings policy — use next/image (unoptimized) or a justified eslint-disable
- L32-33: drop MATIC/WMATIC from TOKEN_COLORS — multi-chain remnants; v1 is mainnet-only

**Drags:** src/lib/utils (cn)

### src/components/shared/error-boundary.tsx
*162 loc · bundle: ui-shared*

Class boundary is textbook-correct (getDerivedStateFromError + retry reset). QueryErrorDisplay's substring matching on error.message (L97-106) is brittle but pragmatic; InlineError clean. No fabricated content, honest error surfacing — fits §7 explicit-unavailable-state policy.

**Required edits:**

- L100-102: delete the auth categorization branch (UNAUTHORIZED/401 → 'Please sign in') and the `errorType !== "auth"` retry-suppression at L117 — the new repo has no auth (§2); dead path
- L33: route console.error through the gated log util (§8 no-console lint rule)

**Drags:** lucide-react, src/components/ui/button, src/components/ui/card

### src/lib/transactions/approvals.ts
*252 loc · bundle: tx-lib:*

Best file of the bundle. Sound core: on-chain allowance reads, fail-safe error path (assume approval needed — correct direction), skippable-step filtering, clean TokenApproval typing. The praised exact-amount behavior lives in the checking logic; the contradiction (1% buffer) is confined to a dead export slated for deletion. Server-only (imports rpc client) — keep it out of client bundles.

**Required edits:**

- Lines 62-74: replace 'spender = next step's to' heuristic (with its 'For now' comment and redundant O(n^2) findIndex at 64) with decodeFunctionData(erc20Abi, step.data) to read the actual spender+amount from the approve calldata
- Line 137: remove hardcoded `estimatedGasSavings += 46000n` — either drop the gas-savings display entirely or make it a single named constant with a justifying comment per SPEC §5.6; never render as a defended number
- Lines 141-144: replace console.warn with the repo log util (SPEC §8 bans console.log)
- Lines 226-252: delete dead exports hasMaxApproval, getRecommendedApprovalAmount and constants MAX_UINT256/HIGH_APPROVAL_THRESHOLD — getRecommendedApprovalAmount's `(requiredAmount * 101n) / 100n` 1% buffer violates §6 exact-amount approvals and §5.6 derived-buffers; grep confirms zero importers
- Lines 199-222: delete dead exports getApprovalStatus/getApprovalStatusMessage (zero importers; the 'unknown' branch at 208 is unreachable since needsApproval === !isApproved) OR keep only if new tx UI consumes them
- Line 9: repoint `@/server/lib/rpc` import to the new repo's viem client module; line 12 `@/lib/constants` SupportedChainId collapses to mainnet-only
- Lines 82-84 comment claims multicall batching — true only because the predecessor client sets batch:{multicall:true}; in the new repo either enable the same client batching or switch to explicit client.multicall so the comment cannot rot
- Lines 92-94: mainnet-only repo makes isSupportedChain/chainId plumbing removable; simplify signature accordingly

**Drags:** viem, src/server/lib/rpc.ts (replace with new repo viem client), src/server/lib/abis/erc20.ts (or viem's exported erc20Abi), src/lib/transactions/types.ts, src/lib/constants.ts (SupportedChainId type only)

### src/server/lib/rpc.ts
*145 loc · bundle: server-infra*

Praise verified: fallback({rank:true}) with per-transport timeout/retry, client caching, multicall batching is genuinely correct viem usage and the right base for core/rates reads. Garbage is peripheral: 3 dead exports, silent-empty env, and 4 chains the spec cuts. Heavily used in predecessor (11 importers) so the shape is battle-tested.

**Required edits:**

- L10, L19-25: trim CHAIN_DEFINITIONS to mainnet only; drop arbitrum/optimism/base/polygon imports (spec §2 cut-list: v1 is Ethereum mainnet only)
- L29-60: collapse RPC_ENDPOINTS to the single mainnet array (keep the Alchemy > env > official > llamarpc priority order and .filter(Boolean))
- L11: remove @/lib/constants import; replace SUPPORTED_CHAINS/SupportedChainId with a mainnet-only constant in the new repo's lib (do not drag the 5-chain constants file)
- L14-16: replace `process.env.ALCHEMY_API_KEY || ""` with the zod-validated env module required by spec §8 (fail fast, no silent-empty)
- L114-128: delete getAllClients — zero callers in repo (dead export)
- L133-135: delete clearClientCache — zero callers (keep only if new tests need cache reset)
- L145: delete `export { CHAIN_DEFINITIONS }` — zero external importers (dead export)
- L79-81: the `if (!chain)` guard becomes unreachable after mainnet-only trim; simplify
- Optional tuning note: per-transport retryCount:2 (L93) compounds with fallback retryCount:3 (L99) — worst case ~9 attempts per call; consider lowering one

**Drags:** viem, @/lib/constants (only if not replaced — replace with mainnet-only constant instead)

### src/server/lib/rate-limiter.ts
*260 loc · bundle: server-infra*

Token bucket (L20-91) audited and sound: fractional refill capped at maxBurst, single-timer queue drain, no double-schedule race. Caveat: getRateLimiter ignores config on repeat keys. fetchWithRetry + jittered backoff correct; exhausted retryable status returns the response (caller checks .ok) — acceptable. The broken helper's twin promisePool lives at services/historical/utils.ts L67-100, identical defect.

**Required edits:**

- L209-241: DELETE runWithConcurrency entirely — broken and dead (zero callers). Defect: L228-231 Promise.race([executing[i].then(()=>true), Promise.resolve(false)]) always resolves false (the already-settled false wins the microtask race), so completed promises are never spliced from `executing`; once any settled promise sits in the array, the L225 gate resolves instantly and concurrency becomes unbounded. Also pushes results in completion order, not input order
- L246-260: DELETE runSequentially — zero callers (dead export)
- L141-143, L157-159, L168-171: remove console.log calls or route through the new repo's log util (spec §8 bans console.log via lint rule)
- L101, L108: retryStatusCodes is optional with `?.includes` at L138 — make it non-optional with the default inlined, removing the silent no-retry path when a caller passes {retryStatusCodes: undefined}

### src/lib/sse-connection.ts
*175 loc · bundle: realtime-phase5*

Praise verified as mostly deserved: singleton state, listener re-attach on reconnect (72-77), capped exponential backoff (63), attempts reset on open, 5s-grace idle-disconnect with recheck (132-139) all sound. Zero npm deps, browser EventSource only. Phase-5 optional per SPEC 11 — port only when SSE returns.

**Required edits:**

- Lines 44, 49, 56, 135: console.log and line 79 console.error -> route through the new repo's log util (SPEC 8 bans console.log)
- Line 45: hardcoded EventSource URL "/api/events" -> extract to a named constant or module parameter; new repo must ship a matching SSE route before this file activates
- Lines 78-80: EventSource constructor failure is swallowed with no retry (permanent silent death) -> schedule reconnect with backoff in the catch block
- Lines 83-93: disconnect() sets isConnected=false but never fires state.onCloseCallbacks -> notify close callbacks when previously connected, otherwise isConnected consumers (useLivePrices) show stale 'Live' after idle-disconnect or reconnectSSE()
- Line 30-41: connect() does not clear a pending state.reconnectTimeout when it creates a fresh EventSource -> clear it to avoid a redundant timer firing (harmless today, but tighten)
- disconnect() should reset state.reconnectAttempts so a later fresh connect starts backoff from zero

**Drags:** repo-internal: an /api/events SSE route (old repo: src/app/api/events/route.ts, backed by redis pub/sub via src/server/lib/events.ts) — the new repo needs a redis-free replacement endpoint

### src/server/services/pyth/websocket-client.ts
*214 loc · bundle: realtime-phase5*

Skeleton is genuinely good: promise-based connect with timeout, exponential backoff plus jitter capped 30s, max-attempts event, shouldReconnect flag, ping keepalive, clean close(1000). But the timeout-without-close defect and speculative format branches show the praise skipped adversarial reading. Edits are mechanical and enumerable, hence port-with-edits.

**Required edits:**

- Lines 70-75: connection timeout rejects the promise but does NOT close the socket -> call this.ws.terminate() before reject; as written the socket can open later and emit 'connected' after the caller already activated CoinGecko fallback, producing dual-source concurrent broadcasts (root cause of the race in pyth/index.ts)
- Lines 107-112: leftover debug logging block ('Debug: log message structure') -> strip
- Lines 119-131: speculative message-format shims — Array.isArray batch branch and bare {id, price} branch handle formats Hermes never sends (real contract is {type:'price_update', price_feed}, already modeled in types.ts) -> delete both branches; this is the audit's 'compat for formats that never shipped' pattern
- Line 132-133: message.type === 'subscribed' branch is also speculative (Hermes replies type:'response') -> delete; keep the response/error handling at 108-112 minus the log
- All console.log/console.error (34, 38, 52, 57, 98, 109, 111, 135, 142, 151, 165, 173, 204) -> log util per SPEC 8
- Lines 37 and 77: duplicate 'open' handlers -> merge clearTimeout into the single open handler
- Lines 169-176: track the reconnect setTimeout handle and clear it in disconnect() (shouldReconnect guard makes it benign, but a live timer after disconnect is sloppy)

**Drags:** ws (npm, ^8.19.0 already in old package.json), events (node builtin), repo-internal: ./types (PythWebSocketConfig, PythPriceUpdate) — types.ts is clean and drags nothing

### src/hooks/use-live-prices.ts
*99 loc · bundle: realtime-phase5*

The hook itself is clean of numeric fallbacks — the notorious '?? 3000' is in consumer flow-edge.tsx:127 ('fallback to 3000 if not available'), which must NOT survive any port per SPEC 7; price-ticker.tsx consumes honestly (renders em-dash when absent). State logic is otherwise sound. Phase-5 optional; port together with sse-connection.

**Required edits:**

- Lines 96-99: delete getTokenPriceId — dead export (zero imports repo-wide) whose chainId:address keyspace can never match the CoinGecko-ID keys the price map actually uses; a lookup built with it silently always misses
- Lines 69-71: delete the 'connected' event subscription — it exists solely to console.log the payload (decoration; console banned per SPEC 8)
- Line 62: console.error -> log util
- Lines 33-47: updatedTokens Set is mutated inside the setPrices updater and read outside — side-effectful updater double-runs under StrictMode (benign only because Set dedupes) -> compute the diff before calling setState
- Lines 53-59: track and clear the recentlyUpdated timeout on unmount
- Line 5: import type { PriceUpdateEvent } from '@/server/lib/events' — type-only (no runtime drag) but points into a redis-importing server file; move the event type to a shared types module in the new repo
- Re-key the price map by token symbol instead of CoinGecko ID strings and export a typed key union — the current stringly contract ('ethereum', 'bitcoin') is what invites consumer fallbacks

**Drags:** react, repo-internal: @/lib/sse-connection (same bundle), repo-internal: @/server/lib/events (type-only import PriceUpdateEvent — relocate type, do not drag the file)

### src/app/globals.css
*1520 loc · bundle: tokens-misc*

Keep is ~300 of 1520 lines: the HSL token system (10-107) plus container/font-display/tabular-nums/shimmer/focus-ring/status-dots. Four (not three) design languages found: Obsidian-teal (keep), EtherFi purple-gaming 524-669, Strategy-Builder purple 671-901, Cyberpunk 903-1520. user-select:none at 123-125 confirmed.

**Required edits:**

- KEEP the praised token system: lines 1 (@import), 10-107 (:root 11-41, .dark 43-77, @theme inline 80-107) — this is the §7 'port the token set' asset
- Lines 123-125: DELETE `cursor: default; -webkit-user-select: none; user-select: none;` on body — §7 explicitly bans user-select:none; then simplify/delete the re-enable block at 139-144 which exists only to undo it
- Lines 129-137: DELETE body::before noise-texture overlay (fixed, z-index 9999) — decoration encoding nothing (§1 anti-goals)
- Lines 104-105: replace `var(--font-geist-sans)`/`--font-geist-mono` mapping with system stack per §7 (ClashDisplay stays for display, line 106 keeps --font-clash-display); same at line 203
- Lines 208-228: DELETE .text-gradient / .text-gradient-amber / gradient-flow keyframes (animated ambient gradient text)
- Lines 230-283: DELETE .card-glow and .glow/.glow-sm/.glow-lg/.glow-amber — §7 'no glow filters'
- Lines 298-321: DELETE .mesh-gradient / .mesh-gradient-animated — §7 'no ambient/aurora backgrounds'
- Lines 323-362: DELETE .animate-in* staggered entrance + .animate-scale-in — §7 'no entrance animations'
- Lines 364-376: DELETE .pulse-glow — §7 'no pulse'
- Lines 421-441: DELETE .hover-lift (glow shadow) and .breathing (ambient pulse)
- Lines 443-469: DELETE .border-gradient decorative border
- Lines 489-502: keep .status-dot-* semantic colors but strip the box-shadow glows
- Lines 505-514: DELETE recharts overrides — recharts is not in the new stack
- Lines 516-522: DELETE global input[type=text]:focus !important override (glow + specificity hack); rely on .focus-ring (471-480, keep)
- Lines 524-669: DELETE entire 'ETHER.FI Gaming-Inspired' section (design language #2) incl. hand-escaped Tailwind-arbitrary-class reimplementations at 601-612 — EtherFi-branded page is cut
- Lines 671-901: DELETE entire 'STRATEGY BUILDER' purple section (design language #3); EXCEPTION: React Flow selection styling concept at 883-901 is worth rebuilding with token colors (hsl(var(--primary))) instead of hardcoded rgba(115,92,255)
- Lines 903-1520: DELETE entire 'CYBERPUNK HOLOGRAPHIC' section (design language #4) — 617 lines, all banned by §7
- ADD @media (prefers-reduced-motion: reduce) handling for whatever motion survives (shimmer 378-394, value-flash 402-419) — file currently has zero reduced-motion support, §7 requires it

**Drags:** tailwindcss, ClashDisplay font asset (referenced via --font-clash-display, loaded in app layout)

### src/lib/utils.ts
*92 loc · bundle: tokens-misc*

cn/formatAddress/isValidAddress are clean and universally imported (37 files). The seven number formatters are the copy-paste-divergence epicenter the audit flagged; spec §4 mandates a single core/format.ts, so they must not port into lib/utils of the new repo.

**Required edits:**

- The praised precision-aware formatBalance is NOT in this file. Seeds for core/format.ts live at src/server/services/liquidation.ts:103-113 (bigint whole/remainder split, precision-preserving, documented) and src/components/etherfi/etherfi-insights-card.tsx:472-480 (bigint→string with magnitude-tiered decimals and explicit '—'/'<0.001' states). Divergent bad copies: src/server/adapters/types.ts:131-133 (naive Number(raw)/10**decimals — precision-losing, used by all 8 adapters) and src/components/portfolio/token-holdings.tsx:29-43. Orchestrator: add liquidation.ts:103-113 + etherfi-insights-card.tsx:472-480 to the manifest as the core/format.ts seed extract
- Keep only cn (4-6), formatAddress (32-34), isValidAddress (89-91), sleep (51-53 — only if a consumer drags it); everything numeric moves to core/format.ts, not lib/utils
- Lines 36-49 formatTokenAmount: do not port as-is — `BigInt(10 ** decimals)` (line 41) uses float exponentiation (use 10n ** BigInt(decimals)), truncates instead of rounds, breaks on negative amounts, and mixes toLocaleString grouping with raw fraction concat
- Lines 80-84 formatHealthFactor: hf>=999 'No Debt' magic-sentinel — §5 requires explicit no-debt/unknown states, not sentinel numerics; rebuild in core/format.ts with a typed HF state
- Lines 24-30 formatPercent (expects decimal) vs 73-75 formatPercentRaw (expects percent) — duplicate formatters with conflicting input conventions, the exact class that causes 100x display bugs; core/format.ts must pick one convention
- Lines 59-67 formatUsdCompact: no billions tier (renders '1234.56M'), mishandles negatives; supersede in core/format.ts
- Line 89-91: prefer viem's isAddress (already a dep in new repo) over the regex — regex accepts non-checksummed garbage

**Drags:** clsx, tailwind-merge

### src/lib/etherfi-contracts.ts
*388 loc · bundle: tokens-misc*

The three contracts the new repo needs (liquidityPool, eETH, weETH) verified correct against Etherscan/ether.fi docs. The corruption the audit predicted is real: TNFT is a copy-paste of withdrawRequestNFT and BNFT matches nothing. ABIs are hand-typed as-const (good wagmi pattern); LiquidityPool deposit overloads are legitimate. New repo also needs a Lido (stETH/wstETH) equivalent — not in this bundle.

**Required edits:**

- Line 21: TNFT address 0x7d5706f6ef3F89B3951E23e557CDFBC3239D4E2c is CORRUPTED — it duplicates withdrawRequestNFT (line 25); real mainnet TNFT is 0x7B5ae07E2AF1C861BcC4736D23f5f66A61E0cA5e (verified via Etherscan label: 0x7d5706... is 'Ether.fi: Withdraw Request NFT'). Deleted by the scope trim below, but must not survive anywhere
- Line 22: BNFT 0x87CE158c03C996fe1B4B740F5C59B1bD5e51b538 matches no documented EtherFi contract (docs list BNFT 0x6599861e55abd28b91dd9d86A826eC0cC8D72c2c) — treat as corrupted; deleted by trim
- Trim ETHERFI_ADDRESSES (13-37) to the three v1-scope contracts: liquidityPool, eETH, weETH (all three externally verified correct). Delete membershipNFT, TNFT, BNFT, withdrawRequestNFT, ETHFI, sETHFI, eBTC, liquidVaultETH, liquidVaultUSD — loyalty/points/vault features are cut per SPEC §2
- Delete MEMBERSHIP_NFT_ABI (194-212), ERC4626_ABI (251-331), and the corresponding ETHERFI_CONTRACTS entries (349-376); ERC20_ABI (217-246) keep only if the approval flow doesn't get it from viem's erc20Abi export — prefer viem's built-in erc20Abi and delete this one too
- WEETH_ABI (123-189): ADD getRate() — `{name:'getRate',type:'function',stateMutability:'view',inputs:[],outputs:[{name:'',type:'uint256'}]}` — SPEC §5 names weETH.getRate() as the canonical rate read and it is missing from this ABI
- Line 387: delete ETHERFI_SUBGRAPH_ID — The Graph is not in the new stack (rates are read on-chain per §5)
- Lines 1-6, 39-41 etc.: keep the doc comments only where they say something non-obvious; the header block is fine, per-ABI banner comments are narration

**Drags:** viem

### src/lib/protocol-metadata.ts
*135 loc · bundle: tokens-misc*

Trivial data module, no imports. The keepable core is ~30 lines: 3-protocol metadata record + getProtocolMeta. Hidden garbage confirmed: empty-string logo fallback, dead symbol param, checksum-fragile TrustWallet URLs. DeFiLlama icon CDN URLs are fine (icons.llama.fi is stable) but consider vendoring the 3 logos locally for zero runtime external deps.

**Required edits:**

- Lines 39-73: delete compound-v3, spark, morpho, eigenlayer, pendle entries — trim PROTOCOL_METADATA to lido (18-24), etherfi (25-31), aave-v3 (32-38) per v1 scope
- Line 88: getProtocolColor's `?? "#6366F1"` — silent hardcoded fallback color; return undefined (or make the record's key type a closed union of the 3 protocol ids so the lookup can't miss). Note §7: protocol hue-identity should not drive block styling anyway — colors are for logo accents at most
- Lines 80-85 getProtocolLogo: fallback fabricates a CDN URL for unknown ids (`${DEFILLAMA_ICONS}/${protocolId}.jpg`) — with a closed union this dead branch goes away; delete
- Lines 95-116 getTokenLogo: do not port — returns "" on fallback (broken img src), unused `symbol` param (dead parameter), TrustWallet raw-GitHub URLs 404 unless the address is checksummed (callers pass lowercase), hardcoded zero-address native-token special case, Polygon chainId 137 branch (multi-chain cut). New repo's 4 tokens (ETH/eETH/weETH/stETH/wstETH/WETH) should ship as local static assets, not remote CDN lookups
- Lines 118-124: delete CHAIN_TO_TRUSTWALLET (multi-chain, only consumed by getTokenLogo)
- Lines 129-135 POSITION_TYPE_INFO: trim lp/vault entries (not in v1); replace hardcoded hex colors (#22C55E etc.) with the token system (hsl(var(--success)) / --destructive / --primary) — these bypass the ported design tokens

---

## REBUILD REFERENCE (23 files)

Read for the listed ideas; rewrite in the new repo. Never copy.

### src/lib/strategy/store.ts
*969 loc · bundle: strategy-types-store*

Confirmed never-shipped-format shim L854-860 (flat {supply,borrow} vs always-per-asset yields.ts:292-300; needs as-unknown-as casts). Plus: L337 ethPrice:2700; getDefaultApy hardcoded fallbacks x6; L869-873 wrong-asset fallback; undo/redo off-by-one (L677-693, dead ternary L685); lp-masquerades-as-loop L297-306; dead selectors L961-969. Keep: history-snapshot pattern, auto-configure-on-connect, allocation redistribution, placeSystem id-remap. Yields/price plumbing is replaced by react-query+core/rates anyway — rewrite.

**Old-repo deps (context for reading):** zustand, @xyflow/react, src/lib/strategy/types.ts, src/lib/strategy/templates.ts, src/lib/strategy/protocols.ts, src/lib/strategy/route-optimizer.ts, @/server/services/yields (import type StrategyApyData only — type-only, but encodes the cut 4-protocol/multi-asset yields format)

### src/lib/strategy/templates.ts
*526 loc · bundle: optimizer-templates*

Every block hardcodes rates/risk params (apy 3.2 x4, supplyApy 0.5/0.1/10.2, borrowApy 2.8/2.5, divergent LTs 80/82.5/75 for the same Aave market) plus fabricated estimatedApy strings — placeholders that render as real numbers, violating spec §3/§5. stablecoin-yield (Morpho/USDC) out of scope; etherfi-loop fakes weETH as EtherFi stake output, bypassing the auto-wrap flow; edge types diverge. Keep template roster + loop-generator layout idea; reauthor against null-until-fetched schema.

**Old-repo deps (context for reading):** @xyflow/react (via ./types), src/lib/strategy/types.ts (StrategyBlock, StrategyEdge, StrategyTemplate, InputBlockData, StakeBlockData, LendBlockData, BorrowBlockData)

### src/lib/strategy/simulation.ts
*772 loc · bundle: strategy-simulation*

Audit confirmed and extended. Worth keeping as reference: Kahn toposort + flowPercent edge weighting (shape of core/allocation.ts), YieldSource weight ledger (apy x weight sum for the APY breakdown panel), per-block ComputedBlockValue in/out propagation for canvas badges, closed-form loop leverage 1/(1-LTV) and asymptotic HF=LT/LTV. Discard entirely: risk scoring, maxDrawdown, every fallback constant.

**Reference notes / defects to avoid:**

- L69 + L575: DEFAULT_ETH_PRICE = 2700 baked in as the default parameter of simulateStrategy — banned silent price fallback (SPEC §7); rebuilt core must require priced inputs, no default
- L247: input block prices every non-ETH asset at $1/token (data.amount used as USD) — wrong for stETH/eETH/weETH/wstETH/rETH/cbETH/sfrxETH inputs; confirms audit finding
- L465: borrowed non-ETH amount = USD value ($1/token) — wrong for any non-stable borrow asset
- L519: swap output non-ETH amount = USD value ($1/token) — same defect third site
- L311: outputAmount = inputAmount with comment 'LSTs are ~1:1 with ETH' — false for wstETH (~1.18) and weETH (~1.04); SPEC §5.1 requires read exchange rates (weETH.getRate, stEthPerToken)
- L616-647: switch handles only input/stake/lend/borrow/swap; 'auto-wrap' blocks (inserted by route-optimizer.ts L428), plus declared 'lp' and 'loop' types, hit the default case which zeroes value/outputAmount — every optimizer-processed graph loses all downstream value; confirms audit finding
- L295 / L361 / L433: APY fallback chains (data.apy ?? getDefaultApy, data.supplyApy ?? market?.supplyApy ?? getDefaultApy) terminate in hardcoded DEFAULT_APYS tables in protocols.ts; getDefaultApy returns silent 0 for unknown keys — all banned by §7
- L173-177: loop LTV taken from the FIRST borrow block anywhere in the graph (not the one in the cycle), with `?? 0.7` fallback — wrong for multi-borrow graphs
- L427 / L445 / L673: liquidation threshold hardcoded to 82.5% at three independent sites
- L446-447: liquidationPrice = ethPrice/HF assumes USD-stable debt against ETH-priced collateral — financially wrong for the flagship LST leveraged loop where debt is ETH-correlated; also yields liquidationPrice = 0 (not null) when borrowValue = 0
- L662-665: loop leverage multiplier applied to weights of ALL yield sources including ones outside the cycle; loop-back edge flowPercent is ignored (formula should be 1/(1 - ltv*flow))
- L683: ctx.riskScore += for loops is a dead write — unconditionally overwritten at L722
- L136/L146 (parent map) and L138/L152 (cycleEnd): assigned but never read — dead code in detectLoop
- L218-236: topologicalSort silently drops nodes left in residual cycles (Kahn's with no sorted.length === blocks.length check) — blocks vanish from simulation without error
- L248: multiple input blocks overwrite ctx.initialValue (last processed wins) instead of summing — all weight/leverage math computed against wrong base
- L514-515: swap models slippage tolerance as guaranteed loss and hardcodes 0.3% protocol fee; §5.2 requires real aggregator quotes; a borrow/swap producing zero output must be an invalid block, not a silent zero (§5.3)
- L382: healthFactor: 999 magic sentinel on lend blocks
- L702-734: risk-score buckets and maxDrawdown = 20 * leverage are fabricated numbers — do not carry into new repo (§1/§7 no-fabrication policy)
- L700 vs L757: projectedYield1Y computed in USD then returned divided by initialValue (a ratio), while createErrorResult and the type treat it as USD — inconsistent units, latent UI display bug
- L273/L336/L401/L490: buildReverseAdjacency rebuilt from scratch inside every block processor (O(V*E)) — build once before the loop
- Whole file: float-USD arithmetic with `number`; SPEC §4 core/ contract is pure BigInt/viem-typed math — incompatible representation, another reason this is a rewrite not a port

**Old-repo deps (context for reading):** src/lib/strategy/types.ts (./types), @xyflow/react (transitively via ./types StrategyBlock/StrategyEdge = React Flow Node/Edge), src/lib/strategy/protocols.ts (./protocols — hardcoded APY/LTV/gas-cost tables, itself reject-grade; new repo replaces with core/rates.ts on-chain reads)

### src/components/strategy-builder/canvas-empty-state.tsx
*238 loc · bundle: canvas*

~80% banned decoration: staggered entrance animations, rotating conic-gradient orb, 6 floating particles, purple-cyan-pink gradient headline, per-card hue+glow identity, holographic-border class. Ideas worth keeping in rewrite: pointer-events-none overlay with pointer-events-auto cards so drags pass through; three template quick-start cards wired to loadTemplate→loadStrategy (IDs conservative-lst, lst-lending, leveraged-lst-2x verified in templates.ts); hint line. Rewrite is cheaper than editing.

**Old-repo deps (context for reading):** react, lucide-react, @/lib/utils, @/lib/strategy/store, @/lib/strategy/templates, framer-motion (rebuild should not need it), holographic-border CSS class in globals.css (do not port)

### src/components/strategy-builder/blocks/borrow-block.tsx
*332 loc · bundle: Blocks*

Contains the audited hardcoded price: L30 ETH_PRICE=3300 plus L59 `|| ETH_PRICE` double fallback (store default 2700). L62-142 recursive traceBackValue duplicates simulation.ts; L96/102/141 hardcode 82.5; L149-162 inline HF/liq-price math with 'assume 1:1 stablecoins'; L177-179 hand-waved 2% buffer and `: 70`; L56 borrow APY always aave-v3 ETH regardless of asset. Spec §5.4 mandates this math be rewritten in core/health-factor.ts. Reference-worthy UI: LTV slider capped at maxSafeLtv, HF tier display, collateral-context panel, liquidation warning.

**Old-repo deps (context for reading):** react, @xyflow/react, lucide-react, src/components/strategy-builder/blocks/base-block.tsx, @/lib/strategy/store, @/lib/strategy/types

### src/components/strategy-builder/edges/flow-edge.tsx
*642 loc · bundle: flow-edge*

Interaction design is the keeper: allocation popover (percent/asset toggle, slider, quick buttons, dual summary, sibling auto-balance), auto-wrap transform label, wide invisible hit path, flow-scaled particles. Everything else fails spec: inline buggy money-math (diamond undercount, borrow unit error, LST=ETH pricing), banned fallback, full cyberpunk glow/pulse/shimmer skin, no a11y, no reduced-motion, per-edge quadratic recompute.

**Reference notes / defects to avoid:**

- L127: `?? 3000` banned price fallback — new build must render explicit unavailable state (§7 lint rule)
- L149-208: extract recursive graph-flow math to core/allocation.ts as a pure, tested, once-per-graph computation; component only selects its edge's value
- L168-175: fix shared `visited` set bug — diamond DAGs undercount (second path to a shared ancestor returns 0)
- L178-182 + L274-277: borrow output is collateral-units * LTV but labeled in the borrowed asset — needs real price conversion (fabricated number as-is)
- L189-194, L205-206: LST-priced-as-ETH and stake/lend 1:1 pass-through violate §5.1 — use read exchange rates
- L121-122, L140-209: perf — whole-array zustand subscriptions defeat memo(); every store change re-runs every edge's O(V+E) traversal
- L134-137: delete self-lookup of edge in store; EdgeProps already provides `source`
- L57-95: strip particle glow filter, pulse `<animate r>`, opacity animates; keep particles + speed/count scaling (L320-330); add prefers-reduced-motion static treatment
- L349-373, L383, L397-418, L458: delete stacked blur-glow paths, hover drop-shadow, animated 'energy' gradient, holographic shimmer — banned decoration
- L332-343, L450-453, L488-633: replace all hardcoded cyberpunk hex (#00FFD0, #735CFF, #12121a, purple-500 chrome) with semantic tokens; keep partial-flow amber semantic + dash pattern (L382)
- L433-637: popover needs dialog role, focus management, Escape + click-outside close, ARIA labels on slider/inputs/toggles, keyboard-reachable edge activation, tabular-nums
- L313-318, L610, L621: route all numbers through core/format.ts; L621 renders a raw unformatted float
- L18-19, L124: drop useLivePrices — drags the SSE stack cut from v1; price/rate inputs come from the v1 rates mechanism via core/allocation inputs
- L303: remove `as Record<string, unknown>` cast for isAutoInserted — type it in the block schema

**Old-repo deps (context for reading):** react, @xyflow/react, @/lib/strategy/store, @/lib/strategy/types, @/hooks/use-live-prices (drags @/lib/sse-connection + @/server/lib/events — SSE stack is cut from v1)

### src/components/strategy-builder/sidebar.tsx
*474 loc · bundle: sidebar-save*

Drag mechanics sound: MIME contract (application/reactflow type, application/saved-system id) matches canvas.tsx onDrop:371-383; motion.div+draggable verified working via framer 12.28.1 filter-props carve-out, though the double-cast at 116/240 is fragile. But lines 426-431 render fabricated estimatedApy strings (SPEC §3/§5 violation), RiskBadge:164 defaults unknown risk to green low (banned no-data-means-safe), and ~80% of lines are the banned cyberpunk skin: per-block hue-gradient-glow (48-89), shimmer overlays (127-129, 405), entrance staggers (110-112, 236-238, 392-394), hardcoded hexes, cyber-sidebar/glass-depth-1/neon-green. Keep the IA (tabs, saved-loops section, collapse-to-icon-strip, template loader) and the dataTransfer contract; rewrite everything visual per §7 tokens.

**Old-repo deps (context for reading):** react, framer-motion, lucide-react, @/lib/utils (cn), @/lib/strategy/store, @/lib/strategy/types (BlockType, SavedSystem), @/lib/strategy/templates (STRATEGY_TEMPLATES, loadTemplate), globals.css skin classes: cyber-sidebar, glass-depth-1, neon-green (confirmed at globals.css:1429, 1037, 871 — skin does NOT port per SPEC §7)

### src/components/strategy-builder/analysis/analysis-view.tsx
*969 loc · bundle: analysis-view*

Real panel, not decoration — but it faithfully renders a toy simulation: only ETH price is live; APYs, gas, liq threshold, risk score all hardcoded upstream. Not $1-priced (2700 fallback + CoinGecko). Best display work in the predecessor (HF gauge, APY bars, waterfall) — keep as visual reference, rewrite against the new core/ with honest data states.

**Reference notes / defects to avoid:**

- REFERENCE NOTES (rewrite, don't copy). Data source: reads useStrategyStore().simulationResult, populated by SimulationRunner in src/app/strategies/page.tsx:206-222 via simulateStrategy() (src/lib/strategy/simulation.ts). NOT the $1-pricing sim: ethPrice defaults to hardcoded 2700 (store.ts:337, simulation.ts:69) then live CoinGecko via tRPC (page.tsx:343-363). ETH price is the ONLY live input; APYs come from hardcoded DEFAULT_APYS table, gas from hardcoded GAS_COSTS USD constants, liq threshold ?? 82.5, swap fee hardcoded 0.3%. Panel is a faithful renderer of a toy simulation — the exact model SPEC §5 replaces.
- KEEP as design reference: HealthGauge radial (lines 230-288), APY contribution bars (151-224), StrategyPipeline strip (388-432), ProjectionFlow waterfall (306-374), StatCard (118-138). These map directly onto the spec's live simulation panel (APY / HF / gas).
- BUG line 231: HealthGauge coerces non-finite HF to 0 — simulation emits Infinity for zero debt, so an infinitely-safe position renders '0.00 / Critical'. Spec §5.4 requires explicit HF-unknown state; rewrite must model HF as number | 'none' | 'unknown'.
- Line 166: `isFinite(item.value) ? item.value : 0` — banned silent numeric fallback (§7); render explicit unavailable state instead.
- Lines 283 and 884: liquidation price rendered as `$X ETH` — mislabeled unit (it is the USD ETH price at liquidation, not an ETH amount).
- Line 809: `$${result.gasCostUsd}` raw interpolation, unformatted — all numbers through core/format.ts in rewrite.
- Lines 636-679: canned 'insights' with unsourced editorial claims ('Above-average returns compared to typical DeFi yields') — fabricated comparison; do not port the insights concept.
- Lines 438-464, 508-533: RiskIndicator/RiskBadge render simulation's heuristic riskScore/riskLevel (invented 0-100 score, maxDrawdown=20x leverage upstream) — drop; spec has no risk-score feature.
- Lines 446, 516: unknown risk level silently falls back to config.medium — banned fallback pattern.
- Lines 3-8: narrating header comment ('Modern Edition... inspired by Linear, Stripe, Mercury') — strip.
- Lines 15, 22: dead imports TrendingDown, Gauge.
- Line 545: pointless alias `const result = simulationResult`.
- Line 317: ProjectionFlow back-computes grossYield = projected - initial + gas + fees — money-math in a display component; belongs in core/ in rewrite.
- Whole file: raw zinc/emerald/rose/amber Tailwind literals, not the §7 token system; HF thresholds (1.25/1.5/2) duplicated in 4 places in-component instead of core/health-factor.ts; no source-citation tooltips, no skeletons, no fetch timestamps (§3.2 requirements); per-card ErrorBoundary with console.error (§8 no-console) and defensive Array.isArray on typed props (line 152); grid-cols-4 non-responsive (789); {liquidationPrice && ...} truthy checks hide legit 0 (280, 930).
- Structural mismatch: this is a full-screen tabbed route-level view; spec's simulation panel is a live in-composer side panel recomputed as the graph changes. Rewrite as composer panel consuming the new core/ outputs (real rates, HF from core/health-factor.ts, quoted gas).

**Old-repo deps (context for reading):** react, framer-motion, lucide-react, @/lib/utils, @/lib/strategy/store, zustand (via store), @/lib/strategy/simulation (via store consumers — the toy sim that shapes SimulationResult), @/lib/strategy/types (SimulationResult shape), @/lib/strategy/protocols (hardcoded DEFAULT_APYS + GAS_COSTS, via simulation)

### src/components/strategy-builder/execution/execution-modal.tsx
*229 loc · bundle: execution-ui*

Phase choreography (building/preview/simulating/ready/executing/complete/error) and close-guard during in-flight phases (L51-56) are the good ideas. Fatal gap: 'executing' phase is a bare spinner (L144-158) — no step list, no per-step pending/confirmed/reverted, no explorer links, no resume; the exact §6 ExecutionFlow the spec demands is absent. Dead `cn` import (L5), purple spinner (L79), hand-rolled SVG checkmark (L174-187), entrance animations per phase. Rewrite around a per-step StepList contract.

**Old-repo deps (context for reading):** framer-motion, lucide-react, @/lib/utils, @/components/ui/button, @/components/ui/dialog, src/components/strategy-builder/execution/transaction-preview.tsx, src/components/strategy-builder/execution/simulation-results.tsx, @/hooks/use-transaction-execution (type-only, couples to hook's phase machine)

### src/components/strategy-builder/execution/simulation-results.tsx
*372 loc · bundle: execution-ui*

Layout is a good reference: success header, Tenderly link, per-step gas, net balance changes, translated errors. But: dead TrendingUp/TrendingDown imports (L8-10); 'Apply' fix button with NO onClick (L247-255) — fabricated interactivity; per-step revertReason/error typed (L57-58) but never rendered; steps.length div-by-zero NaN (L94); USD figures tainted upstream (ethPrice ?? 2500, hardcoded 30 gwei at simulation.ts:536) and changeUsd!==0 conflates unknown with $0 (L339). Contract takes only completed results — no pending/streaming step states §3.4 requires. Rewrite against a streaming per-step status model; extract error translation into tx family with viem decodeErrorResult.

**Old-repo deps (context for reading):** react, framer-motion, lucide-react, viem, @/lib/utils, @/components/ui/card, @/components/ui/button, @/lib/strategy/route-optimizer (translateError/TranslatedError — drags a ~700-line graph module into tx UI)

### src/components/wallet/connect-button.tsx
*181 loc · bundle: ui-shared*

Answer to audit question: fully custom, not RainbowKit-derived. But over half is SIWE machinery (useAuth, auto-signIn via 500ms setTimeout hack L50-58, 'Signed In' tier) deleted by construction in the new repo; injected-only connector L61-63 undercuts §6 production wallet UX; pulse-glow L81 banned. Keep as reference: mounted-placeholder hydration (L66-73), ENS + mono address display, tiered state rendering.

**Old-repo deps (context for reading):** wagmi, lucide-react, src/hooks/use-auth (SIWE — CUT in new repo), src/components/ui/button, src/components/ui/dropdown-menu, src/lib/utils (cn, formatAddress), globals.css `.pulse-glow` (banned §7)

### src/components/etherfi/staking-panel.tsx
*564 loc · bundle: ui-shared*

TransactionButton located: private fn L455-564. Machine is real: idle→simulating→ready→confirming→pending→success|error, wagmi-simulation-gated execute (L540-546), per-phase labels incl. 'Confirm in Wallet', explorer link, distinct success/error panels — SPEC §6 nearly verbatim. Rebuild into components/tx/: strip ETHERFI_BRAND gradient L553, banned glow shadow L549, confetti L485, brittle label regex L505; add §6 disabled-reason tooltips. Rest of file is cut EtherFi page; L223 hardcodes '1 ETH = ~1 eETH' (§5 violation).

**Old-repo deps (context for reading):** wagmi, viem, lucide-react, src/hooks/use-etherfi-staking (state machine source, TransactionStatus L25-32), src/lib/etherfi-constants (ETHERFI_BRAND, STAKING_LIMITS), src/lib/etherfi-contracts, src/components/ui/button, src/components/ui/card, src/lib/utils (cn), globals.css `.animate-confetti`

### src/lib/transactions/builder.ts
*859 loc · bundle: tx-lib:*

SPEC §5 mandates rebuild as core/plan.ts. Confirmed: 626-661 invented 85/84/80/78% rates; 193 swap returns []; 761-764 borrow params never set (and can never be bigint — params cross tRPC as JSON). New finds: flowPercent ignored (full inputAmount to every block); 104-106 dead compat shim with float precision loss; 111/673 silent fallbacks; Kahn sort lacks cycle detection; dead imports (lines 18,22-23) and dead TOKEN_ADDRESSES export; 12+ console.log. Salvage: verified mainnet address book, encodeFunctionData patterns, Kahn sort, step shape.

**Old-repo deps (context for reading):** viem, src/lib/transactions/types.ts, src/lib/strategy/types.ts, src/lib/strategy/route-optimizer.ts, src/server/lib/abis/aave-v3.ts, src/server/lib/abis/lido.ts, src/server/lib/abis/etherfi.ts, src/server/lib/abis/erc20.ts

### src/hooks/use-transaction-execution.ts
*444 loc · bundle: tx-lib:*

Confirmed: sends steps individually (319-350) — correct EOA mechanics, and proof multicall batching never executes. Lifecycle basics sound: simulation gate (305), re-entrancy guard (301), per-step receipt wait + revert throw, good phase machine. Fatal: retry restarts at step 0 re-sending confirmed txs (funds-loss; SPEC §6 requires resumable); silent 1-ETH default (228); float wei math (232); chainId ??1 (236); string-matched rejection (360); expiresAt never checked; 120 lines of hand-mirrored Serialized* types tRPC inference replaces; console.log throughout. Rebuild keeping phase machine + gate + hash tracking.

**Old-repo deps (context for reading):** wagmi, wagmi/actions, viem, react, @tanstack/react-query (via trpc), src/lib/trpc.ts, src/lib/strategy/store.ts (969-loc zustand store, being redesigned), src/lib/strategy/types.ts

### src/server/trpc.ts
*99 loc · bundle: server-infra*

Do NOT port: x-wallet-address bypass (L31-44, duplicated verbatim in catch L46-59) is prod-active header impersonation, not NODE_ENV-gated; prisma/SIWE context and protectedProcedure all cut. Salvage in the rewrite: superjson transformer (L68, native BigInt for gas values over the wire), ZodError.flatten errorFormatter (L69-78), router/publicProcedure exports. New file is ~20 lines with no context or a headers-only context.

**Old-repo deps (context for reading):** @trpc/server, superjson, zod, ./lib/prisma (CUT by spec — do not drag), ./lib/siwe (CUT by spec — do not drag)

### src/server/services/simulation.ts
*631 loc · bundle: server-infra*

Bundle plumbing praise is deserved and is the §5.5 keeper; everything numeric around it is fabricated (30 gwei x6, 2500 default x2, fake gas API, always-empty netBalanceChanges, fabricated before-balances). Too many interleaved defects for port-with-edits — rewrite around the preserved endpoint/timeout/typing skeleton, splitting sandbox override behind an explicit badged mode.

**Reference notes / defects to avoid:**

- Rewrite guidance (not copy-edits): keep ONLY the bundle path — simulate-bundle endpoint (L370), X-Access-Key auth (L316-318/L419-422), state_objects on first sim only (L397-399, correct: bundle chains state), AbortController timeouts (L307-336, L404-447), config validation (L40-52), Tenderly request/response typings (L58-137)
- L161-165 + L373-378: 1000 ETH override (0x3635C9ADC5DEA00000) is UNCONDITIONAL — rewrite as an explicit sandboxMode flag; live mode simulates real balances; sandbox badged on screen per §5.5
- L149 + L348: `ethPriceUsd: number = 2500` — banned hardcoded price default (§7); make it a required, sourced parameter
- L182, L215, L259, L470, L485, L536: BigInt(30e9) fabricated 30 gwei gas price — use real gas data (Tenderly response or RPC), never a constant
- L609-631: getGasEstimate returns fabricated 20/2 gwei constants ('In production, you'd call an RPC') and is exposed via routers/transaction.ts L349 — do not rebuild; use real eth_feeHistory/gas API
- L455 + L538: HIDDEN — allBalanceChanges never written in bundle path; netBalanceChanges is always []. Rewrite must actually aggregate per-step balanceChanges
- L147-272: sequential simulateTransactionPlan does NOT chain state between steps (admitted L237-239) — multi-step results are wrong; do not rebuild it, bundle-only
- L571-592: extractBalanceChanges fabricates before:0n (L584) and silent-zero changeUsd (L587); _ethPriceUsd unused (L573) — rewrite honestly (unknown-before is an explicit unknown, not 0)
- L350-532: strip ~35 console.log narration lines (§8 lint ban)
- L25-32: safeBigInt silently truncates decimal strings — acceptable only for gas_used; document or tighten
- L435/L508: `results` is untyped any from response.json(), accessing call_trace.error_reason absent from declared types — type the bundle response in the rewrite

**Old-repo deps (context for reading):** viem, @/lib/transactions/types (TransactionPlan, TenderlySimulationResult, SimulationStepResult, TokenBalanceChange, DecodedLog), env: TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT_SLUG, TENDERLY_PROJECT_SLUG

### src/server/services/liquidation.ts
*459 loc · bundle: Money-math*

Best math in repo, confirmed: portfolio HF and per-collateral liquidation-price algebra are algebraically correct. But the file is fetch+math entangled, has both input bugs (reserve-level collateral flag; 999-means-safe on outage), silently drops unpriced debt, unit-sniffs thresholds, and its liq-price frame is wrong for the correlated-pair hero template. Extract L284-352 into pure core/health-factor.ts.

**Reference notes / defects to avoid:**

- L284-352: KEEP as the reference algebra for core/health-factor.ts — verified correct: HF=Sum(valueUsd_i*LT_i)/totalDebtUsd (L285-300); per-collateral liquidationPrice=(totalDebtUsd-otherWeightedThreshold)/(amount*LT) (L335,L343) correctly solves portfolio HF=1; riskContribution (L310-311) and priceDropToLiquidation clamp (L378) correct.
- Input bug 1 — L47 + L250: collateral gate uses reserve-level reserve.usageAsCollateralEnabled. Must use the USER-level flag: subgraph field usageAsCollateralEnabledOnUser on userReserves, or in the new contract-read world ProtocolDataProvider.getUserReserveData()/Pool.getUserConfiguration bitmap. Current code overstates HF for users who disabled an asset as collateral.
- Input bug 2 — L184-186 (no Graph client), L194-196 (query failed/null; executeGraphQuery swallows errors to null at graph/client.ts:135-139) -> buildEmptySummary L443-459 returns overallHealthFactor:999 + riskLevel 'safe'; also L371/L406-408 clamp Infinity to 999. Replace with tagged union: {status:'unknown'} on no-data, {status:'no-debt'} for infinite HF, {status:'ok',hf}. Never a numeric sentinel, never 'safe' without data (SPEC §5.4).
- New find — L221-241 + L227: missing price uses `?? 0` sentinel then silently SKIPS the position. Skipping an unpriced DEBT overstates HF (dangerous direction). Pure core must return status:'unknown' if any debt or collateral leg is unpriced; never drop legs.
- L119-130: parseLiquidationThreshold unit-sniffs ('if parsed>1 treat as bps') — silent-fallback family. New core takes LT explicitly in bps (contract format) and divides by 10_000; no format guessing.
- L103-113: formatBalance uses BigInt(10 ** decimals) (float round-trip; exact only for decimals<=22 by luck) — use 10n ** BigInt(decimals); relocate to core/format.ts per SPEC layout.
- L32-54 query over-fetches never-read fields: name (L41), underlyingAsset (L43), reserveLiquidationBonus (L46), price.priceInEth (L48-50) — typed at L57-79 but unused. Fetch layer stays out of core/ regardless (core = pure, no fetch, no gql).
- L154-169 + L362-380: debtSummary 'MULTI'/'NONE' string hack and per-position pseudo-HF (L359-360) are display concerns — exclude from core; expose only portfolio HF + per-collateral {liquidationPrice, priceDrop, riskContribution}.
- L209-214: sequential await getPrice per token — batch (getPrices exists in price.ts). Fetch-layer concern for the rates router, not core.
- Design caveat to carry into the rebuild: L313-352 algebra assumes debt USD constant while collateral price moves — wrong for correlated pairs (weETH collateral vs WETH debt = the new repo's hero Leveraged Loop template). Compute liquidation in collateral/debt exchange-rate terms for correlated assets or the on-canvas liquidation price will be misleading in the flagship demo.
- Multichain machinery (L419-438, SUPPORTED_CHAINS param L179) is cut — v1 is mainnet-only.
- Verification requirement: unit-test core against fixtures AND integration-check vs Aave Pool.getUserAccountData().healthFactor — CoinGecko USD prices differ from Aave oracle prices, so computed HF can deviate from the on-chain HF that actually triggers liquidation.

**Old-repo deps (context for reading):** graphql-request, src/lib/constants.ts (SUPPORTED_CHAINS, SupportedChainId), src/lib/liquidation/types.ts (LendingPosition, WalletRiskSummary, getRiskLevel — getRiskLevel + RiskLevel are clean and worth taking for the HF 1.5 warning threshold; LiquidationAlert/HealthFactorHistory are cut features), src/server/adapters/graph/client.ts (getGraphClient, executeGraphQuery, SUBGRAPH_IDS — drags graphql-request + constants), src/server/services/price.ts (getPrice, COINGECKO_IDS — transitively @prisma/client type)

### src/server/services/portfolio-utils.ts
*174 loc · bundle: Money-math*

Signs and dust filtering verified correct, but the audit's praise missed L53: the banned `?? 0` price fallback feeding the dust filter, which silently vanishes unpriced positions. Plus missing-APY-as-0% and a registry import that drags every adapter. ~60 lines of good conventions; rewrite them in core/ with null-propagating types rather than porting the file.

**Reference notes / defects to avoid:**

- Praise VERIFIED: borrow signs correct — calculateTotalValue L69-76 subtracts debt; calculateYield24h L82-93 subtracts borrow cost; groupByProtocol L131-134 negative contribution; filterDustPositions L158-164 uses Math.abs so borrow-side dust is filtered too. These conventions are the part worth keeping.
- L53: `const priceUsd = priceData?.priceUsd ?? 0` — the exact SPEC §7 lint-banned silent price fallback. Worse: the $0 position then falls below MIN_POSITION_VALUE_USD and is silently deleted by filterDustPositions — unpriced value disappears without trace. Rebuild with null-propagating enrichment (priceUsd/balanceUsd: number|null) surfacing an explicit unavailable state.
- L99-116: calculateWeightedApy treats missing APY as 0% (undefined apy adds 0 to numerator while balance stays in denominator) — silently understates APY; rebuild must exclude unknown-APY balances or surface 'partial data'.
- L82-93: dailyYield = apy/100/365 linearizes APY (compounding ignored) — acceptable approximation but must be a documented, tested decision in core/, not implicit.
- L9 + L127-147: imports adapterRegistry (transitively the ENTIRE adapter tree) solely for name/category display lookup — invert to a passed-in metadata resolver or drop groupByProtocol (new repo's positions view is 3 protocols, thin).
- L8: Position type is the old adapter shape (coingeckoId, positionType union incl. lp/vault) — new repo defines its own core position type; interfaces here (EnrichedPosition/PriceData/ProtocolGroup) all get redefined.

**Old-repo deps (context for reading):** src/server/adapters/types.ts (Position — drags viem Address type + src/lib/constants.ts), src/server/adapters/registry.ts (adapterRegistry — transitively imports every protocol adapter + viem clients; heaviest drag in this bundle)

### src/server/services/price.ts
*282 loc · bundle: Money-math*

Casing bug confirmed and worse than flagged: every LST symbol is unresolvable via getPriceBySymbol, with a live consumer in the transaction router. Fetch hygiene (backoff, batching, timeout, honest nulls) is genuinely good reference for the tRPC rates router, but global mutable cache, Prisma half, and the SPEC's runtime-cache decision mean rebuild, not port. Token-ID map is salvageable data after trim + re-case.

**Reference notes / defects to avoid:**

- L198 casing bug CONFIRMED: getPriceBySymbol does COINGECKO_IDS[symbol.toUpperCase()] but the map (L26-73) keys mixed-case: stETH, wstETH, rETH, cbETH, eETH, weETH, ezETH, USDe, sUSDe, USDC.e are ALL unreachable — every liquid-staking token fails symbol lookup. Live consumer: src/server/routers/transaction.ts:22. Fix in rebuild: exact-case keys with exact-case lookup (no case folding), or a single normalized lowercase map.
- L10-11 + L21: module-global mutable state (memoryCache Map, lastRateLimitHit) — per-instance and cold-start-reset on Vercel serverless; SPEC §4 chose Next runtime cache (<=60s, timestamped for UI tooltips) — the caching layer is rebuilt, not ported.
- L1, L209-274: syncPricesToDatabase/getCachedPrice are Prisma-coupled — dead in the no-database new repo; do not carry.
- L97: console.log — violates SPEC §8 no-console.log rule (log util instead).
- L96-99: during 429 backoff, entries older than TTL are silently absent from results (stale cache not served, no signal) — rebuild should return stale-with-timestamp or explicit unavailable, so the UI can badge staleness per SPEC §5.1.
- Reference-worthy patterns for the tRPC rates router rebuild: 429 backoff timestamp (L9-11, L117-121), batch dedupe single-call fetch (L102-107), AbortSignal.timeout(10_000) (L114), cache-then-fetch-only-missing (L166-192), and honest null on miss (L151-161 — no fabricated numbers in this file itself; fabrication happens in its consumers).
- COINGECKO_IDS (L26-73) is portable DATA: trim to the v1 mainnet token set (ETH, WETH, stETH, wstETH, eETH, weETH, USDC, USDT, DAI, WBTC + aggregator-quote assets) and re-key exact-case when the rates router needs USD legs.

**Old-repo deps (context for reading):** @prisma/client (type-only import — only needed by the dead DB half)

### src/server/services/pyth/index.ts
*337 loc · bundle: realtime-phase5*

Keep the ideas: trailing-edge throttle (128-137, pendingUpdates map plus remaining-delay computation) and fallback-on-max-reconnects. Rebuild because: shutdown() never clears the self-rescheduling fetch24hChanges timer (195 vs 293-311) — zombie CoinGecko polling forever; getPrice uppercases keys stored mixed-case (122 vs 260) — LST lookups always null; PYTH_ID_TO_SYMBOL first-wins collision means WETH/eETH/weETH/rETH never update; dual-source broadcast race with fallback that never deactivates; fallback confidence hardcoded 0 (241) — false certainty; broadcast keyed by CoinGecko IDs; 13 console calls; both broadcast and fallback layers point at cut infrastructure (redis, price.ts).

**Old-repo deps (context for reading):** repo-internal: ./websocket-client (-> ws npm), repo-internal: ./feed-ids, repo-internal: ./types, repo-internal: @/server/lib/events broadcastPriceUpdate (-> redis pub/sub — Redis is cut from new repo v1), repo-internal: ../price getPrices + COINGECKO_IDS (-> redis cache, PrismaClient-typed helpers — both cut)

### src/server/services/pyth/feed-ids.ts
*95 loc · bundle: realtime-phase5*

Financially wrong proxies violate SPEC 5/7: line 45 wstETH->STETH feed (comment 'tracks stETH value' is false — wstETH is ~1.18-1.20 stETH, ~20% understated); line 47 rETH->ETH (~10% off); line 51 weETH->ETH (~5% off, drifting — weETH is the hero template's collateral asset, this poisons HF math). Pyth publishes real WSTETH/WEETH/RETH USD feeds; proxies are unnecessary. Line 71 vestigial 'Placeholder' filter. Lines 60-65 first-wins reverse map breaks many-to-one feeds. Core well-known IDs (ETH/BTC/USDC/USDT) verified correct — keep as reference data; rebuild 1:1 for new repo tokens only, drop COINGECKO_TO_SYMBOL glue and governance tokens.

### src/lib/constants.ts
*127 loc · bundle: tokens-misc*

~85% serves cut features: 5-chain SUPPORTED_CHAINS/CHAIN_INFO (v1 is mainnet-only), COVALENT_CHAIN_NAMES (GoldRush cut), DEFILLAMA_CHAIN_PREFIXES (cut), HYPERSYNC_ENDPOINTS (cut), TIMEFRAME_CONFIGS (historical reconstruction cut), ERC20_TRANSFER_TOPIC (verified-correct keccak but HyperSync-only). Good ideas to copy: as-const maps with derived union types, PROTOCOLS slugs (keep aave-v3/lido/etherfi), named STALE_TIMES. Rewrite ~20 lines fresh: chainId 1, etherscan URL, protocol slugs, 15s polling interval per §4.

### src/app/wallet/[address]/layout.tsx
*170 loc · bundle: tokens-misc*

UNCOMMITTED (untracked src/app/wallet/). The pattern is good: shared segment layout giving sticky sub-header + tab nav without remount, active-tab from pathname, own-wallet badge, copy-with-feedback. The implementation is not: 'use client' layout resolving params via .then in useEffect (lines 54-63) instead of React use() or a server layout; client-side address validation with toast+router.replace instead of server-side notFound; mounted-spinner hydration hack (90-96) blocks first paint; magic `sticky top-16` coupled to header height (101). New repo has no wallet-tab surface — reuse the pattern for composer chrome/mode-switch, rewritten RSC-first per §4.

**Old-repo deps (context for reading):** wagmi, sonner, lucide-react, next (navigation/link), @/lib/utils (cn, formatAddress, isValidAddress)

