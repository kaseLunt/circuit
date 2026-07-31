import { describe, expect, it } from "vitest";
import { MAX_BLOCKS, validateGraph, type Block, type StrategyGraph } from "../../core/graph";
import { carryGraph, flagshipGraph } from "../../../tests/helpers/graphs";
import {
  MAX_ENCODED_LENGTH,
  SHARE_PARAM,
  SHARE_VERSION,
  buildShareFragment,
  decodeShareGraph,
  encodeShareGraph,
  isAllowedParamValue,
  readShareToken,
  type DecodeFailure,
} from "./encode";

/**
 * The malicious corpus below is graph.test.ts's suite re-aimed at the URL transport:
 * SPEC §5.6 requires a hostile payload to be rejected exactly as an in-process graph is.
 * Hostile payloads are minted by `tokenFor` rather than by `encodeShareGraph`, because
 * the encoder now refuses them (W05 R3) — an attacker does not use our encoder.
 */
function tokenFor(payload: unknown): string {
  return b64url(JSON.stringify(payload));
}

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The token's own JSON, decoded with the padding the length actually needs. */
function jsonOf(token: string): string {
  const standard = token.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (standard.length % 4)) % 4;
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(standard + "=".repeat(padding)), (c) => c.charCodeAt(0)),
  );
}

function payloadOf(graph: StrategyGraph, overrides: Record<string, unknown> = {}): unknown {
  return {
    v: SHARE_VERSION,
    b: graph.blocks.map((b) => ({ i: b.id, t: b.type, p: b.params })),
    e: graph.edges.map((e) => ({ i: e.id, s: e.source, t: e.target, a: e.allocationBps })),
    ...overrides,
  };
}

function withParams(id: string, params: Record<string, string | number>): StrategyGraph {
  const g = flagshipGraph();
  return { blocks: g.blocks.map((b) => (b.id === id ? { ...b, params } : b)), edges: g.edges };
}

function tokenOf(graph: StrategyGraph): string {
  const encoded = encodeShareGraph(graph);
  if (!encoded.ok) throw new Error(`fixture is not shareable: ${JSON.stringify(encoded.failure)}`);
  return encoded.token;
}

function failureOf(token: string): DecodeFailure {
  const result = decodeShareGraph(token);
  if (result.ok) throw new Error("expected the payload to be rejected");
  return result.failure;
}

function graphOf(token: string): StrategyGraph {
  const result = decodeShareGraph(token);
  if (!result.ok) throw new Error(`expected the payload to decode: ${JSON.stringify(result.failure)}`);
  return result.graph;
}

/** A single-producer chain at MAX_BLOCKS with the ids the composer actually mints. */
function maxBlocksChain(): StrategyGraph {
  const blocks: Block[] = [{ id: "in", type: "input", params: { asset: "ETH", amount: "10" } }];
  for (let i = 1; i < MAX_BLOCKS; i += 1) {
    blocks.push(
      i % 2 === 1
        ? { id: `stake${i}`, type: "stake", params: { protocol: "etherfi" } }
        : { id: `wrap${i}`, type: "wrap", params: { from: "eETH", to: "weETH" } },
    );
  }
  const ids = blocks.map((b) => b.id);
  return {
    blocks,
    edges: ids.slice(0, -1).map((source, i) => ({
      id: `e:${ids[i + 1]!}`,
      source,
      target: ids[i + 1]!,
      allocationBps: 10_000,
    })),
  };
}

describe("share codec — round trip", () => {
  it("decodes to a graph identical to the one encoded", () => {
    const g = flagshipGraph();
    expect(graphOf(tokenOf(g))).toEqual(g);
  });

  /**
   * The carry rides the same untrusted transport, and USDC is a NEW value in it — so the
   * accepting direction is pinned beside the refusals. The token carries a block-id graph and
   * integer bps; the USDC address is resolved at plan time from the snapshot and never
   * travels.
   */
  it("round-trips the USDC carry, carrying no address for the new asset", () => {
    const g = carryGraph();
    expect(graphOf(tokenOf(g))).toEqual(g);
    expect(tokenOf(g)).not.toContain("0x");
  });

  it("transports foreign edge ids verbatim rather than regenerating them", () => {
    const g = flagshipGraph();
    const foreign: StrategyGraph = {
      blocks: g.blocks,
      edges: g.edges.map((e, i) => ({ ...e, id: `e${i}` })),
    };
    expect(graphOf(tokenOf(foreign))).toEqual(foreign);
  });

  it("round-trips a single-block graph and an 18-decimal amount", () => {
    const g: StrategyGraph = {
      blocks: [
        { id: "in", type: "input", params: { asset: "ETH", amount: "0.000000000000000001" } },
      ],
      edges: [],
    };
    expect(graphOf(tokenOf(g))).toEqual(g);
  });

  it("transports a numeric input amount that validateGraph accepts", () => {
    // The codec must not be narrower than core: plan.test.ts plans a numeric-amount
    // fixture, so a numeric amount has to survive the transport.
    const g = flagshipGraph(100_000);
    expect(validateGraph(g).ok).toBe(true);
    expect(graphOf(tokenOf(g))).toEqual(g);
  });

  it("round-trips a MAX_BLOCKS graph inside the encoded-length cap", () => {
    const g = maxBlocksChain();
    expect(g.blocks).toHaveLength(MAX_BLOCKS);
    expect(validateGraph(g).ok).toBe(true);
    const token = tokenOf(g);
    expect(token.length).toBeLessThanOrEqual(MAX_ENCODED_LENGTH);
    expect(graphOf(token)).toEqual(g);
  });

  it("round-trips through the URL fragment, and through ?g= as the compat read path", () => {
    const g = flagshipGraph();
    const built = buildShareFragment(g);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.fragment.startsWith(`#${SHARE_PARAM}=`)).toBe(true);

    const fromHash = readShareToken({ hash: built.fragment });
    expect(fromHash).not.toBeNull();
    expect(fromHash !== null && decodeShareGraph(fromHash).ok).toBe(true);

    const fromQuery = readShareToken({ search: `?${SHARE_PARAM}=${tokenOf(g)}&other=1` });
    expect(fromQuery !== null && decodeShareGraph(fromQuery).ok).toBe(true);
    expect(readShareToken({ hash: "", search: "" })).toBeNull();
    expect(readShareToken({})).toBeNull();
  });

  it("transports no position, no rate and no address field", () => {
    const json = jsonOf(tokenOf(flagshipGraph()));
    for (const banned of ['"x"', '"y"', "apy", "0x", "maxLtv", "isConfigured"]) {
      expect(json.includes(banned), banned).toBe(false);
    }
  });
});

describe("share codec — encoding refuses what decoding would (W05 R3)", () => {
  it("refuses an invalid document instead of minting a link the receiver rejects", () => {
    const cycle: StrategyGraph = {
      blocks: flagshipGraph().blocks,
      edges: [
        ...flagshipGraph().edges,
        { id: "back", source: "supply2", target: "in", allocationBps: 10_000 },
      ],
    };
    const encoded = encodeShareGraph(cycle);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.failure.code).toBe("graph-invalid");
    if (encoded.failure.code !== "graph-invalid") return;
    expect(encoded.failure.errors.some((e) => e.includes("graph is not acyclic"))).toBe(true);
    // buildShareFragment propagates the refusal, so the Share affordance can explain it.
    expect(buildShareFragment(cycle).ok).toBe(false);
  });

  it("refuses a document carrying a parameter the transport does not accept", () => {
    const poisoned = withParams("supply1", {
      protocol: "aave-v3",
      asset: "0x000000000000000000000000000000000000dEaD",
    });
    const encoded = encodeShareGraph(poisoned);
    expect(encoded.ok).toBe(false);
    if (encoded.ok || encoded.failure.code !== "schema") return;
    expect(encoded.failure.issues.join(" ")).toContain("b.supply1.p.asset");
  });

  it("refuses a graph whose ids push it past the encoded-length cap", () => {
    // The honest residual behind MAX_ENCODED_LENGTH: at MAX_BLOCKS with maximal ids the
    // payload exceeds the cap, and the author is told at share time.
    const blocks: Block[] = [
      { id: `in${"0".repeat(30)}`, type: "input", params: { asset: "ETH", amount: "10" } },
    ];
    for (let i = 1; i < MAX_BLOCKS; i += 1) {
      blocks.push({
        id: `s${String(i).padStart(31, "0")}`,
        type: "stake",
        params: { protocol: "etherfi" },
      });
    }
    const ids = blocks.map((b) => b.id);
    const g: StrategyGraph = {
      blocks,
      edges: ids.slice(0, -1).map((source, i) => ({
        id: `e:${ids[i + 1]!}`,
        source,
        target: ids[i + 1]!,
        allocationBps: 10_000,
      })),
    };
    expect(validateGraph(g).ok).toBe(true);
    const encoded = encodeShareGraph(g);
    expect(encoded.ok).toBe(false);
    if (encoded.ok || encoded.failure.code !== "too-large") return;
    expect(encoded.failure.length).toBeGreaterThan(MAX_ENCODED_LENGTH);
  });
});

describe("share codec — transport rejections", () => {
  it("rejects an oversize payload before decoding it", () => {
    expect(failureOf("A".repeat(MAX_ENCODED_LENGTH + 1)).code).toBe("too-large");
  });

  it("rejects a non-base64url alphabet and an undecodable body", () => {
    expect(failureOf("abc$def").code).toBe("not-base64url");
    expect(failureOf("a").code).toBe("not-base64url");
  });

  it("rejects a decodable non-JSON body", () => {
    expect(failureOf(b64url("not json")).code).toBe("not-json");
  });

  it("rejects a payload from another version, naming what it found", () => {
    expect(failureOf(tokenFor(payloadOf(flagshipGraph(), { v: 2 })))).toEqual({
      code: "unsupported-version",
      found: 2,
    });
  });
});

describe("share codec — shape gate (zod)", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["unknown top-level key", payloadOf(flagshipGraph(), { extra: 1 })],
    ["unknown block key", { v: SHARE_VERSION, b: [{ i: "in", t: "input", p: {}, z: 1 }], e: [] }],
    ["no blocks", { v: SHARE_VERSION, b: [], e: [] }],
    ["block id charset", { v: SHARE_VERSION, b: [{ i: "in put", t: "input", p: {} }], e: [] }],
    ["block id length", { v: SHARE_VERSION, b: [{ i: "i".repeat(33), t: "input", p: {} }], e: [] }],
    ["unknown block type", { v: SHARE_VERSION, b: [{ i: "in", t: "loop", p: {} }], e: [] }],
    [
      "param key charset",
      { v: SHARE_VERSION, b: [{ i: "in", t: "input", p: { "amount-2": "1" } }], e: [] },
    ],
    [
      "param value length",
      { v: SHARE_VERSION, b: [{ i: "in", t: "input", p: { amount: "9".repeat(65) } }], e: [] },
    ],
    [
      "too many params",
      {
        v: SHARE_VERSION,
        b: [
          {
            i: "in",
            t: "input",
            p: { a: "1", b: "1", c: "1", d: "1", e: "1", f: "1", g: "1", h: "1", i: "1" },
          },
        ],
        e: [],
      },
    ],
    [
      "edge allocation below 1",
      payloadOf({
        ...flagshipGraph(),
        edges: flagshipGraph().edges.map((e) => ({ ...e, allocationBps: 0 })),
      }),
    ],
    [
      "edge allocation above 10000",
      payloadOf({
        ...flagshipGraph(),
        edges: flagshipGraph().edges.map((e) => ({ ...e, allocationBps: 12_000 })),
      }),
    ],
    [
      "too many blocks",
      {
        v: SHARE_VERSION,
        b: Array.from({ length: MAX_BLOCKS + 1 }, (_unused, i) => ({
          i: `b${i}`,
          t: "stake",
          p: {},
        })),
        e: [],
      },
    ],
    [
      "too many edges",
      {
        v: SHARE_VERSION,
        b: [{ i: "in", t: "input", p: {} }],
        e: Array.from({ length: 129 }, (_unused, i) => ({ i: `e${i}`, s: "in", t: "in", a: 1 })),
      },
    ],
  ];

  it.each(cases)("rejects %s at the schema gate", (_name, payload) => {
    expect(failureOf(tokenFor(payload)).code).toBe("schema");
  });
});

describe("share codec — parameter key and value domains (W05 R7)", () => {
  it("rejects a parameter core does not read", () => {
    const hostile = payloadOf(flagshipGraph());
    const blocks = (hostile as { b: Array<{ p: Record<string, unknown> }> }).b;
    blocks[0]!.p["to"] = "0x000000000000000000000000000000000000dEaD";
    const failure = failureOf(tokenFor(hostile));
    expect(failure.code).toBe("schema");
    if (failure.code !== "schema") return;
    expect(failure.issues.join(" ")).toContain("b.in.p.to");
  });

  it("rejects an address on a WHITELISTED key — the hole a key-only whitelist left open", () => {
    const hostile = payloadOf(
      withParams("supply1", {
        protocol: "aave-v3",
        asset: "0x000000000000000000000000000000000000dEaD",
      }),
    );
    const failure = failureOf(tokenFor(hostile));
    expect(failure.code).toBe("schema");
    if (failure.code !== "schema") return;
    expect(failure.issues.join(" ")).toContain("b.supply1.p.asset");
  });

  it("rejects out-of-vocabulary and malformed values on every whitelisted key", () => {
    const rejected: ReadonlyArray<readonly [string, Record<string, string | number>, string]> = [
      ["input asset", { asset: "USDT", amount: "10" }, "in"],
      ["input amount shape", { asset: "ETH", amount: "1e3" }, "in"],
      ["input amount blank", { asset: "ETH", amount: "" }, "in"],
      ["input amount padded", { asset: "ETH", amount: " 10" }, "in"],
      ["input amount negative", { asset: "ETH", amount: "-1" }, "in"],
      ["stake protocol", { protocol: "attacker" }, "stake1"],
      // USDT, not USDC: USDC joined core's `Asset` vocabulary with the W09 carry leg, so it
      // now clears this gate (and is refused downstream by the wrap matrix, below) exactly as
      // WETH would. The row still needs a symbol core has never heard of.
      ["wrap asset", { from: "eETH", to: "USDT" }, "wrap1"],
      ["lend protocol", { protocol: "compound", asset: "weETH" }, "supply1"],
      [
        "borrow bps out of range",
        { protocol: "aave-v3", asset: "WETH", allocationBps: 10_001 },
        "borrow",
      ],
      [
        "borrow bps fractional",
        { protocol: "aave-v3", asset: "WETH", allocationBps: 70.5 },
        "borrow",
      ],
      ["borrow bps zero", { protocol: "aave-v3", asset: "WETH", allocationBps: 0 }, "borrow"],
    ];
    for (const [name, params, id] of rejected) {
      const failure = failureOf(tokenFor(payloadOf(withParams(id, params))));
      expect(failure.code, name).toBe("schema");
    }
  });

  it("has a domain for every whitelisted key — no key is admitted without one", () => {
    // Fails closed: adding a key to the whitelist without a value domain makes this fail,
    // rather than opening an unguarded value surface.
    const accepted: ReadonlyArray<readonly [Parameters<typeof isAllowedParamValue>[0], string, string | number]> = [
      ["input", "asset", "ETH"],
      ["input", "amount", "10"],
      ["stake", "protocol", "etherfi"],
      ["wrap", "from", "eETH"],
      ["wrap", "to", "weETH"],
      ["unwrap", "from", "WETH"],
      ["unwrap", "to", "ETH"],
      ["lend", "protocol", "aave-v3"],
      ["lend", "asset", "weETH"],
      ["borrow", "protocol", "aave-v3"],
      ["borrow", "asset", "WETH"],
      ["borrow", "allocationBps", 7000],
    ];
    for (const [type, key, value] of accepted) {
      expect(isAllowedParamValue(type, key, value), `${type}.${key}`).toBe(true);
    }
    expect(isAllowedParamValue("stake", "asset", "ETH")).toBe(false);
    expect(isAllowedParamValue("input", "allocationBps", 1)).toBe(false);
  });

  it("neither honours nor silently swallows a hostile __proto__ parameter key", () => {
    // Honest about the real zod v4 behaviour: `__proto__` is STRIPPED from a record's
    // output rather than reported, so there is no rejection code to assert. What is
    // assertable — and what actually matters — is that nothing is polluted and the key
    // reaches neither the decoded document nor its prototype chain.
    const raw =
      '{"v":1,"b":[{"i":"in","t":"input","p":{"__proto__":{"polluted":true},"asset":"ETH","amount":"10"}}],"e":[]}';
    const graph = graphOf(b64url(raw));
    const params = graph.blocks[0]!.params;
    expect(Object.keys(params)).toEqual(["asset", "amount"]);
    expect(Object.hasOwn(params, "__proto__")).toBe(false);
    expect("polluted" in params).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("catches the prototype key zod DOES keep — `constructor` — at the whitelist", () => {
    const raw =
      '{"v":1,"b":[{"i":"in","t":"input","p":{"constructor":"x","asset":"ETH","amount":"10"}}],"e":[]}';
    const failure = failureOf(b64url(raw));
    expect(failure.code).toBe("schema");
    if (failure.code !== "schema") return;
    expect(failure.issues.join(" ")).toContain("b.in.p.constructor");
  });
});

describe("share codec — structural gate is separate from the shape gate (§5.6)", () => {
  const malicious: ReadonlyArray<readonly [string, StrategyGraph, string]> = [
    [
      "cycle (the un-expanded loop)",
      {
        blocks: flagshipGraph().blocks,
        edges: [
          ...flagshipGraph().edges,
          { id: "back", source: "supply2", target: "in", allocationBps: 10_000 },
        ],
      },
      "graph is not acyclic",
    ],
    [
      "dangling edge target",
      {
        blocks: flagshipGraph().blocks,
        edges: [
          ...flagshipGraph().edges,
          { id: "x", source: "supply2", target: "ATTACKER", allocationBps: 10_000 },
        ],
      },
      "target ATTACKER is not a block",
    ],
    [
      "over-allocated source (sum > 10000)",
      {
        blocks: [
          ...flagshipGraph().blocks,
          { id: "supply3", type: "lend", params: { protocol: "aave-v3", asset: "weETH" } },
        ],
        edges: [
          ...flagshipGraph().edges,
          { id: "e:supply3", source: "wrap1", target: "supply3", allocationBps: 10_000 },
        ],
      },
      "over-allocates outgoing flow",
    ],
    [
      "duplicate block id",
      {
        blocks: [...flagshipGraph().blocks, { id: "in", type: "stake", params: { protocol: "lido" } }],
        edges: flagshipGraph().edges,
      },
      "duplicate block id: in",
    ],
    [
      "self-loop",
      {
        blocks: [{ id: "in", type: "input", params: { asset: "ETH", amount: "1" } }],
        edges: [{ id: "s", source: "in", target: "in", allocationBps: 100 }],
      },
      "self-loop",
    ],
    [
      "no input block",
      { blocks: [{ id: "a", type: "stake", params: { protocol: "etherfi" } }], edges: [] },
      "exactly one input",
    ],
    [
      "fan-in (two producers)",
      {
        blocks: flagshipGraph().blocks,
        edges: [
          ...flagshipGraph().edges,
          { id: "extra", source: "wrap1", target: "supply2", allocationBps: 10_000 },
        ],
      },
      "exactly one producer",
    ],
    [
      "unreachable island",
      {
        blocks: [
          ...flagshipGraph().blocks,
          { id: "orphan", type: "stake", params: { protocol: "lido" } },
        ],
        edges: flagshipGraph().edges,
      },
      "not reachable",
    ],
    ["collateral-only borrow asset", withParams("borrow", { protocol: "aave-v3", asset: "weETH", allocationBps: 7000 }), "collateral-only borrow asset"],
    ["unsupported lend asset", withParams("supply1", { protocol: "aave-v3", asset: "ETH" }), "unsupported lend asset"],
    // W09: USDC is BORROWABLE and not LENDABLE, and the asymmetry is enforced at the same
    // gate a stranger's link hits. Supplying it is out of scope; the transport must refuse it
    // rather than let an unproven collateral leg onto the canvas.
    ["a USDC lend leg", withParams("supply1", { protocol: "aave-v3", asset: "USDC" }), "unsupported lend asset"],
    ["unsupported wrap pair", withParams("wrap1", { from: "eETH", to: "wstETH" }), "unsupported wrap"],
    ["unsupported unwrap pair", withParams("unwrap", { from: "WETH", to: "weETH" }), "unsupported unwrap"],
    ["non-ETH input asset", withParams("in", { asset: "WETH", amount: "10" }), "input asset must be ETH"],
    ["zero input amount", withParams("in", { asset: "ETH", amount: "0" }), "positive amount"],
    [
      "absurd input amount",
      withParams("in", { asset: "ETH", amount: "99999999999999999999999" }),
      "positive amount",
    ],
  ];

  it.each(malicious)("rejects %s arriving by URL", (_name, graph, expectedError) => {
    // The in-process gate rejects it…
    expect(validateGraph(graph).ok).toBe(false);
    // …and so does the transport, at the structural gate, with core's own message.
    const failure = failureOf(tokenFor(payloadOf(graph)));
    expect(failure.code).toBe("graph-invalid");
    if (failure.code !== "graph-invalid") return;
    expect(failure.errors.some((e) => e.includes(expectedError))).toBe(true);
    // …and the encoder refuses to mint it in the first place, with the same code.
    const encoded = encodeShareGraph(graph);
    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.failure.code).toBe("graph-invalid");
  });

  it("never returns a partial graph on rejection", () => {
    const result = decodeShareGraph(tokenFor(payloadOf(withParams("in", { asset: "ETH", amount: "0" }))));
    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "graph")).toBe(false);
  });
});
