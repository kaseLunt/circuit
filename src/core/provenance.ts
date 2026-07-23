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

export function observed<T>(
  value: T,
  source: string,
  block: bigint,
  fetchedAt: number,
): Observed<T> {
  return { kind: "observed", value, source, block, fetchedAt };
}

export function derived<T>(
  value: T,
  expression: string,
  inputs: readonly AnyProvenanced[],
): Derived<T> {
  return { kind: "derived", value, expression, inputs };
}

export function entered<T>(value: T): Entered<T> {
  return { kind: "entered", value };
}

export function configured<T>(value: T, name: string, definedAt: string): Configured<T> {
  return { kind: "configured", value, name, definedAt };
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
      return [`${indent}observed ${p.source} @ block ${p.block}`];
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
