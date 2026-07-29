/**
 * The plan fingerprint (§2.4), extracted VERBATIM from `src/server/sandbox/
 * execute-step.ts` so the CLIENT can compute it too (Codex hard-gate finding, thread
 * 019fa730): the session pointer persists the local plan's money-bearing fingerprint at
 * arm time, and restoration refuses to adopt a session under a document whose recomputed
 * fingerprint differs — same step IDs with different amounts is a DIFFERENT plan.
 *
 * One definition, two consumers: the server re-exports this function unchanged
 * (`execute-step.ts`), so the reconciliation hash and the pointer fingerprint can never
 * drift apart — the parallel-derivation defect §10.10 exists to kill.
 *
 * Pure by construction: viem's keccak is byte math (the same reasoning that admits
 * `getAddress` here); the purity fence bans clients and transports, not hashing.
 */
import { keccak256, stringToBytes, type Hex } from "viem";
import type { AmountSpec, CallArg, TransactionStep } from "../../core/plan";

/** ASCII unit/record separators: cannot occur in ids, symbols, or decimal figures. */
const HASH_FIELD = "\u001f";
const HASH_ROW = "\u001e";

function serializeArg(arg: CallArg): string {
  if (arg.kind === "amount") return "amount";
  return `value:${typeof arg.value}:${String(arg.value)}`;
}

function serializeAmountSpec(spec: AmountSpec): string {
  switch (spec.kind) {
    case "literal":
      return `literal:${spec.amount.value.toString()}`;
    case "derived":
      return `derived:${spec.amount.value.toString()}`;
    case "step-output":
      return `step-output:${spec.producerStepId}:${spec.attribution}:${spec.allocationBps}`;
    case "none":
      return "none";
  }
}

/**
 * keccak over an EXPLICIT field walk of the ordered steps (§2.4) — to, functionName,
 * args, valueSpec, amount spec — not `JSON.stringify` of the step objects, whose key
 * order is an accident of construction. The server computes this from its OWN rebuild;
 * the client presents it on every step call; mismatch is the designed "plan changed"
 * state. Step SAMENESS inside a plan stays reference identity (D4) — this hash names a
 * frozen plan for reconciliation, it never decides which step is which.
 */
export function planHashOf(steps: readonly TransactionStep[]): Hex {
  const rows = steps.map((step) =>
    [
      step.id,
      String(step.index),
      step.blockId,
      step.to,
      step.functionName,
      step.valueSpec,
      step.args.map(serializeArg).join(","),
      serializeAmountSpec(step.amount),
    ].join(HASH_FIELD),
  );
  return keccak256(stringToBytes(rows.join(HASH_ROW)));
}
