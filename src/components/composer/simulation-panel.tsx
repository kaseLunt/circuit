"use client";

/**
 * Live simulation panel (treatment §4). Display only: it receives a `SimulationResult`
 * and renders it. Nothing here computes, fetches, defaults or formats — a missing
 * quantity arrives as `null` and lands in a designed state, and every digit is shaped by
 * `core/format.ts`.
 *
 * Reading order is yield-then-risk, but the two share ONE type ramp: the health factor
 * never ranks below the APY typographically. `riskState` decides the health factor's
 * colour and `ok` is `text-foreground` — safety is the baseline, not an achievement, and
 * spending green on it would leave nothing louder for the warning.
 *
 * The health-factor hero goes through `SourcedValue` like every other quantity here:
 * `core/risk.ts` mints its `Provenanced` wrapper at the derivation site, so the hero can
 * cite the oracle reads behind the number without this component minting anything. Only the
 * union's non-numeric branches stay authored prose — `SourcedValue`'s unavailable branch
 * prints at `text-xs`, and "we cannot tell you your health factor" must not rank below the
 * APY directly above it.
 *
 * No `.value-up` / `.value-down` anywhere: the flash is for a discrete external change of
 * an already-shown value, and this panel cannot tell one from a drag frame — only the
 * store's `pendingEdit` can. Digits therefore change instantly, which is also the
 * drag-time contract.
 */
import { useId, useState, type ReactNode } from "react";
import {
  formatBpsAsPercent,
  formatEth,
  formatHealthFactor,
  formatUsdBase,
  formatWadAsMultiple,
  formatWadAsPercent,
  formatWadRatio,
} from "../../core/format";
import { HF_WARN_WAD, hfWadValue, riskState, type HealthFactor } from "../../core/health-factor";
import { valueOf } from "../../core/provenance";
import type { SimulationResult } from "../../lib/strategy/types";
import { InlineError } from "../shared/error-boundary";
import { SourcedValue, slotClassName, type SlotRamp } from "../shared/sourced-value";
import { SkeletonValue } from "../ui/skeleton";

const HERO_RAMP: SlotRamp = {
  resolved: "text-2xl font-semibold text-foreground",
  size: "text-2xl",
};
/**
 * The hero ramp in its warning state. A separate ramp rather than an appended class because
 * `slotClassName` hands the resolved string over only where a figure renders — a warning
 * colour bolted on outside that guard would paint the unavailable prose too.
 */
const HERO_WARNING_RAMP: SlotRamp = {
  resolved: "text-2xl font-semibold text-warning",
  size: "text-2xl",
};
const ROW_RAMP: SlotRamp = { resolved: "text-sm", size: "text-sm" };
const CONTEXT_RAMP: SlotRamp = {
  resolved: "text-xs text-muted-foreground",
  size: "text-xs",
};

export interface SimulationPanelProps {
  /**
   * The parent computes this and hands it down. `null` means there is no result: paired
   * with `pending` it is a load in flight, and on its own it is an empty composer.
   *
   * Stale-while-revalidate, per the `SourcedValue` consumer contract: a refresh over an
   * already-shown result keeps the previous result in place with `pending={false}`.
   * A null round-trip on every poll would re-skeleton the whole panel.
   */
  result: SimulationResult | null;
  pending: boolean;
}

interface RowProps {
  readonly label: string;
  readonly children: ReactNode;
}

function Row({ label, children }: RowProps) {
  return (
    <div className="flex h-9 items-center justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm tabular-nums text-foreground">{children}</span>
    </div>
  );
}

/** "12.34" — five characters, the widest form `formatHealthFactor` produces for a live HF. */
const HF_SLOT_CHARS = 5;

/**
 * A composition, not a formatter: `formatHealthFactor` owns every digit, the sentinel and
 * the rounding, and `hfWadValue` owns the unwrapping. It is restated here rather than shared
 * with the borrow block because core/format.ts cannot import core/health-factor.ts — the
 * dependency runs one way — so there is no module either component could take it from.
 */
function formatMinHealthFactor(hf: HealthFactor): string {
  return formatHealthFactor(hfWadValue(hf));
}

/** Prose for a health factor outside the healthy branch — never a dash, never "∞". */
function healthFactorText(hf: HealthFactor): string {
  if (hf.status === "healthy") return formatHealthFactor(hf.hfWad);
  if (hf.status === "no-debt") return "no borrow";
  return "unavailable";
}

/**
 * What the single live region says. Empty while pending or absent, so mounting a panel
 * with nothing in it announces nothing; a settled state announces once, and the §3
 * step-3 warning crossing announces exactly one line.
 */
function announcementFor(result: SimulationResult | null, pending: boolean): string {
  if (result === null || pending) return "";
  const hf = valueOf(result.minHealthFactor);
  if (hf.status === "unknown") return "Health factor unavailable — the data source failed.";
  if (hf.status === "no-debt") return "No borrow — no liquidation risk.";
  const value = formatHealthFactor(hf.hfWad);
  if (riskState(hf) === "warning") {
    return `Minimum health factor ${value} — below the ${formatHealthFactor(HF_WARN_WAD)} warning threshold.`;
  }
  return `Minimum health factor ${value}.`;
}

/** Message plus the count of messages before it — see the sidebar's identical contract. */
interface Announcement {
  readonly text: string;
  readonly nonce: number;
}

export function SimulationPanel({ result, pending }: SimulationPanelProps) {
  const baseId = useId();
  const [announced, setAnnounced] = useState<Announcement>({ text: "", nonce: 0 });

  // Render-time state adjustment (the same pattern SourcedValue uses): a synchronous
  // setState in an effect body trips the compiler's cascading-render lint, and the guard
  // below is what makes this converge in one extra render. Falling back to "" is what
  // clears the region when the panel empties — a live region holding the last settled
  // sentence would re-announce it against an empty panel.
  const message = announcementFor(result, pending);
  if (message !== announced.text) {
    setAnnounced((previous) => ({ text: message, nonce: previous.nonce + 1 }));
  }

  const settledEmpty = result === null && !pending;
  // The wrapper feeds the hero's `SourcedValue`; the unwrapped union decides which of the
  // three branches renders. Both come from one field, so they cannot disagree.
  const hf = result === null ? null : result.minHealthFactor;
  const hfValue = hf === null ? null : valueOf(hf);
  const risk = hfValue === null ? null : riskState(hfValue);
  const invalidMessage =
    result !== null && !result.isValid
      ? result.errorMessage === undefined
        ? "This strategy did not simulate."
        : result.errorMessage
      : null;

  const netApyWad = result === null ? null : result.netApyWad;
  const grossApyWad = result === null ? null : result.grossApyWad;
  const leverageWad = result === null ? null : result.leverageWad;
  const initialAmountWei = result === null ? null : result.initialAmountWei;
  const gasCostBase = result === null ? null : result.gasCostBase;
  const liquidationRatioWad = result === null ? null : result.liquidationRatioWad;

  const netApyId = `${baseId}-net-apy`;
  const riskId = `${baseId}-risk`;

  return (
    <aside
      aria-label="Simulation"
      className="flex h-full w-80 shrink-0 flex-col overflow-y-auto border-l border-border bg-card p-4"
    >
      <p role="status" className="sr-only">
        <span key={announced.nonce}>{announced.text}</span>
      </p>

      {invalidMessage === null ? null : (
        <div className="mb-4">
          <InlineError error={invalidMessage} />
        </div>
      )}

      {settledEmpty ? (
        <section aria-labelledby={`${baseId}-empty`}>
          <p
            id={`${baseId}-empty`}
            className="text-label uppercase tracking-wider text-muted-foreground"
          >
            Simulation
          </p>
          <p className="mt-1 text-sm text-foreground">No simulation yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Build a strategy on the canvas. Net APY and health factor appear once every rate
            they need has been read.
          </p>
        </section>
      ) : (
        <>
          <section aria-labelledby={netApyId} className="pb-4">
            <p
              id={netApyId}
              className="text-label uppercase tracking-wider text-muted-foreground"
            >
              Net APY · current-rate run-rate, one iteration
            </p>
            <div className="mt-1">
              <SourcedValue
                value={netApyWad}
                pending={pending}
                label="Net APY"
                chars={8}
                format={formatWadAsPercent}
                unavailableReason="net APY unavailable — a rate did not resolve"
                className={slotClassName(netApyWad !== null, pending, HERO_RAMP)}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Incentives and rewards excluded.
            </p>
          </section>

          <section aria-labelledby={riskId} className="border-t border-border py-4">
            <p
              id={riskId}
              className="flex items-center gap-2 text-label uppercase tracking-wider text-muted-foreground"
            >
              Min health factor · during execution
              {risk === "warning" ? (
                <span aria-hidden="true" className="status-dot status-dot-warning transition-fast" />
              ) : null}
            </p>

            {/* The figure goes through SourcedValue, so the hero cites the oracle reads
                behind it. The other two branches deliberately do NOT: SourcedValue's
                unavailable branch prints its reason at text-xs, and this slot holds the hero
                ramp in every state. */}
            {hf === null || hfValue === null ? (
              <div className="mt-1 text-2xl font-semibold">
                <SkeletonValue label="Minimum health factor" chars={5} />
              </div>
            ) : hfValue.status === "healthy" ? (
              <div className="mt-1">
                <SourcedValue
                  value={hf}
                  pending={pending}
                  label="Minimum health factor during execution"
                  chars={HF_SLOT_CHARS}
                  format={formatMinHealthFactor}
                  unavailableReason="health factor unavailable"
                  className={slotClassName(
                    true,
                    pending,
                    risk === "warning" ? HERO_WARNING_RAMP : HERO_RAMP,
                  )}
                />
              </div>
            ) : hfValue.status === "no-debt" ? (
              // The hero slot keeps the hero ramp in every state. Risk may follow yield in
              // reading order; it never ranks below it typographically — and "we cannot
              // tell you your health factor" is the loudest thing this panel can say. The
              // phrase is short enough to hold the ramp; the explanation takes the same
              // text-xs context line the healthy branch uses.
              <>
                <p className="mt-1 text-2xl font-semibold text-muted-foreground">No borrow</p>
                <p className="mt-1 text-xs text-muted-foreground">No liquidation risk.</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-2xl font-semibold text-muted-foreground">Unavailable</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Data source failed — {hfValue.reason}.
                </p>
              </>
            )}

            {hfValue !== null && hfValue.status === "healthy" ? (
              <p className="mt-1 flex flex-wrap items-baseline gap-1 text-xs text-muted-foreground">
                <span>Liquidates when the collateral/debt oracle ratio reaches</span>
                <SourcedValue
                  value={liquidationRatioWad}
                  pending={pending}
                  label="Liquidation ratio"
                  chars={7}
                  format={formatWadRatio}
                  unavailableReason="ratio unavailable"
                  className={slotClassName(liquidationRatioWad !== null, pending, CONTEXT_RAMP)}
                />
              </p>
            ) : null}

            {result === null ? null : (
              <Row label="Health factor after execution">
                {/* Same rule as the hero: the FIGURE is provenanced, so it renders through
                    SourcedValue and can be traced back to its reads. The other two branches
                    are authored prose, because SourcedValue's unavailable branch would print
                    a reason where this row states a fact about the position. */}
                {valueOf(result.finalHealthFactor).status === "healthy" ? (
                  <SourcedValue
                    value={result.finalHealthFactor}
                    pending={pending}
                    label="Health factor after execution"
                    chars={HF_SLOT_CHARS}
                    format={formatMinHealthFactor}
                    unavailableReason="unavailable"
                    className={slotClassName(true, pending, ROW_RAMP)}
                  />
                ) : (
                  <span className="text-muted-foreground">
                    {healthFactorText(valueOf(result.finalHealthFactor))}
                  </span>
                )}
              </Row>
            )}
          </section>

          <section aria-labelledby={`${baseId}-position`} className="border-t border-border py-4">
            <p
              id={`${baseId}-position`}
              className="text-label uppercase tracking-wider text-muted-foreground"
            >
              Position
            </p>
            <Row label="Gross APY">
              <SourcedValue
                value={grossApyWad}
                pending={pending}
                label="Gross APY"
                chars={8}
                format={formatWadAsPercent}
                unavailableReason="unavailable"
                className={slotClassName(grossApyWad !== null, pending, ROW_RAMP)}
              />
            </Row>
            <Row label="Leverage">
              <SourcedValue
                value={leverageWad}
                pending={pending}
                label="Leverage"
                chars={6}
                format={formatWadAsMultiple}
                unavailableReason="unavailable"
                className={slotClassName(leverageWad !== null, pending, ROW_RAMP)}
              />
            </Row>
            <Row label="Equity in">
              <SourcedValue
                value={initialAmountWei}
                pending={pending}
                label="Equity in"
                chars={11}
                format={formatEth}
                unavailableReason="unavailable"
                className={slotClassName(initialAmountWei !== null, pending, ROW_RAMP)}
              />
            </Row>
            <Row label="Gas cost">
              <SourcedValue
                value={gasCostBase}
                pending={pending}
                label="Gas cost"
                chars={10}
                format={formatUsdBase}
                unavailableReason="not quoted"
                className={slotClassName(gasCostBase !== null, pending, ROW_RAMP)}
              />
            </Row>
            {/* The WHY for every "not quoted" gas slot, stated once at the owning
                container (per-slot copy names WHAT is missing). Self-retires when
                a provider can quote (P3a). */}
            {gasCostBase === null && !pending ? (
              <p className="text-xs text-muted-foreground">
                Gas is not quoted in sandbox — quoting needs a provider.
              </p>
            ) : null}
          </section>

          {result === null ? null : (
            <section aria-labelledby={`${baseId}-sources`} className="border-t border-border py-4">
              <p
                id={`${baseId}-sources`}
                className="text-label uppercase tracking-wider text-muted-foreground"
              >
                Yield sources
              </p>
              {/* Complete or empty, never partial: core leaves this list empty when any
                  leg's rate is missing, so a short list can never read as the whole
                  composition. */}
              {result.yieldSources.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Breakdown unavailable — not every leg&apos;s rate resolved.
                </p>
              ) : (
                result.yieldSources.map((source) => (
                  <div
                    key={`${source.protocol}-${source.type}`}
                    className="flex h-9 items-center justify-between gap-3"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-xs text-foreground">{source.protocol}</span>
                      <span className="shrink-0 text-micro uppercase tracking-wider text-muted-foreground">
                        {source.type}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="text-xs tabular-nums text-muted-foreground">
                        <span className="sr-only">weight </span>
                        {/* The debt leg's weight is negative by construction (§5.2), and
                            core preserves the sign rather than showing a magnitude. */}
                        {formatBpsAsPercent(source.weightBps, 2)}
                      </span>
                      <SourcedValue
                        value={source.apyWad}
                        pending={pending}
                        label={`${source.protocol} ${source.type} APY`}
                        chars={8}
                        format={formatWadAsPercent}
                        unavailableReason="unavailable"
                        className={slotClassName(source.apyWad !== null, pending, ROW_RAMP)}
                      />
                    </span>
                  </div>
                ))
              )}
            </section>
          )}
        </>
      )}
    </aside>
  );
}
