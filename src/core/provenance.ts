/**
 * Typed provenance for every renderable quantity (SPEC §7 numbers policy).
 *
 * A bare `number`/`bigint` must not reach a money/rate/risk display boundary; it
 * arrives wrapped in `Provenanced<T>` whose `kind` states where the value came
 * from. This is the primary no-fabrication enforcement — the display layer
 * requires the wrapper, and nothing may construct an `Observed` from a literal
 * (an invariant the test suite asserts).
 *
 * Pure: no I/O, no React.
 */

import { formatBlockTime } from "./format";

/** A value read directly from chain state at a specific block. */
export interface Observed<T> {
  readonly kind: "observed";
  readonly value: T;
  /** Contract + method the value was read from, e.g. "AaveOracle.getAssetPrice(weETH)". */
  readonly source: string;
  /** Block number the read was pinned to. */
  readonly block: bigint;
  /** Unix seconds of the source block (not the poll time). */
  readonly fetchedAt: number;
}

/** A value computed by tested math over other provenanced inputs. */
export interface Derived<T> {
  readonly kind: "derived";
  readonly value: T;
  /** Human-readable formula, e.g. "collateralBase * b_bps / 1e4 (floor)". */
  readonly expression: string;
  /** The provenanced inputs the derivation consumed. */
  readonly inputs: readonly AnyProvenanced[];
}

/** A value entered by the user (an allocation, an input amount). */
export interface Entered<T> {
  readonly kind: "entered";
  readonly value: T;
}

/** A named constant with the site that defines it. */
export interface Configured<T> {
  readonly kind: "configured";
  readonly value: T;
  readonly name: string;
  readonly definedAt: string;
}

export type Provenanced<T> = Observed<T> | Derived<T> | Entered<T> | Configured<T>;
// Heterogeneous provenance list (a derivation's inputs may differ in T).
export type AnyProvenanced = Provenanced<unknown>;

/**
 * A snapshot context binds every observation to one block. `server/chain` mints
 * a single `ObservationMinter` per block-pinned read set and uses `.observe(...)`
 * for all reads, so observations cannot drift across blocks and an `Observed`
 * always carries a real block from an actual snapshot rather than a bare literal.
 */
export interface ObservationMinter {
  readonly block: bigint;
  readonly fetchedAt: number;
  observe<T>(value: T, source: string): Observed<T>;
}

export function observationMinter(block: bigint, fetchedAt: number): ObservationMinter {
  if (block <= 0n) throw new RangeError("block must be positive");
  return {
    block,
    fetchedAt,
    observe(value, source) {
      return observed(value, source, block, fetchedAt);
    },
  };
}

// Intentionally NOT exported: the only public way to mint an Observed is through
// `observationMinter`, which server/chain creates from a real block-pinned
// snapshot. Keeping this internal removes casual literal-labeling in core and
// keeps observation creation at the chain-snapshot boundary (D-004 finding 6).
// An ESLint no-restricted-syntax rule (eslint.config.mjs) additionally forbids
// forging the shape via a `{ kind: "observed" }` object literal anywhere but
// this file. (TS structural typing can't prove an actual RPC read; a runtime
// brand would only prove factory use, so same-block-derivation enforcement +
// this construction boundary is the honest limit.)
function observed<T>(value: T, source: string, block: bigint, fetchedAt: number): Observed<T> {
  return { kind: "observed", value, source, block, fetchedAt };
}

/** Distinct blocks any `observed` leaves in a provenance tree were read at. */
export function observedBlocks(p: AnyProvenanced, acc: Set<bigint> = new Set()): Set<bigint> {
  if (p.kind === "observed") acc.add(p.block);
  else if (p.kind === "derived") for (const i of p.inputs) observedBlocks(i, acc);
  return acc;
}

/**
 * Construct a derived value. Enforces that all observed leaves across its inputs
 * were read at the SAME block — a derivation mixing blocks is a correctness bug
 * (SPEC §5.4 block-pinned reads), so it throws rather than silently producing a
 * cross-block number.
 */
export function derived<T>(
  value: T,
  expression: string,
  inputs: readonly AnyProvenanced[],
): Derived<T> {
  const blocks = new Set<bigint>();
  for (const i of inputs) observedBlocks(i, blocks);
  if (blocks.size > 1) {
    throw new RangeError(
      `derived value mixes observations from multiple blocks: ${[...blocks].join(", ")}`,
    );
  }
  return { kind: "derived", value, expression, inputs };
}

export function entered<T>(value: T): Entered<T> {
  return { kind: "entered", value };
}

export function configured<T>(value: T, name: string, definedAt: string): Configured<T> {
  return { kind: "configured", value, name, definedAt };
}

// ————————————————————— user-editable param origins —————————————————————

/**
 * The citation a `Configured` param carries: a named author's default and where it lives.
 */
export interface ConfiguredOrigin {
  readonly name: string;
  readonly definedAt: string;
}

/**
 * Where each user-editable param came from, keyed by `paramOriginKey`.
 *
 * ABSENCE MEANS ENTERED, and the asymmetry is deliberate. A template default is a specific
 * claim — this exact named constant, at this exact file — so it must be recorded to be
 * made. "A human chose this" is the residual case, and it is also the honest default for
 * every caller that does not track origins at all (the live path, the fork suite), whose
 * params really do come from a person.
 *
 * This map lives BESIDE the document, never inside it. The document is transported in share
 * URLs, hashed for fixture identity and compared byte-for-byte by the template identity
 * gate; origin is a fact about how the session reached a value, not part of the value.
 */
export type ParamOrigins = Readonly<Record<string, ConfiguredOrigin>>;

/** Namespaced so an edge id can never collide with a block id. */
export function paramOriginKey(owner: "block" | "edge", id: string, param: string): string {
  return `${owner}:${id}.${param}`;
}

/**
 * The ONE place a user-editable param becomes provenanced — used by the store's display
 * readers and by `core/plan.ts`'s calldata boundary, so the tooltip and the derivation tree
 * cannot disagree about the same number.
 *
 * Until the user touches it, a template's allocation is `Configured("DEFAULT_...", ...)`:
 * claiming `Entered` for a value nobody entered is the same class of dishonesty as claiming
 * `Observed` for a value nobody read, and it is the easier one to ship by accident because
 * the number is already sitting in the document.
 */
export function wrapParam<T>(value: T, origin: ConfiguredOrigin | undefined): Provenanced<T> {
  return origin === undefined ? entered(value) : configured(value, origin.name, origin.definedAt);
}

/** Unwrap the underlying value regardless of provenance kind. */
export function valueOf<T>(p: Provenanced<T>): T {
  return p.value;
}

/**
 * Flatten a provenanced value's origin chain into human-readable lines for a
 * tooltip. `Observed` cites source + block; `Derived` recurses into its inputs.
 */
export function provenanceTrail(p: AnyProvenanced, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  switch (p.kind) {
    case "observed":
      return [
        `${indent}observed ${p.source} @ block ${p.block} · ${formatBlockTime(p.fetchedAt)}`,
      ];
    case "configured":
      return [`${indent}configured ${p.name} (${p.definedAt})`];
    case "entered":
      return [`${indent}entered by user`];
    case "derived":
      return [
        `${indent}derived: ${p.expression}`,
        ...p.inputs.flatMap((i) => provenanceTrail(i, depth + 1)),
      ];
  }
}
