import Link from "next/link";
import { Button } from "../components/ui/button";
import { PINNED_BLOCK } from "../lib/recorded-reads/reads-log";

/**
 * The landing beat. A server component with no client JavaScript: one claim, one action,
 * and the qualification that makes the claim checkable.
 *
 * Composition does the work — no entrance animation, no ambient background, no gradient
 * headline (treatment §3). The single `primary` button is the ONE terminal action on the
 * screen, which is the whole reason the variant exists; everything else is type on the
 * neutral ramp. The block number is read from the committed reads log rather than typed,
 * so this page cannot claim a block the composer is not actually pinned to.
 *
 * THE PROVENANCE SENTENCE IS LOAD-BEARING — treat its wording as code. It once read "every
 * quantity on screen cites where it came from — method, block, and the time it was read",
 * which is false of the two origins that are not chain reads: a template's default cites a
 * named constant, and a value the user typed cites the user. A product whose thesis is that
 * it does not overstate what it knows cannot overstate it in its own headline. The
 * replacement is stronger rather than hedged: it claims universal attribution — nothing is
 * unattributed — and then names the exact form each of the four origins takes, all four of
 * which are verifiable by opening a tooltip in the composer.
 *
 * "BLOCK TIME", never "read time" or "fetched at". `Observed.fetchedAt` is the SOURCE
 * BLOCK'S timestamp — `core/provenance.ts` says "not the poll time" — so calling it a read
 * time would claim we know when the RPC answered, which we do not record and which would
 * differ between a live capture and a replay of the same block. The distinction is the
 * whole reason a citation stays true when the same block is read again tomorrow.
 */
export default function Home() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-xl">
        <p className="text-label uppercase tracking-wider text-muted-foreground">Circuit</p>

        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
          A DeFi strategy composer where every number can be defended.
        </h1>

        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Assemble a leveraged restaking loop from typed blocks and watch the health factor
          move as you size the borrow. Rates, prices and thresholds are read from the chain;
          APYs and risk are derived from them by tested math. Nothing on screen is
          unattributed: a chain read cites its method, block and block time; a derived figure
          opens into its equation and every input beneath it; a default names the constant
          and where it is defined; a number you entered says so.
        </p>

        <div className="mt-8">
          <Button asChild variant="primary" size="lg">
            <Link href="/composer">Try sandbox</Link>
          </Button>
        </div>

        <p className="mt-6 text-xs tabular-nums text-muted-foreground">
          No wallet, no signatures. The sandbox runs on a recorded Aave v3 Core read set
          pinned to Ethereum block {`${PINNED_BLOCK}`}.
        </p>
      </div>
    </main>
  );
}
