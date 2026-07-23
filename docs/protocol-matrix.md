# Protocol Matrix — Aave v3 Ethereum **Core** market + EtherFi & Lido staking

Decision-record source-of-truth for contract addresses and risk parameters.
**Scope:** Aave v3 Ethereum **Core** market (a.k.a. "main" market — *not* the separate
`AaveV3EthereumEtherFi` / `AaveV3EthereumLido` / `AaveV3EthereumHorizon` markets),
plus EtherFi (ETH→eETH→weETH) and Lido (ETH→stETH→wstETH) staking tokens.

- **Compiled/verified:** 2026-07-22
- **On-chain reads:** Ethereum mainnet, block **25,592,355 / 25,592,363 / 25,592,367** (≈2026-07-22), via public RPC `https://ethereum-rpc.publicnode.com` (llamarpc/cloudflare/ankr were down or key-gated at the time — see command log).
- **On-chain tool:** viem 2.44.4 from `defi-portfolio-tracker/node_modules` (read-only `eth_call` / `eth_getStorageAt`).
- **Rule applied:** no address is hand-typed from memory. Every value below is either fetched from an authoritative source (URL cited) or read on-chain (command cited), and most have both.

**Verification legend for the "verified-how" column:**
- `AB` = bgd-labs/aave-address-book (`src/AaveV3Ethereum.sol`, generated & on-chain-derived) — https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Ethereum.sol
- `onchain` = direct `eth_call`/`eth_getStorageAt` (see command log / `onchain-output.json`)
- `round-trip` = a getter on contract A returns the address of contract B *and* B's getter returns A (mutual confirmation)

---

## 1. Aave v3 Ethereum Core — market contracts

| Item | Value | Source (URL / on-chain command) | Verified-how | Date |
|---|---|---|---|---|
| PoolAddressesProvider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | AB `POOL_ADDRESSES_PROVIDER`; `Pool.ADDRESSES_PROVIDER()` and `AaveOracle.ADDRESSES_PROVIDER()` both return this | AB + onchain round-trip (2 sources) | 2026-07-22 |
| Pool (proxy) | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | AB `POOL`; `AddressesProvider.getPool()` → this; `WrappedTokenGatewayV3.POOL()` → this | AB + onchain round-trip (3 sources) | 2026-07-22 |
| Pool implementation | `0x728a138A4823392C2EFA55e028d434F526fE03CF` | AB `POOL_IMPL`; EIP-1967 impl slot of Pool proxy = `0x728a138a…` | AB + onchain (EIP-1967 slot) | 2026-07-22 |
| AaveProtocolDataProvider (PoolDataProvider) | `0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD` | AB `AAVE_PROTOCOL_DATA_PROVIDER`; `AddressesProvider.getPoolDataProvider()` → this | AB + onchain | 2026-07-22 |
| AaveOracle | `0x54586bE62E3c3580375aE3723C145253060Ca0C2` | AB `ORACLE`; `AddressesProvider.getPriceOracle()` → this; `AaveOracle.ADDRESSES_PROVIDER()` → AddressesProvider | AB + onchain round-trip | 2026-07-22 |
| WrappedTokenGatewayV3 (WETH gateway) | `0xd01607c3C5eCABa394D8be377a08590149325722` | AB `WETH_GATEWAY`; on-chain `getWETHAddress()` → WETH and `POOL()` → Core Pool | AB + onchain corroboration | 2026-07-22 |
| ACLManager | `0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0` | AB `ACL_MANAGER`; `AddressesProvider.getACLManager()` → this | AB + onchain | 2026-07-22 |

Cross-check of the address-book values against on-chain getters (all matched exactly):

```
AP.getPool             = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2   (== AB POOL)
AP.getPoolDataProvider = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD   (== AB DATA_PROVIDER)
AP.getPriceOracle      = 0x54586bE62E3c3580375aE3723C145253060Ca0C2   (== AB ORACLE)
AP.getACLManager       = 0xc2aaCf6553D20d1e9d78E365AAba8032af9c85b0   (== AB ACL_MANAGER)
POOL.ADDRESSES_PROVIDER    = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e   (== AP)
ORACLE.ADDRESSES_PROVIDER  = 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e   (== AP)
POOL EIP-1967 impl slot    = 0x728a138a4823392c2efa55e028d434f526fe03cf   (== AB POOL_IMPL)
gateway.getWETHAddress()   = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2   (== WETH)
gateway.POOL()             = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2   (== Core Pool)
```

---

## 2. Deployed protocol revision & error model

| Item | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| Deployed Aave version (Ethereum Core) | **v3.6** (deployed Ethereum 2026-01-09) | Aave docs changelog: https://aave.com/docs/resources/changelog — "v3.4 → 2025-07-03; v3.5 → 2025-08-07; v3.6 → 2026-01-09" (v3.6 = "Liquid eMode exclusive collateral/borrowing configs, renounce allowance, gas optimizations") | Authoritative changelog | 2026-07-22 |
| `Pool.getRevision()` on-chain | **Not exposed** (reverts) | `readContract POOL getRevision` → `REVERT: function "getRevision" reverted` | onchain (getter is `internal` in v3.x; cannot read) | 2026-07-22 |
| Error model | **Custom errors** (Solidity `error …;`), *not* numeric `Error(string)` codes | aave-v3-origin `src/contracts/protocol/libraries/helpers/Errors.sol` on `main` declares `error CallerNotPoolAdmin();`, `error EModeCategoryReserved();`, … — https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/helpers/Errors.sol | Source read (v3.4 migrated require-strings → custom errors; current main is v3.6-era) | 2026-07-22 |

> The v3.6 Pool proxy implementation on-chain (`0x728a138A…`) equals the address book's tracked `POOL_IMPL`, consistent with the currently-deployed revision. The numeric revision integer itself could not be read (getter not external).

---

## 3. E-mode — ETH-correlated category (weETH collateral / WETH borrowable)

**Category id = 1, label "ETH correlated".** weETH is eligible collateral and WETH is borrowable in this category (both confirmed on-chain via the category bitmaps, and independently by the address-book category constant).

| Parameter | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| E-mode category id | **1** | on-chain bitmaps; AB constant `WETH_wstETH_cbETH_rETH_weETH_osETH_ETHx__WETH = 1` | onchain + AB (2 sources) | 2026-07-22 |
| Label | `ETH correlated` | `Pool.getEModeCategoryLabel(1)` | onchain | 2026-07-22 |
| LTV | **93.00 %** (9300 bps) | `Pool.getEModeCategoryCollateralConfig(1).ltv` = 9300 | onchain | 2026-07-22 |
| Liquidation threshold | **95.00 %** (9500 bps) | `…CollateralConfig(1).liquidationThreshold` = 9500 | onchain | 2026-07-22 |
| Liquidation bonus | **1.00 %** (10100 bps → 101.00 %) | `…CollateralConfig(1).liquidationBonus` = 10100 | onchain | 2026-07-22 |
| weETH is collateral in cat 1 | **true** | `getEModeCategoryCollateralBitmap(1)` = `2952790659`; bit 28 (weETH reserve index) set | onchain (bitmap decode) | 2026-07-22 |
| WETH is borrowable in cat 1 | **true** | `getEModeCategoryBorrowableBitmap(1)` = `1`; bit 0 (WETH reserve index) set | onchain (bitmap decode) | 2026-07-22 |

**Bitmap decode proof (on-chain, block 25,592,355):** `collateralBitmap = 2952790659`
`= 2^0 + 2^1 + 2^7 + 2^9 + 2^28 + 2^29 + 2^31`
= reserve indices {0,1,7,9,28,29,31} = **{WETH, wstETH, cbETH, rETH, weETH, osETH, ETHx}** — exactly matching the address-book label `WETH_wstETH_cbETH_rETH_weETH_osETH_ETHx__WETH`. `borrowableBitmap = 1` = {WETH} only.

> Context (v3.6 "Liquid eMode"): e-mode membership is expressed as per-category `collateralBitmap`/`borrowableBitmap` over reserve indices, so an asset can belong to multiple categories. Other ETH-ish categories exist (e.g. id 3 `rsETH__ETH_wstETH_ETHx` — WETH borrowable but weETH **not** collateral). Category **1** is the one satisfying "weETH collateral **and** WETH borrowable".

Reserve index reference (position in `Pool.getReservesList()`, = reserve `id` used by the bitmaps): `WETH = 0`, `wstETH = 1`, `cbETH = 7`, `rETH = 9`, `weETH = 28`, `osETH = 29`, `ETHx = 31`.

---

## 4. Reserve parameters — weETH & WETH on Core

On-chain via `AaveProtocolDataProvider.getReserveConfigurationData()` and `getReserveCaps()` (bps: 10000 = 100%). Caps are in **whole tokens**. Current usage from aToken/variableDebtToken `totalSupply()`.

### WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`)

| Parameter | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| Decimals | 18 | `getReserveConfigurationData` / `WETH.decimals()` | onchain | 2026-07-22 |
| LTV | 80.50 % (8050) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Liquidation threshold | 83.00 % (8300) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Liquidation bonus | 5.00 % (10500) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Reserve factor | 15.00 % (1500) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| usageAsCollateralEnabled | true | `getReserveConfigurationData` | onchain | 2026-07-22 |
| borrowingEnabled | true | `getReserveConfigurationData` | onchain | 2026-07-22 |
| isActive / isFrozen / isPaused | true / false / false | `getReserveConfigurationData` + `getPaused` | onchain | 2026-07-22 |
| Supply cap | 2,700,000 WETH | `getReserveCaps.supplyCap` | onchain | 2026-07-22 |
| Borrow cap | 2,400,000 WETH | `getReserveCaps.borrowCap` | onchain | 2026-07-22 |
| Current supplied (aToken totalSupply) | ≈ 2,074,585.41 WETH | aToken `0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8` `.totalSupply()` | onchain | 2026-07-22 |
| **Supply headroom** | ≈ **625,414.6 WETH** (~23.2% free) | supplyCap − supplied | derived | 2026-07-22 |
| Current borrowed (vToken totalSupply) | ≈ 1,686,975.93 WETH | vToken `0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE` `.totalSupply()` | onchain | 2026-07-22 |
| **Borrow headroom** | ≈ **713,024.1 WETH** (~29.7% free) | borrowCap − borrowed | derived | 2026-07-22 |
| aToken / variableDebtToken | `0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8` / `0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE` | `getReserveTokensAddresses(WETH)` | onchain | 2026-07-22 |

### weETH (`0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee`)

| Parameter | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| Decimals | 18 | `getReserveConfigurationData` / `weETH.decimals()` | onchain | 2026-07-22 |
| LTV | 77.50 % (7750) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Liquidation threshold | 80.00 % (8000) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Liquidation bonus | 7.00 % (10700) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| Reserve factor | 45.00 % (4500) | `getReserveConfigurationData` | onchain | 2026-07-22 |
| usageAsCollateralEnabled | true | `getReserveConfigurationData` | onchain | 2026-07-22 |
| borrowingEnabled | **false** | `getReserveConfigurationData` | onchain | 2026-07-22 |
| isActive / isFrozen / isPaused | true / false / false | `getReserveConfigurationData` + `getPaused` | onchain | 2026-07-22 |
| Supply cap | 1,100,000 weETH | `getReserveCaps.supplyCap` | onchain | 2026-07-22 |
| Borrow cap | 1 weETH (borrowing effectively disabled) | `getReserveCaps.borrowCap` | onchain | 2026-07-22 |
| Current supplied (aToken totalSupply) | ≈ 1,056,935.82 weETH | aToken `0xBdfa7b7893081B35Fb54027489e2Bc7A38275129` `.totalSupply()` | onchain | 2026-07-22 |
| **Supply headroom** | ≈ **43,064.2 weETH** (~3.9% free — nearly full) | supplyCap − supplied | derived | 2026-07-22 |
| Current borrowed (vToken totalSupply) | ≈ 50.81 weETH (legacy; new borrows blocked) | vToken `0x77ad9BF13a52517AD698D65913e8D381300c8Bf3` `.totalSupply()` | onchain | 2026-07-22 |
| aToken / variableDebtToken | `0xBdfa7b7893081B35Fb54027489e2Bc7A38275129` / `0x77ad9BF13a52517AD698D65913e8D381300c8Bf3` | `getReserveTokensAddresses(weETH)`; also AB `weETH_A_TOKEN` / `weETH_V_TOKEN` | onchain + AB | 2026-07-22 |

> **weETH is collateral-only on Core**: `borrowingEnabled = false` and `borrowCap = 1`. Supply is near cap (~96% utilized), so **supply headroom is tight (~43k weETH)** — relevant for any strategy that deposits weETH.

---

## 5. Token addresses (Ethereum mainnet)

Each cross-verified between ≥2 independent sources.

| Token | Address | Source 1 | Source 2 (+3) | Verified-how | Date |
|---|---|---|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | AB `WETH_UNDERLYING` | on-chain `symbol()`="WETH", `decimals()`=18; in Aave `getAllReservesTokens()` as "WETH"; `gateway.getWETHAddress()` | AB + onchain (3+) | 2026-07-22 |
| eETH | `0x35fA164735182de50811E8e2E824cFb9B6118ac2` | EtherFi WeETH deployment JSON `constructorArgs._eETH` | on-chain `symbol()`="eETH", `name()`="ether.fi ETH"; `weETH.eETH()`→this; `LiquidityPool.eETH()`→this | EtherFi repo + onchain round-trip (3+) | 2026-07-22 |
| weETH | `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee` | AB `weETH_UNDERLYING`; EtherFi GitBook deployed-contracts | on-chain `symbol()`="weETH", `decimals()`=18; in Aave `getAllReservesTokens()` as "weETH" | AB + EtherFi + onchain (3) | 2026-07-22 |
| stETH | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | Lido docs deployed-contracts (https://docs.lido.fi/deployed-contracts/) | on-chain `symbol()`="stETH", `decimals()`=18; `wstETH.stETH()`→this | Lido docs + onchain round-trip | 2026-07-22 |
| wstETH | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | Lido docs deployed-contracts | AB `wstETH_UNDERLYING`; on-chain `symbol()`="wstETH", `decimals()`=18 | Lido docs + AB + onchain (3) | 2026-07-22 |

---

## 6. EtherFi (ETH → eETH → weETH)

| Item | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| LiquidityPool (proxy — deposit target for ETH→eETH) | `0x308861A430be4cce5502d0A12724771Fc6DaF216` | EtherFi EETH & WeETH deployment JSONs `constructorArgs._liquidityPool` (https://github.com/etherfi-protocol/smart-contracts `deployment/`) | repo + on-chain `weETH.liquidityPool()`→this; `LiquidityPool.eETH()` resolves to eETH | repo + onchain round-trip | 2026-07-22 |
| eETH token (proxy, rebasing) | `0x35fA164735182de50811E8e2E824cFb9B6118ac2` | see Token table | on-chain `symbol()`="eETH"; EIP-1967 impl = `0xd1901dD3…` (= EtherFi `EETH` deployment JSON `deployedAddress`) | repo + onchain | 2026-07-22 |
| weETH wrap contract (= weETH token, proxy) | `0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee` | see Token table | on-chain `getRate()` = `1099835630480344736` (1.09983563… eETH per weETH) — **getRate() exists**; `weETH.eETH()`→eETH; EIP-1967 impl = `0xa6ca0607…` (= WeETH deployment JSON `deployedAddress`) | repo + onchain | 2026-07-22 |
| weETH.getRate() | `1099835630480344736` (≈ 1.0998 eETH / weETH) | on-chain `getRate()` | onchain | 2026-07-22 |

**eETH rebasing / shares mechanics (source):** eETH is a **rebasing** LST — a holder's `balanceOf` grows as staking/restaking rewards accrue; internally the LiquidityPool tracks non-rebasing **shares** and eETH balance = `shares × totalPooledEther / totalShares` (Lido-style share model). **weETH** is the **non-rebasing wrapped** form; 1 weETH ↔ a fixed number of eETH-shares, and `weETH.getRate()` returns the current eETH-per-weETH exchange rate. Sources: EtherFi whitepaper/GitBook — https://etherfi.gitbook.io/etherfi/ether.fi-whitepaper/introduction ("eETH (rebasing) and weETH (wrapped, non-rebasing)") and the EtherFi contracts repo `src/core/WeETH.sol` / `EETH.sol` (https://github.com/etherfi-protocol/smart-contracts). *(The precise share-accounting formula is documentation-derived, not independently re-verified on-chain here — see UNVERIFIED.)*

> Note: the LiquidityPool proxy's on-chain EIP-1967 impl (`0x17a16747d03006c9754548ac0d0aff48783a4a45`) does **not** match the `deployedAddress` in the 2026-03-05 `LiquidityPool` deployment JSON (`0x83bc649f…`), indicating the proxy was upgraded again after that record. The **proxy address itself** (`0x308861A4…`) is solidly verified (constructor args of both token contracts + `weETH.liquidityPool()`).

---

## 7. Lido (ETH → stETH → wstETH)

| Item | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| stETH (Lido core / submit target) | `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | Lido docs deployed-contracts | on-chain `symbol()`="stETH", `decimals()`=18; `wstETH.stETH()`→this | Lido docs + onchain round-trip | 2026-07-22 |
| wstETH (Wrapped stETH) | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | Lido docs deployed-contracts; AB `wstETH_UNDERLYING` | on-chain `symbol()`="wstETH", `stEthPerToken()` exists | Lido docs + AB + onchain | 2026-07-22 |
| wstETH.stEthPerToken() | `1239952638214169360` (≈ 1.23995 stETH / wstETH) | on-chain `stEthPerToken()` | onchain | 2026-07-22 |

> stETH is a rebasing LST (submit ETH → stETH, balance rebases daily). wstETH is the non-rebasing wrapper; `stEthPerToken()` returns the current stETH-per-wstETH rate. Both confirmed on-chain (`wstETH.stETH()` returns the stETH address → mutual link).

---

## 8. AaveOracle

| Item | Value | Source | Verified-how | Date |
|---|---|---|---|---|
| AaveOracle | `0x54586bE62E3c3580375aE3723C145253060Ca0C2` | AB `ORACLE`; `AddressesProvider.getPriceOracle()` | AB + onchain | 2026-07-22 |
| BASE_CURRENCY_UNIT | `100000000` (1e8) → prices denominated in **USD with 8 decimals** | on-chain `AaveOracle.BASE_CURRENCY_UNIT()` | onchain | 2026-07-22 |
| Oracle is a proxy? | No (plain contract) | EIP-1967 impl slot = `0x0` | onchain | 2026-07-22 |

---

## 9. UNVERIFIED / caveats (flagged, not guessed)

1. **`Pool.getRevision()` numeric value** — could not be read on-chain (getter is `internal`; call reverts). Deployed version = **v3.6** is established from the Aave docs changelog (single authoritative source) + corroborating press; the on-chain Pool impl matches the address-book `POOL_IMPL`, but the integer revision itself is UNVERIFIED on-chain.
2. **eETH exact share-accounting formula** — the rebasing/shares model is described from EtherFi documentation + repo; the precise `balanceOf = shares × totalPooledEther / totalShares` formula was **not** independently re-derived via on-chain reads in this pass (documentation-sourced).
3. **EtherFi GitBook page** — the `contracts-and-integrations/deployed-contracts` GitBook URL returned 404 at fetch time; EtherFi addresses were instead sourced from the official **etherfi-protocol/smart-contracts** GitHub `deployment/*.json` files (constructor args = proxy addresses) plus on-chain round-trips, which is stronger. GitBook is cited only as a secondary corroborator (via search snippet) for weETH.
4. **LiquidityPool implementation drift** — on-chain proxy impl differs from the newest deployment JSON I retrieved (see §6 note). The proxy address is verified; the exact current implementation contract was not chased further.
5. All risk parameters and caps are **point-in-time** (block ≈25,592,355, 2026-07-22). Aave risk params change via governance — re-read before relying on caps/headroom.

---

## Appendix A — Command log

All commands were read-only. Scripts and raw outputs are saved alongside this file in
`C:\Users\kasel\AppData\Local\Temp\claude\audit-extract\`.

**Authoritative-source fetches**
- `WebFetch https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Ethereum.sol` → Pool/Provider/DataProvider/Oracle/WETH_GATEWAY/POOL_IMPL/ACL_MANAGER constants.
- `gh api repos/bgd-labs/aave-address-book/contents/src/AaveV3Ethereum.sol` (base64-decoded) → `library AaveV3EthereumAssets`: `WETH_UNDERLYING`, `wstETH_UNDERLYING`, `weETH_UNDERLYING`, `weETH_A_TOKEN`/`weETH_V_TOKEN`, e-mode constant `WETH_wstETH_cbETH_rETH_weETH_osETH_ETHx__WETH = 1`.
- `WebFetch https://aave.com/docs/resources/changelog` → v3.4=2025-07-03, v3.5=2025-08-07, v3.6=2026-01-09 (Ethereum).
- `gh api repos/aave-dao/aave-v3-origin/contents/src/contracts/protocol/libraries/helpers/Errors.sol` → confirms custom `error …;` declarations (not numeric strings).
- `WebFetch https://docs.lido.fi/deployed-contracts/` → stETH, wstETH.
- `gh api repos/etherfi-protocol/smart-contracts/contents/deployment/{EETH,WeETH,LiquidityPool}/*.json` → eETH/weETH/LiquidityPool proxy + impl addresses.

**On-chain scripts** (viem 2.44.4, RPC `https://ethereum-rpc.publicnode.com`)
- `verify.mjs` → full read set (AddressesProvider getters, Pool round-trip + getReservesList + getRevision, Oracle BASE_CURRENCY_UNIT, DataProvider getAllReservesTokens + per-reserve config/caps/paused/tokens, e-mode cats 1–12 label/config/bitmaps, EtherFi & Lido token reads, EIP-1967 impl slots). Output: `onchain-output.json`.
- `headroom.mjs` → aToken/variableDebtToken `totalSupply()` for WETH and weETH.
- inline `node -e` → `WrappedTokenGatewayV3.getWETHAddress()` / `.POOL()` / `.owner()`.
- RPC probe: `eth.llamarpc.com` returned Cloudflare 521 (down); `cloudflare-eth.com` "Cannot fulfill request"; `rpc.ankr.com/eth` key-gated; `publicnode`/`drpc`/`1rpc` OK.

## Appendix B — Raw on-chain values (selected, block ≈25,592,355)

```
ORACLE.BASE_CURRENCY_UNIT = 100000000
emode[1] label="ETH correlated" ltv=9300 lt=9500 bonus=10100 collateralBitmap=2952790659 borrowableBitmap=1
  → weETH(idx28) collateral=true, WETH(idx0) borrowable=true
WETH  cfg: dec18 ltv8050 lt8300 bonus10500 rf1500 collat=true borrow=true active=true frozen=false paused=false
WETH  caps: supply=2700000 borrow=2400000 ; aTokenTS=2074585.4078 vTokenTS=1686975.9287
weETH cfg: dec18 ltv7750 lt8000 bonus10700 rf4500 collat=true borrow=false active=true frozen=false paused=false
weETH caps: supply=1100000 borrow=1 ; aTokenTS=1056935.8248 vTokenTS=50.8076
weETH.getRate=1099835630480344736  weETH.eETH=0x35fA1647… weETH.liquidityPool=0x308861A4…
LP.eETH=0x35fA1647…  wstETH.stEthPerToken=1239952638214169360  wstETH.stETH=0xae7ab965…
EIP1967 impl: eETH=0xd1901dD3… weETH=0xa6ca0607… POOL=0x728a138a… ORACLE=0x0(none)
```
