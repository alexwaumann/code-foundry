import { ChevronDown, Loader2, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";

/** A split button's colour: the merge's success fill, or the neutral control. */
export type SplitTone = "success" | "neutral";

/** A blocked main part: the neutral control without its hover (it runs nothing). */
const blockedLook = "border-cf-border bg-cf-canvas dark:border-cf-input dark:bg-cf-input/30";

const tones: Record<SplitTone, string> = {
  success: "border-transparent bg-cf-success text-cf-success-foreground enabled:hover:bg-cf-success/90 aria-expanded:bg-cf-success/90",
  neutral: "border-cf-border bg-cf-canvas enabled:hover:bg-cf-control-hover aria-expanded:bg-cf-control-hover dark:border-cf-input dark:bg-cf-input/30 dark:enabled:hover:bg-cf-input/50 dark:aria-expanded:bg-cf-input/50",
};

/**
 * The readiness box's Merge and Auto-merge: the main part runs the default method, the
 * chevron opens the menu of methods (`children`, given a close function). A blocked
 * split button is grey at the app's disabled opacity (Button's disabled:opacity-50), both
 * parts, so it never reads like the Review button beside it; the main part stays
 * focusable and says why in its tooltip (aria-disabled, not disabled), and the chevron
 * still opens the menu, which explains it. While busy both parts are inert and the icon
 * spins.
 */
export function SplitButton({
  icon: Icon,
  label,
  tone,
  reason,
  busy,
  onRun,
  menuLabel,
  testId,
  children,
}: {
  icon: LucideIcon;
  label: string;
  tone: SplitTone;
  /** Why the main part is disabled; null when it runs. */
  reason: string | null;
  busy: boolean;
  onRun: () => void;
  /** The chevron's name (its tooltip and aria-label). */
  menuLabel: string;
  testId: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { ref, boundary } = usePanelBoundary();
  const reasonId = useId();
  const blocked = reason !== null || busy;
  // A blocked merge is greyed, not green: it is not the next step.
  const look = tones[reason !== null ? "neutral" : tone];
  const part = "flex h-7 shrink-0 items-center border text-label shadow-xs outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-cf-focus/60";
  return (
    <span ref={ref} className="flex min-w-0 shrink-0" data-testid={`${testId}-split`} data-blocked={reason !== null || undefined}>
      <Tip label={reason}>
        <button
          type="button"
          data-testid={testId}
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          aria-describedby={reason ? reasonId : undefined}
          data-reason={reason ?? undefined}
          className={cn(part, reason !== null ? blockedLook : look, "min-w-0 gap-1.5 rounded-l-md px-2", reason !== null && "opacity-50", blocked && "cursor-default")}
          onClick={() => {
            if (!blocked) onRun();
          }}
        >
          {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <Icon className="size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0 truncate">{label}</span>
          {reason && (
            <span id={reasonId} className="sr-only">
              {reason}
            </span>
          )}
        </button>
      </Tip>
      <DropdownMenu
        modal={false}
        open={open && !busy}
        onOpenChange={(next) => {
          if (!next || !busy) setOpen(next);
        }}
      >
        <Tip label={menuLabel}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={menuLabel}
              aria-disabled={busy || undefined}
              data-testid={`${testId}-menu-button`}
              className={cn(part, look, "-ml-px w-6 justify-center rounded-r-md border-l-current/25", reason !== null && "opacity-50", busy && "cursor-default")}
            >
              <ChevronDown className="size-3.5 opacity-80" aria-hidden />
            </button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent
          align="end"
          collisionBoundary={boundary}
          collisionPadding={POPUP_COLLISION_PADDING}
          className={cn("w-72", POPUP_FIT)}
          data-testid={`${testId}-menu`}
          data-region="panel"
          onKeyDown={stopPlainKeys}
        >
          {children(() => {
            setOpen(false);
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
