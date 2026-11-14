import type { ComponentProps } from "react";
import { Check, Copy, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useCopied } from "@/lib/useCopied";
import { cn } from "@/lib/utils";

/**
 * A copy control's icon: `icon` (Copy) at rest, a check in the success colour while
 * `copied` (lib/useCopied). The same box either way, so nothing moves.
 */
export function CopyIcon({ copied, icon: Icon = Copy, className }: { copied: boolean; icon?: LucideIcon; className?: string }) {
  return copied ? <Check aria-hidden className={cn("text-cf-success-text", className)} data-copied="" /> : <Icon aria-hidden className={className} />;
}

/**
 * The app's copy icon button (docs/notes/toast-success-rule.md): copies `text` (or what the
 * function returns, read on press) and shows the result where it was pressed: for
 * COPIED_MS its icon is a check in the success colour and its name and tooltip read
 * "Copied". No toast, except "Copy failed". A muted ghost icon button by default; other
 * Button props (size, className, tabIndex) pass through.
 */
export function CopyButton({
  text,
  label = "Copy",
  testId,
  className,
  iconClassName,
  ...props
}: { text: string | (() => string); label?: string; testId?: string; iconClassName?: string } & Omit<ComponentProps<typeof Button>, "onClick" | "children" | "aria-label">) {
  const { copied, copy } = useCopied();
  const name = copied ? "Copied" : label;
  return (
    <Tip label={name}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn("shrink-0 text-cf-text-muted hover:text-cf-text", className)}
        aria-label={name}
        data-copied={copied || undefined}
        data-testid={testId}
        onClick={() => {
          void copy(typeof text === "function" ? text() : text);
        }}
        {...props}
      >
        <CopyIcon copied={copied} className={iconClassName} />
      </Button>
    </Tip>
  );
}
