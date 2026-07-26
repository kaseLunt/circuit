/**
 * Typed accessor over the committed protocol reads log — now a re-export.
 *
 * The accessor moved to `src/lib/recorded-reads/reads-log.ts` in W05 P2 because the running
 * sandbox needs it and `src/**` must not import from `tests/**`. This file stays as the
 * import path every suite already spells, so the move changed no test.
 */
export {
  PINNED_BLOCK,
  PINNED_TS,
  WINDOW_BLOCK,
  WINDOW_ELAPSED_SECONDS,
  WINDOW_RATE_LABEL,
  WINDOW_TS,
  addrRead,
  addressOf,
  anchorAddr,
  bigRead,
  readResult,
  readsMeta,
  tupleBig,
  tupleBool,
  tupleRead,
} from "../../src/lib/recorded-reads/reads-log";
