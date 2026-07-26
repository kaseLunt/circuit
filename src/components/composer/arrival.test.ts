/**
 * The §3 step-8 arrival contract, asserted without a DOM.
 *
 * The hostile corpus is deliberately NOT re-authored here: it is minted the way an attacker
 * would (hand-built payload, hand-built base64url) rather than through `encodeShareGraph`,
 * which now refuses the same documents the decoder does. SPEC §5.6's requirement is that a
 * hostile payload arriving BY URL is refused exactly as one arriving in-process — so what
 * these tests prove is that the arrival path adds no second, weaker gate in front of
 * `validateGraph`, and that a refusal never leaves a strategy the sender did not send on the
 * canvas.
 */
import { describe, expect, it } from "vitest";
import { resolveArrival, flagshipStore } from "./arrival";
import { buildShareFragment, readShareToken, SHARE_PARAM } from "../../lib/share/encode";
import { FLAGSHIP_TEMPLATE_ID, getTemplate } from "../../lib/strategy/templates";
import type { StrategyGraph } from "../../core/graph";
import { flagshipGraph } from "../../../tests/helpers/graphs";

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function tokenFor(graph: StrategyGraph): string {
  const built = buildShareFragment(graph);
  if (!built.ok) throw new Error(`fixture is not shareable: ${built.failure.code}`);
  const token = readShareToken({ hash: built.fragment });
  if (token === null) throw new Error("fixture fragment carried no token");
  return token;
}

describe("resolveArrival — no token", () => {
  it("opens on the flagship (SPEC §3 step 1) and reports the template arrival", () => {
    const { store, arrival } = resolveArrival(null);
    const state = store.getState();
    expect(arrival).toEqual({ kind: "template" });
    expect(state.loadedFrom).toEqual({ kind: "template", templateId: FLAGSHIP_TEMPLATE_ID });
    expect(state.lastLoadProblem).toBeNull();

    const template = getTemplate(FLAGSHIP_TEMPLATE_ID);
    expect(template).toBeDefined();
    expect(state.doc).toEqual(template?.graph());
  });

  it("agrees with the store the host preloads for the prerendered first paint", () => {
    expect(flagshipStore().getState().doc).toEqual(resolveArrival(null).store.getState().doc);
  });
});

describe("resolveArrival — a valid token", () => {
  it("rehydrates the IDENTICAL graph and never substitutes the flagship", () => {
    const shared = flagshipGraph();
    const { store, arrival } = resolveArrival(tokenFor(shared));
    const state = store.getState();

    expect(arrival).toEqual({ kind: "share" });
    expect(state.doc).toEqual(shared);
    expect(state.loadedFrom).toEqual({ kind: "share-url" });
    expect(state.lastLoadProblem).toBeNull();
  });

  it("arrives with every block laid out and nothing selected or half-edited", () => {
    const shared = flagshipGraph();
    const state = resolveArrival(tokenFor(shared)).store.getState();
    for (const block of shared.blocks) expect(state.view[block.id]).toBeDefined();
    expect(state.selectedBlockIds).toEqual([]);
    expect(state.pendingEdit).toBeNull();
    // Nothing to undo INTO: a link is an arrival, not an edit of something that was here.
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
  });

  it("carries no Auto badge for a wrap that arrived in the payload", () => {
    // Treatment §1: the graph must be byte-identical whether a wrap was typed or inserted,
    // so a share-arrived wrap is indistinguishable from a user-placed one BY DESIGN.
    const shared = flagshipGraph();
    const state = resolveArrival(tokenFor(shared)).store.getState();
    const badged = Object.values(state.view).filter((entry) => entry.isAutoInserted);
    expect(badged).toEqual([]);
  });

  it("marks share-arrived parameters as the sender's choices, not a template's defaults", () => {
    // A template arrives carrying the author's named constants; a link carries numbers a
    // person chose. Reading them as Configured would put a definition site behind a value
    // nobody defined.
    const state = resolveArrival(tokenFor(flagshipGraph())).store.getState();
    expect(state.paramOrigins).toEqual({});
  });
});

describe("resolveArrival — a refused token (SPEC §5.6)", () => {
  /** Every refusal lands the same way: empty canvas, reason recorded, no substitution. */
  function expectRefused(token: string, code: string): void {
    const { store, arrival } = resolveArrival(token);
    const state = store.getState();
    expect(arrival.kind, code).toBe("share-refused");
    if (arrival.kind !== "share-refused") return;
    expect(arrival.failure?.code, code).toBe(code);
    expect(state.lastLoadProblem?.code, code).toBe(code);
    // THE point of the whole arrival design: a refused link must not leave a strategy on
    // screen that the sender never sent.
    expect(state.doc.blocks, code).toEqual([]);
    expect(state.doc.edges, code).toEqual([]);
    // And it must not be undoable back into one either.
    expect(state.past, code).toEqual([]);
  }

  it("refuses a hostile address on a whitelisted parameter key", () => {
    const payload = {
      v: 1,
      b: [
        { i: "in", t: "input", p: { asset: "ETH", amount: "10" } },
        {
          i: "supply1",
          t: "lend",
          p: { protocol: "aave-v3", asset: "0x000000000000000000000000000000000000dEaD" },
        },
      ],
      e: [{ i: "e1", s: "in", t: "supply1", a: 10_000 }],
    };
    expectRefused(b64url(JSON.stringify(payload)), "schema");
  });

  it("refuses a parameter key core never reads", () => {
    const payload = {
      v: 1,
      b: [{ i: "in", t: "input", p: { asset: "ETH", amount: "10", to: "weETH" } }],
      e: [],
    };
    expectRefused(b64url(JSON.stringify(payload)), "schema");
  });

  it("refuses a schema-valid but structurally malformed graph at core/graph.ts", () => {
    // Shape-legal in every zod sense; `validateGraph` is the gate that catches the dangling
    // edge target. This is the assertion that proves the second gate actually runs.
    const payload = {
      v: 1,
      b: [{ i: "in", t: "input", p: { asset: "ETH", amount: "10" } }],
      e: [{ i: "e1", s: "in", t: "ghost", a: 10_000 }],
    };
    expectRefused(b64url(JSON.stringify(payload)), "graph-invalid");
  });

  it("refuses a payload written by another version", () => {
    expectRefused(b64url(JSON.stringify({ v: 99, b: [], e: [] })), "unsupported-version");
  });

  it("refuses a token that is not base64url at all", () => {
    expectRefused("not a token!!", "not-base64url");
  });

  it("refuses a token that decodes to something that is not JSON", () => {
    expectRefused(b64url("plainly not json"), "not-json");
  });
});

describe("the URL reader the host hands to resolveArrival", () => {
  it("prefers the fragment, and still honours the recorded ?g= compatibility path", () => {
    const token = tokenFor(flagshipGraph());
    expect(readShareToken({ hash: `#${SHARE_PARAM}=${token}` })).toBe(token);
    expect(readShareToken({ search: `?${SHARE_PARAM}=${token}` })).toBe(token);
    expect(
      readShareToken({ hash: `#${SHARE_PARAM}=${token}`, search: `?${SHARE_PARAM}=stale` }),
    ).toBe(token);
  });

  it("reports no token for the plain composer URL, which is the flagship path", () => {
    expect(readShareToken({ hash: "", search: "" })).toBeNull();
    expect(resolveArrival(readShareToken({ hash: "", search: "" })).arrival.kind).toBe("template");
  });
});
