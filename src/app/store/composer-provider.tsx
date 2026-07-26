"use client";

/**
 * The React binding for the vanilla composer store.
 *
 * `composer-store.ts` is framework-free on purpose and its header forbids a module-level
 * singleton (a singleton is per-process, not per-request, so one server process would
 * serve every visitor the same document). The store instance therefore hangs off a React
 * context created per provider, and every consumer — canvas, blocks, sidebar, panel —
 * reads the SAME instance through it.
 *
 * Two hooks, because they answer different questions. `useComposerStoreApi` returns the
 * store handle for imperative work (actions, one-shot `getState()` reads inside event
 * handlers) and never subscribes, so a component that only writes never re-renders.
 * `useComposerStore(selector)` subscribes; pair it with `useShallow` when the selector
 * mints an object, because zustand v5 compares selector output by reference.
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  createComposerStore,
  type ComposerStore,
  type ComposerStoreApi,
} from "./composer-store";

const ComposerStoreContext = createContext<ComposerStoreApi | null>(null);

interface ComposerStoreProviderProps {
  /**
   * An externally owned store. Tests and the app shell pass one so they can drive the
   * document without a component; omitting it gets a fresh store scoped to this provider.
   */
  store?: ComposerStoreApi;
  children: ReactNode;
}

export function ComposerStoreProvider({ store, children }: ComposerStoreProviderProps) {
  // Created unconditionally (one zustand object, no side effects) so the hook order is
  // stable whether or not a caller supplies a store.
  const [ownStore] = useState(createComposerStore);
  const api = store === undefined ? ownStore : store;
  return <ComposerStoreContext.Provider value={api}>{children}</ComposerStoreContext.Provider>;
}

export function useComposerStoreApi(): ComposerStoreApi {
  const api = useContext(ComposerStoreContext);
  if (api === null) {
    throw new Error("Composer store is missing: render this inside <ComposerStoreProvider>.");
  }
  return api;
}

export function useComposerStore<T>(selector: (state: ComposerStore) => T): T {
  return useStore(useComposerStoreApi(), selector);
}
