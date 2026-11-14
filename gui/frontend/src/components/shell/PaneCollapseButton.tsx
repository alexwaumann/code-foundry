import { FoldHorizontal, FoldVertical, UnfoldHorizontal, UnfoldVertical } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { collapsePane, foldAxisOf, openPane, whyNoCollapse } from "@/shell/collapse";
import { useCommandChord } from "@/stores/commands";
import { useLayoutStore } from "@/stores/layout";

const BUTTON = "flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover/40 hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus [--wails-draggable:no-drag]";

/** Its name and key, for an icon-only control's tooltip. */
function useNamed(name: string): string {
  const chord = useCommandChord("pane.collapse");
  return chord ? `${name} ${formatChord(chord)}` : name;
}

/**
 * The strip's collapse control (docs/notes/shell-model.md, "Collapsing a pane"), left of full
 * screen: it folds the pane to a rail (in a column, a strip) until the user opens it again. The
 * last open pane of a space cannot be collapsed: the control is disabled and its tooltip says why.
 */
export function PaneCollapseButton({ paneId, className }: { paneId: string; className?: string }) {
  const why = useLayoutStore((s) => whyNoCollapse(s, paneId));
  const axis = useLayoutStore((s) => foldAxisOf(s.trees[s.panes[paneId]?.spaceId ?? ""], paneId));
  const label = useNamed("Collapse pane");
  const Icon = axis === "col" ? FoldVertical : FoldHorizontal;
  return (
    <Tip label={why || label}>
      {/* aria-disabled, not disabled: a disabled button gets no pointer events, so no tooltip with the reason. */}
      <button
        type="button"
        aria-label="Collapse pane"
        aria-disabled={why ? true : undefined}
        data-testid="shell-collapse"
        className={cn(BUTTON, why && "opacity-40 hover:bg-transparent hover:text-cf-text-muted", className)}
        onClick={() => {
          if (!why) void collapsePane(paneId);
        }}
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    </Tip>
  );
}

/** A collapsed pane's rail control: it opens the pane again, with the focus. */
export function PaneExpandButton({ paneId, vertical }: { paneId: string; vertical: boolean }) {
  const label = useNamed("Open pane");
  const Icon = vertical ? UnfoldHorizontal : UnfoldVertical;
  return (
    <Tip label={label} side={vertical ? "right" : "bottom"}>
      <button
        type="button"
        aria-label="Open pane"
        data-testid="shell-rail-expand"
        className={BUTTON}
        onClick={() => {
          void openPane(paneId);
        }}
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    </Tip>
  );
}
