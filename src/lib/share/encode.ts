/**
 * Share/draft transport codec for the strategy graph (SPEC §5.6). Pure — no React,
 * no store import, no I/O.
 *
 * ONE decode-and-validate pipeline serves TWO untrusted transports: the share-URL
 * fragment and the localStorage draft. localStorage is user-writable, so a draft is
 * exactly as untrusted as a stranger's link; a `persist`-style rehydrate would skip
 * both gates below and put an unvalidated graph on the canvas.
 *
 * Two gates, in this order, never collapsed: zod answers "is this the shape and the
 * value domain we transport", `core/graph.ts` answers "is this a graph we may plan".
 * The second gate IS `validateGraph`, not a re-implementation, so the malicious-graph
 * suite rejects a hostile URL payload exactly as it rejects an in-process one.
 *
 * ENCODING VALIDATES TOO (W05 R3, a recorded deviation from the design's "encoding
 * never validates"): minting a token the receiver will refuse moves the failure from
 * the author's screen, where it can be explained, to a stranger's. Encode and decode
 * therefore refuse the same documents with the same codes.
 *
 * The payload carries no address, no rate, no price and no position: block ids +
 * whitelisted structural params + integer bps. Execution targets are resolved at plan
 * time from the block-pinned ChainSnapshot, so no URL can influence `TransactionStep.to`.
 */
import { z } from "zod";
import {
  MAX_BLOCKS,
  MAX_EDGES,
  validateGraph,
  type Block,
  type BlockType,
  type Edge,
  type LendProtocol,
  type StakeProtocol,
  type StrategyGraph,
} from "../../core/graph";
import { ASSETS } from "../../core/route-optimizer";
import { FULL_ALLOCATION_BPS } from "../strategy/types";

export const SHARE_PARAM = "g";
export const SHARE_VERSION = 1;

/**
 * Hard cap checked BEFORE any decode work, and again before a token is handed out.
 *
 * Derived, not guessed: the verifier measured a MAX_BLOCKS (64) single-producer chain
 * with composer-minted ids at 9412 chars, so 16384 leaves ~74% headroom over the
 * realistic worst case while staying inside every practical URL limit. The residual is
 * deliberate and surfaced rather than hidden: a 64-block graph whose ids all sit at the
 * 32-char id ceiling encodes to ~17.7 KB, and `encodeShareGraph` refuses it with
 * `too-large` instead of minting a link the receiver would reject.
 */
export const MAX_ENCODED_LENGTH = 16_384;

/** Draft slot. Versioned so a future payload shape cannot be read as this one. */
export const DRAFT_STORAGE_KEY = "composer:draft:v1";

/** The bps floor core enforces (`graph.ts` rejects < 1). One declaration; the store imports it. */
export const MIN_ALLOCATION_BPS = 1;

const MAX_PARAMS_PER_BLOCK = 8;
const MAX_PARAM_VALUE_LENGTH = 64;

/**
 * The ONLY parameter keys that may ride a transport, per block type — exactly the
 * keys `validateGraph`'s per-block checks read. Keyed by core's `BlockType`, so a new
 * block type is a compile error here rather than an unguarded param surface.
 *
 * This whitelist is the only thing standing between an attacker-chosen key and
 * `block.params`: `validateGraph` ignores params it does not read, so an address, a
 * rate or a forged `isConfigured` would otherwise decode clean, enter undo history,
 * and be re-shared.
 */
const PARAM_KEYS: Readonly<Record<BlockType, readonly string[]>> = {
  input: ["asset", "amount"],
  stake: ["protocol"],
  wrap: ["from", "to"],
  unwrap: ["from", "to"],
  lend: ["protocol", "asset"],
  borrow: ["protocol", "asset", "allocationBps"],
};

/** Keyed by core's unions, so adding a protocol there is a compile error here. */
const STAKE_PROTOCOLS: Readonly<Record<StakeProtocol, true>> = { etherfi: true, lido: true };
const LEND_PROTOCOLS: Readonly<Record<LendProtocol, true>> = { "aave-v3": true };
/** Derived from core's `Asset` union via route-optimizer's ASSET_MEMBERS — never hand-listed. */
const ASSET_VALUES: ReadonlySet<string> = new Set<string>(ASSETS);

/** The decimal form `graph.ts` parses. Magnitude is core's call — see isAllowedParamValue. */
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

const BLOCK_TYPE_VALUES = ["input", "stake", "wrap", "unwrap", "lend", "borrow"] as const;
type ListedBlockType = (typeof BLOCK_TYPE_VALUES)[number];

/**
 * Compile pin, both directions: the transported enum and core's `BlockType` must be the
 * same set. Adding a member to either alone resolves this annotation to `never` and the
 * build breaks — the same anti-drift technique as route-optimizer's WRAP_PAIRS pin.
 */
export const BLOCK_TYPES_MATCH_CORE: [ListedBlockType, BlockType] extends [BlockType, ListedBlockType]
  ? true
  : never = true;

export function isAllowedParamKey(type: BlockType, key: string): boolean {
  // Array membership, not object lookup: an attacker-supplied key cannot reach
  // Object.prototype through `includes`.
  return PARAM_KEYS[type].includes(key);
}

/**
 * The transportable VALUE domain, per key. A key whitelist alone was the hole: with it,
 * `{ t: "lend", p: { asset: "0x…dEaD" } }` cleared the transport and only core's
 * LEND_ASSETS enum stopped it downstream — and the store's write path has no
 * `validateGraph` at all, so the address would have landed in the doc, in undo history
 * and in the next share link.
 *
 * Deliberately NOT narrowed to core's executable sets (LEND_ASSETS / BORROW_ASSETS /
 * the wrap matrix): those are core's semantics, and restating them here would create a
 * second authority that can drift. This gate answers only "is this a value of the right
 * KIND" — an asset symbol from core's vocabulary, a protocol id, a decimal amount, an
 * integer bps. Magnitude and executability stay with `validateGraph` and `buildPlan`.
 *
 * Fails closed: a key added to PARAM_KEYS without a domain here is refused, not admitted.
 */
export function isAllowedParamValue(
  type: BlockType,
  key: string,
  value: string | number,
): boolean {
  if (!isAllowedParamKey(type, key)) return false;
  switch (key) {
    case "asset":
    case "from":
    case "to":
      return typeof value === "string" && ASSET_VALUES.has(value);
    case "protocol":
      if (typeof value !== "string") return false;
      return type === "stake"
        ? Object.hasOwn(STAKE_PROTOCOLS, value)
        : Object.hasOwn(LEND_PROTOCOLS, value);
    case "amount":
      // Both shapes core accepts: the composer's decimal STRING (exact, JSON-safe) and
      // the numeric form plan.ts still parses. Rejecting the numeric arm here would make
      // a validateGraph-VALID graph untransportable.
      if (typeof value === "number") return Number.isFinite(value) && value > 0;
      return value.length <= MAX_PARAM_VALUE_LENGTH && DECIMAL_AMOUNT.test(value);
    case "allocationBps":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_ALLOCATION_BPS &&
        value <= FULL_ALLOCATION_BPS
      );
    default:
      return false;
  }
}

/** Block ids stay colon-free: `TransactionStep.id` is `${blockId}:supply`, so a colon in
 *  a block id would make step ids ambiguous. */
const BLOCK_ID = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "block id charset/length");
/** Edge ids admit ':' — the composer mints `e:${target}` and edge ids are never
 *  calldata-bearing. Bounded at 40: an `e:` prefix plus a maximal block id. */
const EDGE_ID = z.string().regex(/^[A-Za-z0-9:_-]{1,40}$/, "edge id charset/length");

const PARAM_KEY = z.string().regex(/^[a-zA-Z]{1,24}$/, "parameter key charset/length");
const PARAM_VALUE = z.union([z.string().max(MAX_PARAM_VALUE_LENGTH), z.number()]);

const blockSchema = z.strictObject({
  i: BLOCK_ID,
  t: z.enum(BLOCK_TYPE_VALUES),
  p: z
    .record(PARAM_KEY, PARAM_VALUE)
    .refine((r) => Object.keys(r).length <= MAX_PARAMS_PER_BLOCK, "too many params"),
});

const edgeSchema = z.strictObject({
  i: EDGE_ID,
  s: BLOCK_ID,
  t: BLOCK_ID,
  a: z.number().int().gte(MIN_ALLOCATION_BPS).lte(FULL_ALLOCATION_BPS),
});

const payloadSchema = z.strictObject({
  v: z.literal(SHARE_VERSION),
  b: z.array(blockSchema).min(1).max(MAX_BLOCKS),
  e: z.array(edgeSchema).max(MAX_EDGES),
});

/** Probes the version before the full parse so a newer link reports "made by a newer
 *  version" instead of a wall of shape issues. */
const versionProbe = z.object({ v: z.unknown() });

export type DecodeFailure =
  | { readonly code: "too-large" }
  | { readonly code: "not-base64url" }
  | { readonly code: "not-json" }
  | { readonly code: "unsupported-version"; readonly found: unknown }
  | { readonly code: "schema"; readonly issues: readonly string[] }
  | { readonly code: "graph-invalid"; readonly errors: readonly string[] };

export type DecodeResult =
  | { readonly ok: true; readonly graph: StrategyGraph }
  | { readonly ok: false; readonly failure: DecodeFailure };

export type EncodeFailure =
  | { readonly code: "schema"; readonly issues: readonly string[] }
  | { readonly code: "graph-invalid"; readonly errors: readonly string[] }
  | { readonly code: "too-large"; readonly length: number };

export type EncodeResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly failure: EncodeFailure };

function base64UrlFromUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Throws on a malformed body or on invalid UTF-8 (`fatal`), which the caller reports
 *  as `not-base64url` rather than guessing at a repair. */
function utf8FromBase64Url(encoded: string): string {
  const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (standard.length % 4)) % 4;
  const bytes = Uint8Array.from(atob(standard + "=".repeat(padding)), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Every param on every block that is not an accepted key/value pair for its type. */
function paramIssues(
  blocks: readonly { readonly id: string; readonly type: BlockType; readonly params: Readonly<Record<string, string | number>> }[],
): string[] {
  const issues: string[] = [];
  for (const b of blocks) {
    for (const [key, value] of Object.entries(b.params)) {
      if (!isAllowedParamValue(b.type, key, value)) {
        issues.push(`b.${b.id}.p.${key}: not an accepted ${b.type} parameter or value`);
      }
    }
  }
  return issues;
}

function payloadOf(g: StrategyGraph): unknown {
  return {
    v: SHARE_VERSION,
    b: g.blocks.map((b) => ({ i: b.id, t: b.type, p: b.params })),
    e: g.edges.map((e) => ({ i: e.id, s: e.source, t: e.target, a: e.allocationBps })),
  };
}

/**
 * Refuses exactly what `decodeShareGraph` refuses, with the same codes: a document the
 * transport cannot carry is a designed, explained state on the author's screen, not a
 * broken link on the recipient's.
 */
export function encodeShareGraph(g: StrategyGraph): EncodeResult {
  const issues = paramIssues(g.blocks);
  if (issues.length > 0) return { ok: false, failure: { code: "schema", issues } };
  const structural = validateGraph(g);
  if (!structural.ok) {
    return { ok: false, failure: { code: "graph-invalid", errors: structural.errors } };
  }
  const token = base64UrlFromUtf8(JSON.stringify(payloadOf(g)));
  if (token.length > MAX_ENCODED_LENGTH) {
    return { ok: false, failure: { code: "too-large", length: token.length } };
  }
  return { ok: true, token };
}

/** Schema validation is NOT graph validation (SPEC §5.6). Both gates, in this order. */
export function decodeShareGraph(encoded: string): DecodeResult {
  if (encoded.length > MAX_ENCODED_LENGTH) return { ok: false, failure: { code: "too-large" } };
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, failure: { code: "not-base64url" } };

  let text: string;
  try {
    text = utf8FromBase64Url(encoded);
  } catch {
    return { ok: false, failure: { code: "not-base64url" } };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, failure: { code: "not-json" } };
  }

  const probe = versionProbe.safeParse(json);
  if (probe.success && probe.data.v !== SHARE_VERSION) {
    return { ok: false, failure: { code: "unsupported-version", found: probe.data.v } };
  }

  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      failure: {
        code: "schema",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    };
  }

  const candidates = parsed.data.b.map((b) => ({
    id: b.i,
    type: b.t,
    // fromEntries, not `params[key] = value`: a key of "__proto__" surviving into an
    // assignment would hit Object.prototype's setter instead of creating an own
    // property. The whitelist below refuses such a key anyway; this is the belt.
    params: Object.fromEntries(Object.entries(b.p)) as Readonly<Record<string, string | number>>,
  }));

  const issues = paramIssues(candidates);
  if (issues.length > 0) return { ok: false, failure: { code: "schema", issues } };

  const blocks: Block[] = candidates.map((b) => ({ id: b.id, type: b.type, params: b.params }));
  const edges: Edge[] = parsed.data.e.map((e) => ({
    id: e.i,
    source: e.s,
    target: e.t,
    allocationBps: e.a,
  }));
  const graph: StrategyGraph = { blocks, edges };

  const structural = validateGraph(graph);
  if (!structural.ok) {
    return { ok: false, failure: { code: "graph-invalid", errors: structural.errors } };
  }
  return { ok: true, graph };
}

/**
 * The payload rides the FRAGMENT: fragments are never sent to the server, so a shared
 * graph stays out of access logs, `Referer` headers and CDN cache keys. Rehydration is
 * client-side anyway.
 */
export function buildShareFragment(
  g: StrategyGraph,
): { readonly ok: true; readonly fragment: string } | { readonly ok: false; readonly failure: EncodeFailure } {
  const encoded = encodeShareGraph(g);
  if (!encoded.ok) return encoded;
  return { ok: true, fragment: `#${SHARE_PARAM}=${encoded.token}` };
}

export interface ShareLocation {
  readonly hash?: string;
  readonly search?: string;
}

/**
 * Fragment first, `?g=` as the recorded compatibility read path — the decode pipeline is
 * identical either way. Deliberately no size cap here: an oversize token is returned
 * verbatim so `decodeShareGraph` can report `too-large` instead of the link vanishing.
 */
export function readShareToken(location: ShareLocation): string | null {
  const fromHash = paramFrom(location.hash);
  return fromHash === null ? paramFrom(location.search) : fromHash;
}

function paramFrom(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const query = raw.startsWith("#") || raw.startsWith("?") ? raw.slice(1) : raw;
  if (query.length === 0) return null;
  const value = new URLSearchParams(query).get(SHARE_PARAM);
  return value === null || value.length === 0 ? null : value;
}
