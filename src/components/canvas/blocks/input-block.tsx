"use client";

import { useId, useState, type ChangeEvent } from "react";
import { Wallet } from "lucide-react";
import type { InputBlockData } from "../../../lib/strategy/types";
import { AssetChip } from "../../shared/asset-chip";
import { SourcedValue, slotClassName, type SlotRamp } from "../../shared/sourced-value";
import { BaseBlock, useBlockRuntime, useWriteRejection, type BlockState } from "./base-block";
import { BlockValueZone } from "./block-value-badge";
import type { NodePropsFor } from "./node-props";

const TITLE = "Input Capital";

/** Widest plausible entered amount: "1,000,000.00" is twelve characters. */
const AMOUNT_SLOT_CHARS = 12;

/** Inside a sentence: the figure takes the sentence's own size and only its colour lifts. */
const AMOUNT_RAMP: SlotRamp = {
  resolved: "nodrag text-xs text-foreground",
  size: "nodrag text-xs",
};

/**
 * The forms of a decimal a user is part-way through typing: "." and "12.". The store's
 * whitelist refuses them and is right to — `lib/share/encode.ts`'s DECIMAL_AMOUNT admits
 * only a complete decimal — but a keystroke on the way to "1.5" is not an error, and
 * painting the full error frame for one keystroke is a flash, not a report.
 */
const INCOMPLETE_DECIMAL = /^\d*\.$/;

/**
 * An entered decimal string is the user's own text. There is nothing to format and
 * core/format.ts has no formatter for a string, so this decides nothing: no scale, no
 * suffix, no rounding.
 */
function asEntered(amount: string): string {
  return amount;
}

/**
 * The strategy's opening position.
 *
 * The amount is held as the RAW STRING the user typed. The predecessor ran it through
 * `parseFloat(value) || 0`, which turned an empty field, a stray letter and a paste of
 * "1e21" alike into the number zero and then simulated on it — the exact defect SPEC §5
 * names, wearing a coercion instead of a fallback. Here an unparseable amount is refused
 * by the store's whitelist, kept on screen as typed, and reported.
 *
 * Three drafts the store refuses are NOT errors, and each has its own designed state:
 * an empty field is unconfigured, an unfinished decimal is still being typed, and any
 * other refusal is reported in the store's own words. Whenever the draft and the
 * document disagree, the block says what the document still holds — a field showing one
 * number while the simulation runs on another is the dishonesty this block exists to
 * prevent.
 *
 * There is no asset selector: `core/graph.ts` admits exactly one input asset in v1, and a
 * select with a single option is a control that cannot be operated.
 */
export function InputBlock({ id, data, selected }: NodePropsFor<InputBlockData>) {
  const runtime = useBlockRuntime();
  const fieldId = useId();
  const rejection = useWriteRejection();

  const [draft, setDraft] = useState(data.amount);
  const [seenRev, setSeenRev] = useState(runtime.docRev);

  // Render-time state adjustment — the pattern sourced-value.tsx uses. An undo, a share
  // load or a template swap changes the document underneath this field, and the field
  // must follow without an effect round-trip that would flash the stale value first.
  // The trigger is the REVISION, not the amount: a document that moved back to the value
  // already on screen still retires the draft and the refusal that went with it.
  if (seenRev !== runtime.docRev) {
    setSeenRev(runtime.docRev);
    if (draft !== data.amount) setDraft(data.amount);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const raw = event.target.value;
    setDraft(raw);
    runtime.beginEdit("set input amount");
    const result = runtime.setBlockParam(id, "amount", raw);
    const trimmed = raw.trim();
    if (result.ok || trimmed.length === 0 || INCOMPLETE_DECIMAL.test(trimmed)) {
      rejection.clear();
      return;
    }
    rejection.record(result);
  }

  function handleBlur(): void {
    runtime.endEdit();
    // An unfinished decimal is not a value. Once the user stops typing, the field returns
    // to what the document holds rather than resting on a token the store never accepted.
    if (INCOMPLETE_DECIMAL.test(draft.trim())) setDraft(data.amount);
  }

  const isEmpty = draft.trim().length === 0;
  const state: BlockState =
    rejection.reason !== null || !data.isValid ? "error" : isEmpty ? "warning" : "valid";
  const message =
    rejection.reason !== null
      ? rejection.reason
      : !data.isValid
        ? data.errorMessage
        : isEmpty
          ? "Enter the amount of ETH this strategy starts with."
          : undefined;

  const uncommitted = draft !== data.amount;
  const committed = runtime.inputAmounts[id] ?? null;

  return (
    <BaseBlock
      id={id}
      kind="input"
      title={TITLE}
      icon={<Wallet />}
      state={state}
      selected={selected}
      message={message}
      hasInput={false}
      headerRight={<AssetChip symbol={data.asset} />}
      valueSlot={
        <BlockValueZone
          subject={TITLE}
          value={runtime.blockValues[id] ?? null}
          pending={runtime.pending}
          showInput={false}
          showGas={false}
        />
      }
    >
      <div className="space-y-1">
        <label htmlFor={fieldId} className="block text-xs text-muted-foreground">
          Amount
        </label>
        <div className="relative">
          <input
            id={fieldId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={handleChange}
            onBlur={handleBlur}
            aria-invalid={state === "error"}
            className="focus-ring transition-fast nodrag h-8 w-full rounded-sm border border-border bg-input pl-2 pr-12 text-sm tabular-nums text-foreground"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
          >
            {data.asset}
          </span>
        </div>
      </div>

      {uncommitted ? (
        <p className="text-xs text-muted-foreground">
          Not saved yet. The strategy still starts with{" "}
          <SourcedValue
            value={committed}
            pending={false}
            label="Input amount"
            chars={AMOUNT_SLOT_CHARS}
            format={asEntered}
            unavailableReason="no amount"
            inline
            className={slotClassName(committed !== null, false, AMOUNT_RAMP)}
          />{" "}
          {data.asset}.
        </p>
      ) : null}
    </BaseBlock>
  );
}
