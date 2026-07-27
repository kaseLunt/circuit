/**
 * LINT FIXTURE — the marked line below is SUPPOSED to fail `npm run check:lint-boundaries`.
 *
 * The .tsx sibling of `leaks-public-env.ts` (Codex round-1 finding 7): a server file's
 * extension must not be a bypass — the src/server NEXT_PUBLIC_* ban covers .tsx too.
 * Excluded from the normal lint run via the global `ignores`, and from tsconfig. Do not
 * "fix" this file: deleting a violation deletes the evidence.
 */
export const tsxLeak = process.env.NEXT_PUBLIC_FORK_WS_URL; // @route:next-public-env-tsx
