/**
 * LINT FIXTURE — every marked line below is SUPPOSED to fail `npm run check:lint-boundaries`.
 *
 * It stands in for a future `src/lib/execution/` module that quietly acquires a way to reach
 * the network or the React tree, which would end the module's purity contract without
 * changing a single docstring. Every prohibited route the boundary closes appears here
 * exactly once, on its own line, tagged `@route:<name>`:
 *
 *   - React (the module must stay renderer-free)
 *   - each viem client/transport constructor by name (its ABI utilities stay legitimate;
 *     anything that can OPEN a connection does not)
 *   - each banned subpath group (viem clients/actions/window/node, wagmi, next, server/chain)
 *   - every fetch form, including the member ones that walk past `no-restricted-globals`
 *   - the restated `no-restricted-syntax` bans, which flat config would otherwise drop when
 *     this file group overrides the rule
 *
 * `scripts/lint-boundaries.mjs` asserts the exact set of (route, ruleId) pairs, so removing a
 * SINGLE ban from the config fails the gate. Excluded from the normal lint run via the global
 * `ignores`, and from tsconfig (these imports are lint targets, not code that has to
 * resolve). Do not "fix" this file: deleting a violation deletes the evidence.
 */
import { useState } from "react"; // @route:react
import { flushSync } from "react-dom"; // @route:react-dom
import {
  createClient, // @route:viem-createClient
  createPublicClient, // @route:viem-createPublicClient
  createTestClient, // @route:viem-createTestClient
  createTransport, // @route:viem-createTransport
  createWalletClient, // @route:viem-createWalletClient
  custom, // @route:viem-custom
  fallback, // @route:viem-fallback
  http, // @route:viem-http
  ipc, // @route:viem-ipc
  webSocket, // @route:viem-webSocket
} from "viem";
import { createClient as viaClientsBare } from "viem/clients"; // @route:viem-clients-bare
import { createPublicClient as viaClients } from "viem/clients/createPublicClient"; // @route:viem-clients-subpath
import { getLogs } from "viem/actions"; // @route:viem-actions-bare
import { call } from "viem/actions/public/call"; // @route:viem-actions-subpath
import { window as viemWindow } from "viem/window"; // @route:viem-window-subpath
import { ipcTransport } from "viem/node"; // @route:viem-node-subpath
import { useAccount } from "wagmi"; // @route:wagmi
import { injected } from "wagmi/connectors"; // @route:wagmi-subpath
import { useRouter } from "next/navigation"; // @route:next-subpath
import { captureChainSnapshot } from "../../../../src/server/chain/snapshot"; // @route:server-chain-subpath

export const escapes = {
  useState,
  flushSync,
  createClient,
  createPublicClient,
  createTestClient,
  createTransport,
  createWalletClient,
  custom,
  fallback,
  http,
  ipc,
  webSocket,
  viaClientsBare,
  viaClients,
  call,
  getLogs,
  viemWindow,
  ipcTransport,
  useAccount,
  injected,
  useRouter,
  captureChainSnapshot,
};

export function bareFetchEscape(): Promise<Response> {
  return fetch("https://example.invalid/receipt"); // @route:fetch-bare
}

export function xhrEscape(): unknown {
  return new XMLHttpRequest(); // @route:xmlhttprequest
}

export function globalThisFetchEscape(): Promise<Response> {
  return globalThis.fetch("https://example.invalid/receipt"); // @route:fetch-globalthis
}

export function windowFetchEscape(): Promise<Response> {
  return window.fetch("https://example.invalid/receipt"); // @route:fetch-window
}

export function selfFetchEscape(): Promise<Response> {
  return self.fetch("https://example.invalid/receipt"); // @route:fetch-self
}

export const forgedObservation = {
  kind: "observed", // @route:forged-observed
  value: 1n,
};

export function numericFallbackEscape(rate: number | undefined): number {
  return rate ?? 0; // @route:numeric-fallback-literal
}

export function negativeNumericFallbackEscape(rate: number | undefined): number {
  return rate ?? -1; // @route:numeric-fallback-unary
}
