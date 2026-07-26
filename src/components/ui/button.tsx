import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

/**
 * The variant list encodes the screen's attention budget rather than a palette:
 * `default`, `outline` and `ghost` are three weights of the same neutral control, and
 * chroma is spent only on a commit. `primary` is the ONE terminal commit action per
 * screen; `destructive` is for irreversible commits. Press is a step along the surface
 * ramp — no transform, because an interface that recoils under the cursor is performing.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "border border-transparent",
    "transition-fast focus-ring",
    // Gated actions in P3 must NOT use this: a disabled control cannot be focused and so
    // cannot explain itself. Those use aria-disabled + aria-describedby + an intercepted
    // click, which keeps the reason reachable. `disabled` here means genuinely inert.
    "disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground hover:bg-muted active:bg-card-elevated",
        outline: "border-border bg-card text-foreground hover:bg-card-hover active:bg-card-elevated",
        ghost: "bg-transparent text-foreground hover:bg-secondary active:bg-card-elevated",
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80",
      },
      size: {
        sm: "h-7 rounded-sm px-2.5 text-xs",
        default: "h-9 rounded-sm px-3 text-sm",
        lg: "h-11 rounded-sm px-5 text-sm",
        icon: "h-9 w-9 rounded-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // A bare <button> inside a form submits it. Defaulting at the primitive disarms that
    // for every consumer; under asChild the child element owns its own semantics, so
    // nothing is forced onto it.
    const resolvedType = asChild ? type : (type ?? "button");
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...(resolvedType === undefined ? {} : { type: resolvedType })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
