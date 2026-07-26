/**
 * What a `/composer` page load turned out to BE, decided in one function.
 *
 * Lifted out of the host component on purpose: this is the whole SPEC §3 step-8 arrival
 * contract — which document a session starts on, and what the user is told — and it is worth
 * asserting without a DOM, a React tree or a layout engine. The host's job is reduced to
 * handing over the token the URL carried.
 *
 * The token is never inspected here. It goes to `loadFromShare`, which is `decodeShareGraph`,
 * which is zod-shape-then-`validateGraph` (SPEC §5.6) — the one pipeline the localStorage
 * draft path also uses. There is no second decoder in this file and no place to add one.
 */
import { createComposerStore, type ComposerStoreApi } from "../../app/store/composer-store";
import type { DecodeFailure } from "../../lib/share/encode";
import { FLAGSHIP_TEMPLATE_ID } from "../../lib/strategy/templates";

/** `share-refused` carries the verdict, not a boolean, so the band can say WHY in the validator's codes. */
export type Arrival =
  | { readonly kind: "template" }
  | { readonly kind: "share" }
  | { readonly kind: "share-refused"; readonly failure: DecodeFailure | null };

export interface ArrivalResolution {
  readonly store: ComposerStoreApi;
  readonly arrival: Arrival;
}

/** SPEC §3 step 1: the composer opens with the Leveraged Restake Loop laid out. */
export function flagshipStore(): ComposerStoreApi {
  const created = createComposerStore();
  created.getState().loadTemplate(FLAGSHIP_TEMPLATE_ID);
  return created;
}

/**
 * `null` means the URL carried no payload — the §3 step-1 path, and the ONLY path that gets
 * the flagship.
 *
 * A refused token returns a store that was never given the flagship, which is the point: the
 * refusal has to land on an EMPTY document, or the reader sees a strategy the sender never
 * sent with nothing to say the link was refused. Building a fresh store rather than blanking
 * the preloaded one is what keeps "clear canvas" out of undo history — undoing back into a
 * flagship nobody asked for would be the substitution arriving one keystroke late.
 */
export function resolveArrival(token: string | null): ArrivalResolution {
  if (token === null) return { store: flagshipStore(), arrival: { kind: "template" } };
  const arrived = createComposerStore();
  const result = arrived.getState().loadFromShare(token);
  return {
    store: arrived,
    arrival: result.ok ? { kind: "share" } : { kind: "share-refused", failure: result.failure },
  };
}
