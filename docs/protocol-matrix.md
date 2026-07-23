# Protocol Matrix — Aave v3 Ethereum Core + EtherFi + Lido

Decision-record source of truth for contract addresses, risk parameters, and protocol
mechanics. **Every on-chain value cites a read label in `docs/protocol-matrix-reads.json`,
regenerated reproducibly by `node scripts/protocol-reads.mjs` — the script is hard-pinned to
the fixture block (hash-verified; `--repin` is an explicit separate mode), and reruns are
byte-identical (the RPC endpoint is serialized as a redacted provider label only).
77 reads: 76 successes + 1 documented expected revert (`getRevision`, internal getter), zero
unexpected failures. An archive-capable RPC (`RPC_URL`) is required —
the block has aged out of public nodes' recent-state windows.** Claims that are not on-chain reads cite a URL. Nothing is hand-typed
from memory. Scope: the Aave v3 Ethereum **Core** market (not the separate EtherFi/Lido/
Horizon Aave markets), plus EtherFi and Lido staking tokens.

- **Pinned block:** `25,592,678` · hash `0x7f1f53176578a6df42c94948c10623f002cca61398208c888edce99eaedbf0de` · 2026-07-23T03:14:11Z
- **RPC:** archive-capable endpoint via `RPC_URL` (original generation: publicnode while the
  block was in its recent window; regeneration verified via Alchemy archive)
- **Regenerate:** `RPC_URL=<archive> node scripts/protocol-reads.mjs` (hash-guards the pinned
  block; exits non-zero on any unexpected read failure)
- All risk parameters and caps are point-in-time at the pinned block and change via governance.

---

## 1. Aave v3 Ethereum Core — market contracts

Anchor: `PoolAddressesProvider 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` (bgd-labs
address-book `AaveV3Ethereum.POOL_ADDRESSES_PROVIDER`). Everything below is **derived on-chain
from the anchor in the committed run**:

| Contract | Address | Read label |
|---|---|---|
| Pool (proxy) | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | `AP.getPool` + `Pool.ADDRESSES_PROVIDER (round-trip)` |
| Pool implementation | `0x728a138A4823392C2EFA55e028d434F526fE03CF` | `Pool implementation (EIP-1967)` |
| AaveProtocolDataProvider | `0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD` | `AP.getPoolDataProvider` |
| AaveOracle | `0x54586bE62E3c3580375aE3723C145253060Ca0C2` | `AP.getPriceOracle` |
| ACLManager | `0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0` | `AP.getACLManager` |
| Interest-rate strategy (shared, stateful) | `0x9ec6F08190DeA04A54f8Afc53Db96134e5E3FdFB` | `WETH.getInterestRateStrategyAddress` = `weETH.getInterestRateStrategyAddress` |

## 2. Deployed revision & error model

| Item | Value | Evidence |
|---|---|---|
| Deployed revision | **Aave v3.7** | Implementation mapping, not changelog inference: on-chain EIP-1967 impl `0x728a138A…` (read `Pool implementation (EIP-1967)`) equals the current address-book `POOL_IMPL` (https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Ethereum.sol), and the Aave changelog records **v3.7 Part 2 completing rollout to Ethereum (Core, Lido) on 2026-05-29** (https://aave.com/docs/resources/changelog: v3.6 → 2026-01-09; v3.7 Part 1 → 2026-04-20; v3.7 Part 2 → 2026-05-29). The prior matrix's "v3.6" claim was wrong and is superseded. |
| Pool impl runtime code hash | `0x530cdbba5eb9487cd5d041bb74b7a1936ad3230bf9e361893ecd025373c7fbe5` | Read `Pool implementation (EIP-1967) — runtime code keccak256`; impl-address mapping pinned to address-book commit `ad35d3403b02ff0b4ce27acc23b92781b44f78f4` (https://github.com/bgd-labs/aave-address-book/blob/ad35d3403b02ff0b4ce27acc23b92781b44f78f4/src/AaveV3Ethereum.sol) |
| Numeric `getRevision()` | Not externally readable | Read `Pool.getRevision (internal in v3.x — expected revert)` — recorded expected revert |
| Error model | Custom errors (v3.4+ migrated from `Error(string)` numeric codes) | aave-v3-origin `Errors.sol` (https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/helpers/Errors.sol); `core/errors.ts` must decode the deployed revision's custom errors first, legacy numeric table as fallback |

## 3. E-mode — category 1 "ETH correlated" (at pinned block)

| Parameter | Value | Read label |
|---|---|---|
| Label | `ETH correlated` | `eMode1.label` |
| LTV / LT / bonus | **93.00% / 95.00% / 1.00%** (9300 / 9500 / 10100) | `eMode1.collateralConfig` |
| Collateral bitmap | `2952790659` → reserve indices {0,1,7,9,28,29,31}: weETH (idx 28) **is collateral** | `eMode1.collateralBitmap` + `Pool.getReservesList` |
| Borrowable bitmap | `1` → {WETH (idx 0)} only | `eMode1.borrowableBitmap` |
| **Isolated category (v3.7)** | **false** | `eMode1.isIsolated (v3.7)` |
| **LTV-zero bitmap (v3.7)** | **0** (no members) | `eMode1.ltvZeroBitmap (v3.7)` |

v3.7's category getters are now read directly: category 1 is **not isolated** and has an
**empty LTV-zero bitmap**. Note: v3.7 **removed legacy reserve-level siloed-borrowing and
isolation-mode features** (verified absence in the current `IPool` interface,
https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/interfaces/IPool.sol); the
DataProvider's legacy `getSiloedBorrowing`/`getDebtCeiling` getters answering false/0 are
compatibility stubs, recorded as such.

## 4. Reserve parameters (at pinned block; bps: 10000 = 100%)

### WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

| Parameter | Value | Read label |
|---|---|---|
| LTV / LT / bonus / reserve factor | 80.50% / 83.00% / 5.00% / 15.00% | `WETH.getReserveConfigurationData` |
| Flags | collateral ✓ · borrowing ✓ · active ✓ · frozen ✗ · paused ✗ | same + `WETH.getPaused` |
| Siloed / debt ceiling (isolation) | false / 0 | `WETH.getSiloedBorrowing`, `WETH.getDebtCeiling (isolation)` |
| Supply cap / supplied / **headroom (nominal)** | 2,700,000 / 2,074,589.27 / **≈625,410.7 (~23.2% free)** | `WETH.getReserveCaps`, `WETH.aToken.totalSupply` |
| aToken scaledTotalSupply | `1941754363263954672923837` | `WETH.aToken.scaledTotalSupply` |
| vToken scaledTotalSupply | recorded | `WETH.variableDebtToken.scaledTotalSupply` |
| Borrow cap / borrowed / **headroom** | 2,400,000 / 1,686,976.41 / **≈713,023.6 (~29.7% free)** | `WETH.getReserveCaps`, `WETH.variableDebtToken.totalSupply` |
| **Available liquidity (virtual accounting)** | ≈334,699.17 WETH | `WETH.getVirtualUnderlyingBalance` (cross-check `WETH.underlying.balanceOf(aToken)` ≈334,699.33 — delta = untracked donations) |
| Rate strategy params | optimal 92.00%, base 0, slope1 2.35%, slope2 6.00% | `WETH.strategy.getInterestRateDataBps` |
| Current rates + indices | recorded | `WETH.getReserveData` |

### weETH `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee`

| Parameter | Value | Read label |
|---|---|---|
| LTV / LT / bonus / reserve factor | 77.50% / 80.00% / 7.00% / 45.00% | `weETH.getReserveConfigurationData` |
| Flags | collateral ✓ · **borrowing ✗** · active ✓ · frozen ✗ · paused ✗ | same + `weETH.getPaused` |
| Siloed / debt ceiling | false / 0 | `weETH.getSiloedBorrowing`, `weETH.getDebtCeiling (isolation)` |
| Supply cap / supplied / **headroom (nominal)** | 1,100,000 / 1,056,935.82 / **≈43,064.2 (~3.9% free — nearly full)** | `weETH.getReserveCaps`, `weETH.aToken.totalSupply` |
| aToken scaledTotalSupply | `1055881514564962443046398` | `weETH.aToken.scaledTotalSupply` |
| vToken scaledTotalSupply | recorded | `weETH.variableDebtToken.scaledTotalSupply` |
| Borrow cap | 1 (borrowing effectively disabled; legacy debt ≈50.8) | `weETH.getReserveCaps`, `weETH.variableDebtToken.totalSupply` |
| Available liquidity (virtual) | ≈1,056,884.98 (== `balanceOf(aToken)` exactly) | `weETH.getVirtualUnderlyingBalance` |
| Rate strategy params | optimal 30.00%, base 1.00%, slope1 7.00%, slope2 300.00% | `weETH.strategy.getInterestRateDataBps` |

**Exact cap formulas (v3.7 `ValidationLogic`,
https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/ValidationLogic.sol):**
supply cap passes iff `(aToken.scaledTotalSupply() + scaledAmount + accruedToTreasury)` scaled
up by `nextLiquidityIndex` (aToken-balance rounding) `<= supplyCap x 10^decimals`; borrow cap
iff `(currScaledVariableDebt + amountScaled)` scaled by `nextVariableBorrowIndex`
`<= borrowCap x assetUnit`. Nominal headroom above is display-level; plan validation uses
these formulas with the recorded scaled values. **Price-oracle-sentinel: no sentinel check
exists in v3.7 `validateBorrow` (verified absence)** — sentinel state is not a constraint for
this market.

**Rounding + accrual semantics for those formulas (v3.7 sources, read verbatim 2026-07-23):**
`helpers/TokenMath.sol`
(https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/helpers/TokenMath.sol)
— aToken balances and supply `scaledAmount` round **down** (`rayMulFloor` / mint
`rayDivFloor`); vToken balances and borrow `amountScaled` round **up** (`rayMulCeil` / mint
`rayDivCeil`). `math/MathUtils.sol`
(https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/math/MathUtils.sol)
— liquidity accrues linearly (`RAY + rate·Δt/SECONDS_PER_YEAR`, floor division); variable
debt compounds via the Taylor form `RAY + x + x.rayMul(x/2 + x.rayMul(x/6))` with
`x = rate·Δt/SECONDS_PER_YEAR`. `logic/ReserveLogic.sol`
(https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/ReserveLogic.sol)
applies either factor to the stored index with **half-up** `rayMul` (`_updateIndexes`).
Available-liquidity enforcement: `updateInterestRatesAndVirtualBalance` subtracts
`liquidityTaken` from `uint128 virtualUnderlyingBalance` under checked arithmetic — a borrow
above virtual balance reverts on underflow, so the plan-validation constraint is
`amount <= getVirtualUnderlyingBalance`. These semantics are implemented in
`src/core/rates.ts`; the `rates.test.ts` accrual suite reproduces this file's recorded
aToken/vToken `totalSupply` values from their scaled counterparts at the pinned block
(Δt = 60 s and 11,760 s), pinning the math to the deployed contracts.

> **Plan-validation consequences (SPEC §5.7):** weETH supply-cap headroom is the binding
> mainnet constraint; WETH borrow validation must additionally respect **available liquidity**
> (virtual balance), not just cap headroom. Both reserves are non-siloed, non-isolated at the
> pinned block. The recorded constraint set for the pinned revision: active/frozen/paused,
> borrowing-enabled, supply+borrow caps with headroom, available (virtual) liquidity, e-mode
> membership bitmaps (incl. isolated-category flag and LTV-zero bitmap), user collateral-enable
> state. Legacy siloed/isolation checks are **not** in the set — removed in v3.7.

## 5. Oracle (at pinned block)

| Item | Value | Read label |
|---|---|---|
| `BASE_CURRENCY_UNIT` | `100000000` (USD, 8 decimals — **read, not assumed**) | `Oracle.BASE_CURRENCY_UNIT` |
| WETH source | `0x5424384B256154046E9667dDFaaa5e550145215e` — `"ETH / USD"`, 8 decimals | `Oracle.getSourceOfAsset(WETH)`, `OracleSource(WETH).description` |
| WETH price | `192386686200` (≈$1,923.87) | `Oracle.getAssetPrice(WETH)` |
| weETH source | `0x87625393534d5C102cADB66D37201dF24cc26d4C` — **`"Capped weETH / eETH(ETH) / USD"`** (CAPO adapter), 8 decimals | `Oracle.getSourceOfAsset(weETH)`, `OracleSource(weETH).description` |
| weETH price | `211593732385` (≈$2,115.94) | `Oracle.getAssetPrice(weETH)` |
| Implied weETH/WETH oracle ratio | ≈1.09984 (== `weETH.getRate` 1.099835…) | derived from the two price reads |

> **§5.4 consequence:** weETH risk pricing is a **capped exchange-rate adapter** over ETH/USD —
> the oracle prices weETH as (capped rate) × ETH/USD. HF for the weETH/WETH pair therefore
> moves with the capped rate ratio, not with the ETH/USD level — confirming the spec's
> liquidation-*ratio* display rule for correlated pairs.

## 6. Token addresses (anchors, re-verified in-run)

| Token | Address | In-run verification |
|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `WETH.symbol`="WETH"; reserve idx 0 in `Pool.getReservesList` |
| eETH | `0x35fA164735182de50811E8e2E824cFb9B6118ac2` | `eETH.symbol`="eETH"; `weETH.eETH (round-trip)`; `LP.eETH (round-trip)` |
| weETH | `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee` | `weETH.symbol`="weETH"; reserve idx 28 |
| stETH | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | `stETH.symbol`="stETH"; `wstETH.stETH (round-trip)` |
| wstETH | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | `wstETH.symbol`="wstETH" |

## 7. EtherFi (ETH → eETH → weETH) — mechanics verified on-chain

| Item | Value | Read label |
|---|---|---|
| LiquidityPool (proxy, deposit target) | `0x308861A430be4cce5502d0A12724771Fc6DaF216` | `weETH.liquidityPool (round-trip)`, `LP.eETH (round-trip)` |
| LiquidityPool implementation | `0x17A16747D03006c9754548AC0d0afF48783A4a45` | `EtherFi LiquidityPool implementation (EIP-1967)` |
| eETH / weETH implementations | `0xd1901dD36CBf4a81386d0162DF2707f7dDb60527` / `0xA6Ca0607190d03CF16fe6F2865Cf40c3D160ccf3` | EIP-1967 reads |
| `weETH.getRate()` | `1099835630856114428` | `weETH.getRate` |
| **Share model, verified live:** `LP.amountForShare(1e18)` | `1099835630856114428` — **exactly equals `getRate()`** | `LP.amountForShare(1e18)` |
| `LP.sharesForAmount(1e18)` | `909226771660050549` | `LP.sharesForAmount(1e18)` |
| `eETH.totalShares` / `LP.getTotalPooledEther` | `1735636641648672966786359` / `1908915020704656042933997` — ratio reproduces the rate | `eETH.totalShares`, `LP.getTotalPooledEther` |

**Deposit semantics (repo source, master `src/core/LiquidityPool.sol`,
https://github.com/etherfi-protocol/smart-contracts):** all `deposit` overloads are `payable`
and **return `uint256` shares minted** (`eETH.mintShares(_recipient, share); return share`);
share computation is `Math.mulDiv(depositAmount, eETH.totalShares(), totalPooledEther,
Rounding.Down)` — **floor**; `amountForShare` is `Math.mulDiv(share, getTotalPooledEther(),
totalShares, Rounding.Down)` — **floor**. Deposits gated by `whenNotPaused` +
`nonBlacklisted`.

**OPEN (explicit):** byte-level equivalence of deployed impl `0x17A16747…` with repo master is
not verified here; the on-chain reads above prove the *current* impl answers the share-model
ABI with values consistent with the repo math. The P1 fork suite empirically pins `deposit()`
return behavior against the deployed implementation before any plan relies on it.

## 8. Lido (P1 scope: reference only — execution is EtherFi-flagship-only)

| Item | Value | Read label |
|---|---|---|
| `wstETH.stEthPerToken()` | `1239952638214169360` (≈1.23995) | `wstETH.stEthPerToken` |

Execution ABI, stake-limit/pause behavior, and rounding for a Lido plan are **not** recorded
here; P1 does not build Lido execution (W03 scope), and these facts must be added before any
phase does.

## 9. OPEN items (tracked, not guessed)

1. EtherFi deployed-impl ↔ repo-master byte equivalence (§7) — empirically pinned by the P1
   fork suite.
2. Numeric `Pool.getRevision()` — not externally readable (recorded expected revert); revision
   claim rests on the implementation mapping + changelog (§2).
3. **WETH `reserve.deficit` is not recorded.** v3.7 feeds `reserve.deficit` into the rate
   strategy as its `unbacked` param (ReserveLogic `updateInterestRatesAndVirtualBalance`,
   read verbatim from main — no v3.7 tag exists), and it enters only the supply-usage
   denominator. The recorded WETH `variableBorrowRate` reproduces **exactly** from recorded
   state; the recorded `liquidityRate` does not reproduce with deficit 0 (weETH does),
   implying a nonzero WETH deficit. Resolution: add `getReserveDeficit` reads to
   `scripts/protocol-reads.mjs` and regenerate this log at the pinned block (archive RPC
   required); the P1 fork suite reads the same getter live from the fork. No value is
   asserted here until read on-chain.
