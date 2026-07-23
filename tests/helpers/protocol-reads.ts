/**
 * Typed accessor over the committed protocol reads log
 * (docs/protocol-matrix-reads.json). Test fixtures draw every on-chain value
 * from here — never from memory — so unit expectations stay pinned to the same
 * block the fork suite executes against.
 */
import readsLog from "../../docs/protocol-matrix-reads.json";

interface ReadEntry {
  readonly label: string;
  readonly to?: string;
  readonly fn?: string;
  readonly result?: unknown;
}

const LOG = readsLog as unknown as {
  readonly meta: {
    readonly pinned_block: { readonly number: string; readonly hash: string; readonly timestamp: string };
    readonly anchors: Readonly<Record<string, string>>;
    readonly pool: string;
    readonly pool_data_provider: string;
    readonly oracle: string;
  };
  readonly reads: ReadonlyArray<ReadEntry>;
};

export const readsMeta = LOG.meta;
export const PINNED_BLOCK = BigInt(LOG.meta.pinned_block.number);
export const PINNED_TS = BigInt(LOG.meta.pinned_block.timestamp);

export function readResult(label: string): unknown {
  const hit = LOG.reads.find((r) => r.label === label);
  if (hit === undefined || hit.result === undefined) throw new Error(`missing read: ${label}`);
  return hit.result;
}

export function bigRead(label: string): bigint {
  const v = readResult(label);
  if (typeof v !== "string") throw new Error(`read ${label} is not a decimal string`);
  return BigInt(v);
}

export function tupleRead(label: string): readonly unknown[] {
  const v = readResult(label);
  if (!Array.isArray(v)) throw new Error(`read ${label} is not a tuple`);
  return v;
}

export function tupleBig(label: string, index: number): bigint {
  const v: unknown = tupleRead(label)[index];
  if (typeof v !== "string" && typeof v !== "number") {
    throw new Error(`read ${label}[${index}] is not numeric`);
  }
  return BigInt(v);
}

export function tupleBool(label: string, index: number): boolean {
  const v: unknown = tupleRead(label)[index];
  if (typeof v !== "boolean") throw new Error(`read ${label}[${index}] is not a boolean`);
  return v;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function addressOf(raw: unknown, what: string): `0x${string}` {
  if (typeof raw !== "string" || !ADDRESS_RE.test(raw)) {
    throw new Error(`${what} is not an address: ${String(raw)}`);
  }
  return raw as `0x${string}`;
}

export function addrRead(label: string): `0x${string}` {
  return addressOf(readResult(label), label);
}

export function anchorAddr(name: string): `0x${string}` {
  return addressOf(LOG.meta.anchors[name], `anchor ${name}`);
}
