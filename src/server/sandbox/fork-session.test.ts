/**
 * The bounded-RPC guarantee, against a socket that ACCEPTS and never answers.
 *
 * `deadlines.ts` states the policy and `fork-session.ts` threads it onto the raw socket, and
 * the two together are only worth as much as the thread actually being attached. A helper that
 * called `fetch` without the signal would pass every existing test — nothing in the suite ever
 * hangs — and would then hold a session mutex, a port lease and a spawned child open forever
 * the first time an upstream stalled. That is the failure this file makes reachable: a real
 * HTTP server that completes the TCP handshake, reads the request, and then says nothing.
 *
 * `withDeadline` rejects at the deadline even if `run` ignores the signal, so the assertion
 * below is deliberately about the CLOCK rather than about the abort mechanism: the await must
 * settle inside its window. The signal is what tears the socket down afterwards; the bound is
 * what callers depend on.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeadlineExceededError } from "./deadlines";
import { rpcCall } from "./fork-session";
import { assertSharedUpstreamPristine } from "../../../tests/fork/harness";

/** Generous enough that a slow machine cannot trip it, small enough to keep the suite quick. */
const WINDOW_MS = 300;

let server: Server | null = null;
let aborted = false;
const sockets = new Set<{ destroy: () => void }>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  aborted = false;
  const running = server;
  server = null;
  if (running !== null) await new Promise<void>((resolve) => running.close(() => resolve()));
});

/** A server that accepts the request and never responds. */
async function hungServer(): Promise<string> {
  const created = createServer((req) => {
    // Deliberately no response: the request is read and then abandoned. The close listener is
    // what proves the caller tore the socket down at its deadline.
    req.on("close", () => {
      aborted = true;
    });
  });
  created.on("connection", (socket) => sockets.add(socket));
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
  const { port } = created.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("rpcCall — every fork RPC is bounded", () => {
  it("rejects inside its window when the upstream accepts and never answers", async () => {
    const url = await hungServer();
    const started = performance.now();
    await expect(rpcCall(url, "eth_blockNumber", [], WINDOW_MS)).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    const elapsed = performance.now() - started;
    // The bound is the claim: the await settled, and it settled at the deadline rather than
    // whenever the socket happened to give up.
    expect(elapsed).toBeLessThan(WINDOW_MS * 10);
    expect(elapsed).toBeGreaterThanOrEqual(WINDOW_MS - 50);
  });

  /**
   * The body parse is inside the bound too. A server that sends headers and then stalls
   * mid-body would hang `res.json()`, which is a different await from `fetch` and would need
   * its own bound if the two were not wrapped together.
   */
  it("bounds the body parse, not just the response headers", async () => {
    const created = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "64" });
      res.write('{"jsonrpc":"2.0","id":1,');
      // …and never finishes the body.
    });
    created.on("connection", (socket) => sockets.add(socket));
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
    const { port } = created.address() as AddressInfo;

    const started = performance.now();
    await expect(
      rpcCall(`http://127.0.0.1:${port}`, "eth_blockNumber", [], WINDOW_MS),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(performance.now() - started).toBeLessThan(WINDOW_MS * 10);
  });

  /**
   * …and the SIGNAL is genuinely threaded onto the socket, which the two tests above cannot
   * see: `withDeadline` rejects at the deadline whether or not `run` honours the signal, so
   * detaching it from `fetch` leaves them both green (verified by deliberately detaching it).
   * The caller-visible bound is what they pin; this pins the resource hygiene underneath it —
   * an abandoned socket per stalled probe is a leak a polling loop multiplies.
   */
  it("tears the socket down at the deadline, not merely the await", async () => {
    let closed = false;
    const created = createServer((req) => {
      req.on("close", () => {
        closed = true;
      });
    });
    created.on("connection", (socket) => sockets.add(socket));
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
    const { port } = created.address() as AddressInfo;

    await expect(
      rpcCall(`http://127.0.0.1:${port}`, "eth_blockNumber", [], WINDOW_MS),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    // One turn of the loop for the abort to reach the listener.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed, "the aborted request never reached the server as closed").toBe(true);
  });

  /**
   * …and the SUITE-SIDE wrapper inherits the bound (Codex W09 round-5 finding 2).
   *
   * `assertSharedUpstreamPristine` runs in before/after hooks against the one anvil whose
   * documented failure mode is accepting connections and going silent — the worst possible
   * place for an unbounded read, because a stalled hook holds the run open with no test to
   * blame. It used to carry its own raw `fetch`; it now routes through `rpcCall`, and this
   * drives the real exported wrapper at a stalled URL rather than re-testing the helper.
   */
  it("bounds the shared-upstream pristine probe, hooks and all", async () => {
    const url = await hungServer();
    const started = performance.now();
    await expect(assertSharedUpstreamPristine("in a stalled hook", url, WINDOW_MS)).rejects.toThrow(
      /is not answering within its bound/,
    );
    expect(performance.now() - started).toBeLessThan(WINDOW_MS * 10);
    // One turn of the loop for the abort to reach the listener: the socket is released too.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(aborted, "the pristine probe's stalled request was never torn down").toBe(true);
  });

  it("still returns a normal result when the upstream answers", async () => {
    const created = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }));
    });
    created.on("connection", (socket) => sockets.add(socket));
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", () => resolve()));
    const { port } = created.address() as AddressInfo;

    expect(await rpcCall(`http://127.0.0.1:${port}`, "eth_blockNumber", [], WINDOW_MS)).toBe("0x2a");
  });
});
