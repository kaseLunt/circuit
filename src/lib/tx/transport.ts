/**
 * The driver's transport seam: the wire contract as an interface, and the one place the
 * tRPC client is composed.
 *
 * `src/lib/tx` is the IMPURE side of the execution split. The machine and its adapters
 * (`src/lib/execution`) are pure and lint-fenced; this module is where their events come
 * from — network calls whose responses are handed straight to the strict wire parsers
 * `resume.ts` exports. Nothing here interprets money: a response crosses this seam
 * verbatim, and every judgement about it (identity, tolerance, sequencing) is the
 * machine's.
 *
 * The router import is TYPE-ONLY: `import type` is erased at compile time, so no server
 * module reaches the client bundle — the type is exactly the wire contract the mounted
 * route serves, which is what makes the client's calls typecheck against the server's
 * actual procedures instead of a hand-maintained mirror. The RESPONSE shapes, by
 * contrast, are the `Wire*` mirrors from `resume.ts`: the strict parsers behind them are
 * the runtime gate version skew lands on (`malformed-wire`, never a guess).
 */
import { createTRPCClient, httpLink } from "@trpc/client";
import type { SandboxRouter } from "../../server/trpc/sandbox-router";
import type { WireRefusal, WireSessionResponse, WireStepResult } from "../execution/resume";

/** `sandbox.create`'s success payload — the session facts the chrome states (T29). */
export interface WireCreatedSession {
  readonly sessionKey: string;
  readonly baseBlock: string;
  readonly baseBlockHash: string;
  readonly actor: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/** The slice of `planView` the driver verifies against its own frozen plan (D4: by id). */
export interface WirePlanStep {
  readonly id: string;
  readonly index: number;
}

export interface WirePlanView {
  readonly planHash: string;
  readonly stepCount: number;
  readonly steps: readonly WirePlanStep[];
}

/**
 * Two refusal kinds exist only at the plan stage and are deliberately NOT in
 * `resume.ts`'s mirror (a session summary can never carry them): the SPEC §5.6 decode
 * gate refusing the document, and `buildPlan` refusing the graph. The transport types
 * carry them so the driver can hand each a designed state instead of `malformed-wire`.
 */
export type WireTransportRefusal =
  | WireRefusal
  | { readonly kind: "document-refused"; readonly failure: unknown }
  | { readonly kind: "plan-refused"; readonly errors: readonly unknown[] };

export type WireCreateResponse =
  | { readonly ok: true; readonly session: WireCreatedSession }
  | { readonly ok: false; readonly refusal: WireTransportRefusal };

export type WirePlanResponse =
  | { readonly ok: true; readonly plan: WirePlanView }
  | { readonly ok: false; readonly refusal: WireTransportRefusal };

export type WireExecuteResponse =
  | { readonly ok: true; readonly result: WireStepResult }
  | { readonly ok: false; readonly refusal: WireTransportRefusal };

export type WireTransportSessionResponse =
  | Extract<WireSessionResponse, { readonly ok: true }>
  | { readonly ok: false; readonly refusal: WireTransportRefusal };

/** Narrow a transport response to the resume mirror; plan-stage kinds refuse narrowing. */
export function asSessionResponse(
  response: WireTransportSessionResponse,
): WireSessionResponse | null {
  if (response.ok) return response;
  const refusal = response.refusal;
  if (refusal.kind === "document-refused" || refusal.kind === "plan-refused") return null;
  return { ok: false, refusal };
}

/**
 * Every sandbox verb the driver uses. An interface rather than the client itself so the
 * driver's tests inject a scripted transport and the driver's logic is proven without a
 * socket (the injected-reads pattern the attribution module fixed).
 */
export interface SandboxTransport {
  create(): Promise<WireCreateResponse>;
  plan(sessionKey: string, document: string): Promise<WirePlanResponse>;
  executeStep(sessionKey: string, planHash: string, stepIndex: number): Promise<WireExecuteResponse>;
  session(sessionKey: string): Promise<WireTransportSessionResponse>;
  reconcile(sessionKey: string): Promise<WireExecuteResponse>;
  reset(sessionKey: string): Promise<WireTransportSessionResponse>;
  destroy(sessionKey: string): Promise<void>;
}

export const TRPC_ENDPOINT = "/api/trpc";

/** The production transport: the mounted route, called with the bearer session key. */
export function trpcSandboxTransport(url: string = TRPC_ENDPOINT): SandboxTransport {
  const client = createTRPCClient<SandboxRouter>({ links: [httpLink({ url })] });
  return {
    create: () => client.create.mutate(),
    plan: (sessionKey, document) => client.plan.mutate({ sessionKey, document }),
    executeStep: (sessionKey, planHash, stepIndex) =>
      client.executeStep.mutate({ sessionKey, planHash, stepIndex }),
    session: (sessionKey) => client.session.query({ sessionKey }),
    reconcile: (sessionKey) => client.reconcile.mutate({ sessionKey }),
    reset: (sessionKey) => client.reset.mutate({ sessionKey }),
    destroy: async (sessionKey) => {
      await client.destroy.mutate({ sessionKey });
    },
  };
}
