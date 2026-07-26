/**
 * The share LINK — where a token sits in a URL, and the words this app uses when a link is
 * refused. Pure: no React, no DOM, no store, no `window`.
 *
 * Deliberately not folded into `encode.ts`. That module owns the TOKEN and the one
 * decode-and-validate pipeline; this one owns the two things a token is not. Keeping the
 * refusal copy here is what makes it a single authority: `encodeShareGraph` and
 * `decodeShareGraph` refuse the same documents with the same codes (encode.ts, W05 R3), so
 * the author's screen and the recipient's screen must not describe one failure two ways.
 *
 * The two directions get their own describer rather than one function with a direction flag,
 * because the SENTENCE differs even where the code does not: `too-large` on the author's
 * screen is "this strategy will not fit in a link", and on the recipient's it is "this link
 * is longer than we will read". A shared table would have had to hedge both into something
 * true of neither.
 */
import { MAX_ENCODED_LENGTH, buildShareFragment, type DecodeFailure, type EncodeFailure } from "./encode";
import type { StrategyGraph } from "../../core/graph";

/**
 * How much of a refusal reaches the screen.
 *
 * Bounded because the source is UNTRUSTED: a `schema` failure's issues are built from paths
 * and keys the sender chose, so an attacker picks that text. React escapes it, so this is not
 * an injection guard — it is a refusal that stays a refusal instead of becoming a page of
 * someone else's prose. Showing some of it is the point: a link refused with no reason is
 * indistinguishable from a broken app.
 */
export const MAX_REFUSAL_DETAILS = 3;
export const MAX_REFUSAL_DETAIL_LENGTH = 120;

export interface ShareRefusal {
  /** What happened, in one line. */
  readonly headline: string;
  /** Why, in the app's own words — never the payload's. */
  readonly reason: string;
  /** Bounded evidence from the validator. May be empty; never fabricated. */
  readonly details: readonly string[];
}

/**
 * The cap is stated, never silent. A `schema` refusal can carry a wall of issues, and a
 * report truncated without saying so is a failure to report — the same ruling the chrome
 * band already encodes for the read-set alert.
 */
function bounded(lines: readonly string[]): readonly string[] {
  const shown = lines.slice(0, MAX_REFUSAL_DETAILS).map((line) =>
    line.length <= MAX_REFUSAL_DETAIL_LENGTH
      ? line
      : `${line.slice(0, MAX_REFUSAL_DETAIL_LENGTH)}…`,
  );
  const hidden = lines.length - shown.length;
  return hidden > 0 ? [...shown, `+${hidden} more`] : shown;
}

/** A version field from an untrusted payload, rendered without trusting its type. */
function describeVersion(found: unknown): readonly string[] {
  if (typeof found === "string" || typeof found === "number" || typeof found === "boolean") {
    return bounded([`payload version ${String(found)}`]);
  }
  if (found === null || found === undefined) return ["payload carries no version"];
  return ["payload version is not a readable value"];
}

const COMPOSE_HEADLINE = "This strategy could not be shared.";
const ARRIVAL_HEADLINE = "This link could not be opened.";

/**
 * The author's side. Reached only when the document on screen cannot be transported — which
 * is a statement about the document, not about the link, so the copy never says "link".
 */
export function describeComposeFailure(failure: EncodeFailure): ShareRefusal {
  switch (failure.code) {
    case "schema":
      // NOT "fix the flagged blocks": a value the transport refuses is not necessarily a
      // value `validateGraph` refuses, so the canvas may be showing no flag at all. Copy
      // that points at a marker which is not there teaches the user to distrust the markers.
      return {
        headline: COMPOSE_HEADLINE,
        reason: "A block holds a value a link can't carry.",
        details: bounded(failure.issues),
      };
    case "graph-invalid":
      return {
        headline: COMPOSE_HEADLINE,
        reason: "Fix the flagged blocks before sharing.",
        details: bounded(failure.errors),
      };
    case "too-large":
      return {
        headline: COMPOSE_HEADLINE,
        reason: "This strategy is too large to share.",
        details: bounded([`${failure.length} characters, limit ${MAX_ENCODED_LENGTH}`]),
      };
  }
}

/**
 * The recipient's side. Every branch names what was refused WITHOUT implying the sender is
 * hostile and without implying the app is broken — the two wrong readings of a refused link.
 */
export function describeArrivalFailure(failure: DecodeFailure | null): ShareRefusal {
  if (failure === null) {
    // `LoadResult.failure` is nullable because the draft path can refuse an empty slot with
    // nothing to report. An arrival should never land here; if it does, the honest answer is
    // that we do not know why, not a guessed code.
    return {
      headline: ARRIVAL_HEADLINE,
      reason: "The link was refused without a recorded reason.",
      details: [],
    };
  }
  switch (failure.code) {
    case "too-large":
      return {
        headline: ARRIVAL_HEADLINE,
        reason: "The link is larger than a strategy can be.",
        details: [`limit ${MAX_ENCODED_LENGTH} characters`],
      };
    // One sentence for two codes, and deliberately so: "the base64 body would not decode"
    // and "the bytes were not JSON" are the same event to the person holding the link — it
    // did not survive the trip. Splitting them would spend the reader's attention on a
    // distinction only the codec can act on.
    case "not-base64url":
    case "not-json":
      return {
        headline: ARRIVAL_HEADLINE,
        reason: "The link is damaged or incomplete.",
        details: [],
      };
    case "unsupported-version":
      return {
        headline: ARRIVAL_HEADLINE,
        reason: "This link was made by a newer version of Circuit.",
        details: describeVersion(failure.found),
      };
    case "schema":
      return {
        headline: ARRIVAL_HEADLINE,
        reason: "The link doesn't describe a strategy this version can open.",
        details: bounded(failure.issues),
      };
    case "graph-invalid":
      return {
        headline: ARRIVAL_HEADLINE,
        reason: "The strategy in this link isn't valid.",
        details: bounded(failure.errors),
      };
  }
}

/** The part of `window.location` a share URL is built from. Structural, so tests need no DOM. */
export interface ShareBase {
  readonly origin: string;
  readonly pathname: string;
}

export type ShareUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly failure: EncodeFailure };

/**
 * The absolute URL a person copies.
 *
 * `search` is deliberately dropped rather than carried forward: the arrival reader accepts a
 * `?g=` token as a recorded compatibility path, so preserving an inbound query would let a
 * stale token ride alongside the fresh fragment and win nothing but ambiguity. A share link
 * carries exactly one payload, in the fragment, and nothing else.
 */
export function buildShareUrl(graph: StrategyGraph, base: ShareBase): ShareUrlResult {
  const built = buildShareFragment(graph);
  if (!built.ok) return built;
  return { ok: true, url: `${base.origin}${base.pathname}${built.fragment}` };
}
