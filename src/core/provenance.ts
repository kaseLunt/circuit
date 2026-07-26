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
  /**
   * The FORMULA and nothing else, e.g. "collateralBase * b_bps / 1e4 (floor)".
   *
   * The WHY belongs in `note`. Concatenating the two — "formula — because reason" — was the
   * habit this split ends: it made one unbreakable string that a renderer could neither
   * style differently nor wrap sensibly, and it buried the justification inside what reads
   * as arithmetic.
   */
  readonly expression: string;
  /** The provenanced inputs the derivation consumed. */
  readonly inputs: readonly AnyProvenanced[];
  /**
   * WHY this derivation is correct, or which regime it belongs to — rendered distinguishably
   * from the formula and never folded into `expression`.
   *
   * A LIST, not one slot, because qualifications COMPOSE: a cross-block derivation carries
   * both its own justification and its window licence, and a single field made the second
   * silently overwrite the first. Each entry renders as its own line; none is a substitute
   * for another.
   */
  readonly notes?: readonly string[];
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
  note?: string,
): Derived<T> {
  const blocks = new Set<bigint>();
  for (const i of inputs) observedBlocks(i, blocks);
  if (blocks.size > 1) {
    throw new RangeError(
      `derived value mixes observations from multiple blocks: ${[...blocks].join(", ")}`,
    );
  }
  return note === undefined
    ? { kind: "derived", value, expression, inputs }
    : { kind: "derived", value, expression, inputs, notes: [note] };
}

/**
 * A derivation whose inputs are deliberately read at DIFFERENT blocks.
 *
 * `derived` forbids this, and that ban is the repo's primary no-fabrication enforcement: a
 * quantity assembled from two moments of chain state, presented as one reading, is the most
 * plausible-looking lie a rates layer can tell. So this is not a relaxation of that rule — it
 * is a SECOND, NARROWER rule for the one quantity that cannot obey the first.
 *
 * The trailing exchange-rate APR (SPEC §5.1) is that quantity, and it is the only one in v1.
 * An instantaneous exchange rate is not an APR: an APR is a rate of CHANGE, so it has two
 * endpoints, and two endpoints are two reads at two blocks. Refusing the crossing would not
 * make the number safer, it would delete it.
 *
 * The guard is therefore the exact INVERSE of `derived`'s — at least TWO distinct observed
 * blocks are REQUIRED — so this cannot be used as a way around the same-block rule. A
 * single-block derivation must go through `derived`; passing one here is a bug and throws.
 *
 * `windowReason` is mandatory and non-empty, and is APPENDED to the derivation's notes, so
 * `provenanceTrail` renders WHY the crossing is correct instead of quietly showing two block
 * numbers and leaving the reader to wonder. It is a NOTE rather than part of the expression
 * because it is a justification, not arithmetic — and a renderer must be able to tell them
 * apart. `Derived<T>`'s shape is otherwise unchanged, so `observedBlocks` needs no edit and
 * the surface simply shows both read points, which is the honest rendering.
 */
export function derivedOverWindow<T>(
  value: T,
  expression: string,
  inputs: readonly AnyProvenanced[],
  windowReason: string,
  note?: string,
): Derived<T> {
  if (windowReason.trim() === "") {
    throw new RangeError(
      "derivedOverWindow requires a windowReason: an unexplained cross-block derivation is exactly what derived() exists to forbid",
    );
  }
  const blocks = new Set<bigint>();
  for (const i of inputs) observedBlocks(i, blocks);
  if (blocks.size < 2) {
    throw new RangeError(
      `derivedOverWindow requires observations from at least two distinct blocks, got ${blocks.size}; a single-block derivation must use derived()`,
    );
  }
  return {
    kind: "derived",
    value,
    expression,
    inputs,
    // APPENDED, never assigned over: the mint's own qualification survives alongside the
    // licence. Assigning here is precisely how "§5.2 … incentives and points excluded by
    // construction" stopped rendering anywhere.
    notes: [...(note === undefined ? [] : [note]), `cross-block window: ${windowReason}`],
  };
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
 * One line of a provenance trail, with its nesting expressed as DATA.
 *
 * Depth used to be baked into the text as leading spaces, which forced every renderer to
 * treat the trail as preformatted: a line that wrapped put its continuation back at column
 * zero, under the wrong parent, so a deep tree read as a flat list of unrelated claims. As a
 * number, the renderer can indent with padding and let wrapped continuations stay under
 * their own entry.
 */
export interface TrailEntry {
  /** 0 for the value itself; each level of inputs is one deeper. */
  readonly depth: number;
  /** The claim: a citation, a formula, or the fact that a human typed it. */
  readonly text: string;
  /** The derivation's justifications, if it carries any. Rendered apart from `text`. */
  readonly notes?: readonly string[];
}

/**
 * Flatten a provenanced value's origin chain into renderable entries. `Observed` cites
 * source + block; `Derived` states its formula, carries its note, and recurses into its
 * inputs.
 */
export function provenanceTrail(p: AnyProvenanced, depth = 0): TrailEntry[] {
  switch (p.kind) {
    case "observed":
      return [
        {
          depth,
          text: `observed ${p.source} @ block ${p.block} · ${formatBlockTime(p.fetchedAt)}`,
        },
      ];
    case "configured":
      return [{ depth, text: `configured ${p.name} (${p.definedAt})` }];
    case "entered":
      return [{ depth, text: "entered by user" }];
    case "derived":
      return [
        p.notes === undefined
          ? { depth, text: `derived: ${p.expression}` }
          : { depth, text: `derived: ${p.expression}`, notes: p.notes },
        ...p.inputs.flatMap((i) => provenanceTrail(i, depth + 1)),
      ];
  }
}

/**
 * The trail as flat text, for assertions and for any caller that wants one string.
 * Notes ride with their entry so nothing a derivation claimed can be dropped by flattening.
 */
export function provenanceTrailText(p: AnyProvenanced): string[] {
  return provenanceTrail(p).map((entry) => {
    const notes = (entry.notes ?? []).map((note) => ` [${note}]`).join("");
    return `${"  ".repeat(entry.depth)}${entry.text}${notes}`;
  });
}

/** The deepest level in a trail — what a capped renderer needs to know it is capping. */
export function provenanceDepth(p: AnyProvenanced): number {
  return provenanceTrail(p).reduce((deepest, entry) => Math.max(deepest, entry.depth), 0);
}

/**
 * Suppress a note on an entry when the SAME note already appears on one of its descendants.
 *
 * A fact originates where it is first true. `derivedOverWindow` propagates the window licence
 * up every composition that consumes a cross-block value — which is the invariant that stops a
 * composition from looking single-block — but rendering the same sentence at three nesting
 * levels in the first screenful buries the trail it is supposed to clarify.
 *
 * So this is a RENDER concern and nothing else: the data is untouched, `observedBlocks` is
 * untouched, and the licence is still on every ancestor for any consumer that inspects it.
 * Only the echo is dropped, and only when the identical text is provably visible below.
 */
export function withoutInheritedNotes(
  entries: readonly TrailEntry[],
): readonly TrailEntry[] {
  return entries.map((entry, index) => {
    if (entry.notes === undefined) return entry;
    const descendants = new Set<string>();
    for (let i = index + 1; i < entries.length; i += 1) {
      const candidate = entries[i]!;
      if (candidate.depth <= entry.depth) break;
      for (const note of candidate.notes ?? []) descendants.add(note);
    }
    const kept = entry.notes.filter((note) => !descendants.has(note));
    if (kept.length === entry.notes.length) return entry;
    return kept.length === 0
      ? { depth: entry.depth, text: entry.text }
      : { depth: entry.depth, text: entry.text, notes: kept };
  });
}
