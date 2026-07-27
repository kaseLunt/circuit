import { describe, expect, it } from "vitest";
import { createPortLeaseRegistry } from "./port-lease";

describe("port lease registry", () => {
  it("hands out distinct ports from the configured range", () => {
    const registry = createPortLeaseRegistry(9000, 3);
    const a = registry.acquire();
    const b = registry.acquire();
    const c = registry.acquire();
    expect([a.port, b.port, c.port]).toEqual([9000, 9001, 9002]);
    expect(registry.leasedCount()).toBe(3);
  });

  it("throws on exhaustion — configuration error, not a queue", () => {
    const registry = createPortLeaseRegistry(9000, 1);
    registry.acquire();
    expect(() => registry.acquire()).toThrow(/no free sandbox fork port/);
  });

  it("never reuses a port while its lease is held (the destroy/create race, finding 3)", () => {
    const registry = createPortLeaseRegistry(9000, 2);
    // A destroy in progress = lease still held (exit not yet observed): a concurrent
    // create must be handed a DIFFERENT port, not the dying anvil's socket.
    const dying = registry.acquire();
    const concurrent = registry.acquire();
    expect(concurrent.port).not.toBe(dying.port);
    expect(registry.isLeased(dying.port)).toBe(true);

    // Only once the exit is observed does the port return to the pool.
    dying.release();
    expect(registry.isLeased(dying.port)).toBe(false);
    const next = registry.acquire();
    expect(next.port).toBe(dying.port);
  });

  it("release is idempotent — a double release cannot free someone else's lease", () => {
    const registry = createPortLeaseRegistry(9000, 2);
    const first = registry.acquire();
    first.release();
    const second = registry.acquire();
    expect(second.port).toBe(first.port);
    // A late second release of the ORIGINAL lease must not unlease the new holder.
    first.release();
    expect(registry.isLeased(second.port)).toBe(true);
  });

  it("refuses malformed ranges", () => {
    expect(() => createPortLeaseRegistry(0, 4)).toThrow(/bad base port/);
    expect(() => createPortLeaseRegistry(9000, 0)).toThrow(/bad port count/);
  });

  it("accepts the exact TCP ceiling and refuses any range past it (finding 3)", () => {
    const edge = createPortLeaseRegistry(65_535, 1);
    expect(edge.acquire().port).toBe(65_535);
    expect(createPortLeaseRegistry(65_000, 536).acquire().port).toBe(65_000);
    expect(() => createPortLeaseRegistry(65_535, 2)).toThrow(/TCP port ceiling/);
    expect(() => createPortLeaseRegistry(65_000, 537)).toThrow(/TCP port ceiling/);
  });

  it("refuses unsafe integers that would stall the allocation scan", () => {
    expect(() => createPortLeaseRegistry(2 ** 53, 4)).toThrow(/bad base port/);
    expect(() => createPortLeaseRegistry(9000, 2 ** 53)).toThrow(/bad port count/);
    expect(() => createPortLeaseRegistry(9000.5, 4)).toThrow(/bad base port/);
  });
});
