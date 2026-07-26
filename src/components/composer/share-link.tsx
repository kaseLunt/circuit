"use client";

/**
 * SPEC §3 step 8's opening half: turn the document on screen into a link.
 *
 * It reads the store IMPERATIVELY (`useComposerStoreApi`, never a subscription) because it
 * renders nothing derived from the document. A subscription here would re-render the chrome
 * band on every frame of the §3 step-3 borrow drag to display a button whose label never
 * changes.
 *
 * The control is never `disabled`. A document the transport cannot carry is a fact worth
 * SAYING — `encodeShareGraph` refuses with a code, and `describeComposeFailure` turns it into
 * a sentence plus the validator's own bounded words — and a greyed-out button with no
 * explanation is the one outcome that teaches the user nothing.
 *
 * TWO OUTCOMES, TWO LIFETIMES, and the split is the point:
 *   - Success and a blocked clipboard are TRANSIENTS. Both are one line with nothing to study
 *     ("Link copied."; the link is in the address bar), so they live in this control's own
 *     `role="status"` mouth and retire on the clock.
 *   - A REFUSAL is not. It carries zod paths, validator errors, a measured length against the
 *     limit — the material that names which block to fix — and it is escalated to the host,
 *     which mounts it in the same band an arrival refusal uses. Routing it through a
 *     four-second transient discarded every detail and left the AUTHOR knowing less about the
 *     refusal than the RECIPIENT of a bad link would.
 *
 * The transient is one `role="status"` element that is BOTH the visible confirmation and the
 * announcement, in the nonce'd grammar the sidebar and the simulation panel already use — a
 * second element for the screen-reader copy is a second authority for one sentence, and they
 * drift. No toast, either way.
 */

import { useEffect, useState } from "react";
import { Info, Link2 } from "lucide-react";
import { useComposerStoreApi } from "../../app/store/composer-provider";
import {
  buildShareUrl,
  describeComposeFailure,
  type ShareRefusal,
} from "../../lib/share/share-url";
import { NOTICE_DURATION_MS } from "../shared/notice";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";

/** The one sentence for a clipboard the browser would not write to. */
const CLIPBOARD_REFUSED = "Couldn't copy the link — it's in the address bar.";

interface Notice {
  readonly text: string;
  /** A blocked clipboard takes the Info glyph; a confirmation is text alone. */
  readonly refused: boolean;
  /** Remounts the span so an identical repeat reaches assistive technology again. */
  readonly nonce: number;
}

interface ShareLinkProps {
  /** Hands a compose refusal to whoever owns the refusal band. Never called on success. */
  readonly onRefused: (refusal: ShareRefusal) => void;
}

export function ShareLink({ onRefused }: ShareLinkProps) {
  const api = useComposerStoreApi();
  const [notice, setNotice] = useState<Notice>({ text: "", refused: false, nonce: 0 });

  useEffect(() => {
    if (notice.text.length === 0) return;
    const timer = setTimeout(
      () => setNotice((previous) => ({ text: "", refused: false, nonce: previous.nonce + 1 })),
      NOTICE_DURATION_MS,
    );
    return () => clearTimeout(timer);
  }, [notice]);

  function say(text: string, refused: boolean): void {
    setNotice((previous) => ({ text, refused, nonce: previous.nonce + 1 }));
  }

  async function copyLink(): Promise<void> {
    const built = buildShareUrl(api.getState().doc, window.location);
    if (!built.ok) {
      // Clear the mouth on the way out: a stale "Link copied." sitting beside a refusal band
      // would be two contradictory reports of the same click.
      say("", false);
      onRefused(describeComposeFailure(built.failure));
      return;
    }
    // The address bar becomes the link BEFORE the clipboard is touched. Putting this
    // document in a shareable URL is the affordance's job; copying is the convenience on top
    // of it. It is also what makes the refusal sentence true instead of a dead end — the
    // link is genuinely there to select by hand, which is exactly what the blocked-clipboard
    // e2e case asserts. `replaceState`, never `pushState`: a copy is not a navigation and
    // must not cost the user a Back press.
    window.history.replaceState(null, "", built.url);
    try {
      await navigator.clipboard.writeText(built.url);
      say("Link copied.", false);
    } catch {
      say(CLIPBOARD_REFUSED, true);
    }
  }

  return (
    // `min-w-0`, not `shrink-0`: under width pressure the chrome must clip THIS, never the
    // provenance citation beside it. A transient can afford an ellipsis; a claim about which
    // block the numbers were read at cannot.
    <div className="flex min-w-0 items-center gap-2">
      {/* Mounted from the first paint and never conditionally rendered: a live region
          created in the same commit as its first message is a region no assistive
          technology reads. */}
      <p
        role="status"
        className={cn(
          "transition-fast flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
          notice.text.length === 0 ? "opacity-0" : "opacity-100",
        )}
      >
        {notice.refused ? <Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
        <span key={notice.nonce} className="truncate">
          {notice.text}
        </span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        // The band's glyph grammar is 14px; the primitive's `[&_svg]:size-4` outranks a
        // utility on the svg itself, so the override has to be stated in the same form.
        className="shrink-0 [&_svg]:size-3.5"
        onClick={() => {
          void copyLink();
        }}
      >
        <Link2 aria-hidden="true" />
        Copy link
      </Button>
    </div>
  );
}
