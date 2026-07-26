import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge cannot classify custom utilities. Without this, `text-micro` /
// `text-label` (the globals.css label tiers) are guessed as text-COLOR classes and
// silently dedupe a real color like `text-muted-foreground` out of the class list —
// a conflict that drops tokens invisibly at runtime.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": ["text-micro", "text-label"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
