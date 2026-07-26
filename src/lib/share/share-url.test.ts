import { describe, expect, it } from "vitest";
import {
  MAX_ENCODED_LENGTH,
  SHARE_PARAM,
  decodeShareGraph,
  readShareToken,
  type DecodeFailure,
  type EncodeFailure,
} from "./encode";
import {
  MAX_REFUSAL_DETAILS,
  MAX_REFUSAL_DETAIL_LENGTH,
  buildShareUrl,
  describeArrivalFailure,
  describeComposeFailure,
} from "./share-url";
import type { StrategyGraph } from "../../core/graph";
import { flagshipGraph } from "../../../tests/helpers/graphs";

const BASE = { origin: "https://circuit.test", pathname: "/composer" };

describe("buildShareUrl — the link a person copies", () => {
  it("is an absolute URL whose fragment round-trips through the ONE decode pipeline", () => {
    const graph = flagshipGraph();
    const built = buildShareUrl(graph, BASE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const url = new URL(built.url);
    expect(url.origin).toBe(BASE.origin);
    expect(url.pathname).toBe(BASE.pathname);
    // The payload is in the FRAGMENT, not the query: encode.ts's recorded decision keeps a
    // shared graph out of access logs, Referer headers and CDN cache keys.
    expect(url.search).toBe("");
    expect(url.hash.startsWith(`#${SHARE_PARAM}=`)).toBe(true);

    const token = readShareToken({ hash: url.hash });
    expect(token).not.toBeNull();
    const decoded = decodeShareGraph(token ?? "");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.graph).toEqual(graph);
  });

  it("drops an inbound query so one link can never carry two payloads", () => {
    // The base has no `search` field at all — the type does not offer one, which is the
    // guarantee: a stale `?g=` on the page the author is standing on cannot ride along and
    // compete with the fresh fragment at the recipient's `readShareToken`.
    const built = buildShareUrl(flagshipGraph(), BASE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.url.includes("?")).toBe(false);
  });

  it("propagates the encoder's refusal instead of minting a link the receiver would reject", () => {
    const cyclic: StrategyGraph = {
      blocks: [
        { id: "a", type: "stake", params: { protocol: "etherfi" } },
        { id: "b", type: "stake", params: { protocol: "etherfi" } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b", allocationBps: 10_000 },
        { id: "e2", source: "b", target: "a", allocationBps: 10_000 },
      ],
    };
    const built = buildShareUrl(cyclic, BASE);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.failure.code).toBe("graph-invalid");
  });
});

describe("describeComposeFailure — the author's screen", () => {
  it("names the document, never the link, and carries the validator's own words", () => {
    const failure: EncodeFailure = { code: "graph-invalid", errors: ["edge e1: cycle"] };
    const refusal = describeComposeFailure(failure);
    expect(refusal.headline).toBe("This strategy could not be shared.");
    expect(refusal.reason).toBe("Fix the flagged blocks before sharing.");
    expect(refusal.details).toEqual(["edge e1: cycle"]);
  });

  it("does not point at a flag the canvas is not showing for a transport-only refusal", () => {
    const refusal = describeComposeFailure({ code: "schema", issues: ["b.in.p.to: nope"] });
    expect(refusal.reason).toBe("A block holds a value a link can't carry.");
    expect(refusal.reason.includes("flagged")).toBe(false);
  });

  it("states the measured length against the limit for an oversize document", () => {
    const refusal = describeComposeFailure({ code: "too-large", length: 20_000 });
    expect(refusal.reason).toBe("This strategy is too large to share.");
    expect(refusal.details).toEqual([`20000 characters, limit ${MAX_ENCODED_LENGTH}`]);
  });
});

describe("describeArrivalFailure — the recipient's screen", () => {
  it("has a sentence for every DecodeFailure code, and none of them blames the reader", () => {
    const failures: readonly DecodeFailure[] = [
      { code: "too-large" },
      { code: "not-base64url" },
      { code: "not-json" },
      { code: "unsupported-version", found: 2 },
      { code: "schema", issues: ["b.in.p.asset: not accepted"] },
      { code: "graph-invalid", errors: ["block in: unknown asset"] },
    ];
    for (const failure of failures) {
      const refusal = describeArrivalFailure(failure);
      expect(refusal.headline, failure.code).toBe("This link could not be opened.");
      expect(refusal.reason.length, failure.code).toBeGreaterThan(0);
      // The refusal describes the payload, not the person holding it.
      expect(refusal.reason.toLowerCase(), failure.code).not.toContain("you ");
    }
  });

  it("folds the two damaged-payload codes into one sentence", () => {
    expect(describeArrivalFailure({ code: "not-base64url" }).reason).toBe(
      describeArrivalFailure({ code: "not-json" }).reason,
    );
  });

  it("renders an untrusted version field without trusting its type", () => {
    expect(describeArrivalFailure({ code: "unsupported-version", found: 7 }).details).toEqual([
      "payload version 7",
    ]);
    expect(describeArrivalFailure({ code: "unsupported-version", found: null }).details).toEqual([
      "payload carries no version",
    ]);
    expect(
      describeArrivalFailure({ code: "unsupported-version", found: undefined }).details,
    ).toEqual(["payload carries no version"]);
    expect(
      describeArrivalFailure({ code: "unsupported-version", found: { nested: true } }).details,
    ).toEqual(["payload version is not a readable value"]);
    expect(describeArrivalFailure({ code: "unsupported-version", found: true }).details).toEqual([
      "payload version true",
    ]);
    // Bounded even here: `found` is attacker-chosen.
    const long = describeArrivalFailure({
      code: "unsupported-version",
      found: "v".repeat(500),
    }).details;
    expect(long).toHaveLength(1);
    // The whole composed line is bounded, prefix included — the cap is on what reaches the
    // screen, not on the attacker-supplied fragment of it. `+ 1` is the ellipsis.
    expect(long[0]?.length).toBe(MAX_REFUSAL_DETAIL_LENGTH + 1);
    expect(long[0]?.startsWith("payload version ")).toBe(true);
  });

  it("caps detail lines and SAYS it capped them — a silent truncation is a failure to report", () => {
    const issues = Array.from({ length: 9 }, (_, i) => `b.block${i}.p.asset: not accepted`);
    const details = describeArrivalFailure({ code: "schema", issues }).details;
    expect(details).toHaveLength(MAX_REFUSAL_DETAILS + 1);
    expect(details[MAX_REFUSAL_DETAILS]).toBe(`+${9 - MAX_REFUSAL_DETAILS} more`);
  });

  it("adds no counter when nothing was hidden", () => {
    const details = describeArrivalFailure({ code: "graph-invalid", errors: ["one"] }).details;
    expect(details).toEqual(["one"]);
  });

  it("truncates an over-long line with an ellipsis rather than dropping it", () => {
    const line = "x".repeat(MAX_REFUSAL_DETAIL_LENGTH + 40);
    const details = describeArrivalFailure({ code: "schema", issues: [line] }).details;
    expect(details).toHaveLength(1);
    expect(details[0]).toBe(`${"x".repeat(MAX_REFUSAL_DETAIL_LENGTH)}…`);
  });

  it("refuses honestly when the store reported no code at all", () => {
    const refusal = describeArrivalFailure(null);
    expect(refusal.headline).toBe("This link could not be opened.");
    expect(refusal.reason).toBe("The link was refused without a recorded reason.");
    expect(refusal.details).toEqual([]);
  });
});
