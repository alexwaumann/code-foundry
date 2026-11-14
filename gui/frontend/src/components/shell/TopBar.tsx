import { useState } from "react";
import { ChevronLeft, ChevronRight, PanelLeft, Plus } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { APP_NAME_WIDTH, TITLE_BAND_HEIGHT, trafficLightGutter } from "@/components/window/titleBand";
import { toggleSidebar } from "@/keys/bindings";
import { newSpace } from "@/shell/spaceActions";
import { useCanStepFocus } from "@/stores/focusHistory";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { NeedsPopover } from "@/components/needs/NeedsPopover";
import { SpaceTabs } from "./SpaceTabs";

/**
 * Back and forward through what was focused (view.back, view.forward; stores/focusHistory.ts),
 * across panes and spaces. Each dims when it would go nowhere.
 */
function FocusHistoryButtons() {
  const back = useCanStepFocus(-1);
  const forward = useCanStepFocus(1);
  return (
    <span className="flex shrink-0 items-center [--wails-draggable:no-drag]" data-testid="top-bar-history">
      <CommandButton command="view.back" icon={ChevronLeft} disabled={!back} tooltipSide="bottom" data-testid="top-bar-back" />
      <CommandButton command="view.forward" icon={ChevronRight} disabled={!forward} tooltipSide="bottom" data-testid="top-bar-forward" />
    </span>
  );
}

/**
 * The window shell's top bar (docs/notes/shell-model.md, "Structure"): always visible, laid out on
 * its own with no alignment to the sidebar. The traffic-light gutter, the app name, the sidebar
 * toggle, back and forward, the Needs you control while the sidebar is collapsed, then the space
 * tabs, then "+" (a new space, shown at once, its name ready to type).
 *
 * It is the window's drag band (Wails runtime, `--wails-draggable`): everything but its buttons
 * and tabs drags the window. It is the title band's height (titleBand.ts), its row centred where
 * the host puts the traffic lights; the panes start right under it. See
 * docs/notes/shell-15-spaces.md.
 */
export function TopBar() {
  const gutter = useUiStore((s) => trafficLightGutter(s.zoom));
  const loaded = useLayoutStore((s) => s.loaded);
  const [renaming, setRenaming] = useState("");
  return (
    <div className="flex shrink-0 bg-cf-chrome [--wails-draggable:drag]" style={{ height: TITLE_BAND_HEIGHT }} data-testid="top-bar">
      <div className="h-full shrink-0" style={{ width: gutter }} data-testid="traffic-light-gutter" aria-hidden />
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 pt-shell pr-shell pl-3">
        {/* A fixed box, so the sidebar toggle's right edge is a constant the sidebar's width lines up with (titleBand.ts sidebarToggleEnd). */}
        <span className="shrink-0 text-brand leading-none whitespace-nowrap text-cf-sidebar-foreground select-none" style={{ width: APP_NAME_WIDTH }} data-testid="top-bar-app-name">
          Code Foundry
        </span>
        <span className="ml-2 flex shrink-0 items-center [--wails-draggable:no-drag]">
          <Tip label="Toggle sidebar" side="bottom">
            <Button variant="ghost" size="icon-xs" className="size-7" aria-label="Toggle sidebar" onClick={toggleSidebar} data-testid="top-bar-sidebar-toggle">
              <PanelLeft className="size-4" />
            </Button>
          </Tip>
        </span>
        <FocusHistoryButtons />
        {/* While the sidebar is collapsed: the Needs you count and its list (components/needs/NeedsPopover.tsx), after back and forward so they never move. */}
        {loaded && <NeedsPopover />}
        {loaded && (
          <>
            <SpaceTabs renaming={renaming} onRenaming={setRenaming} />
            <Tip label="New space" side="bottom">
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7 shrink-0 [--wails-draggable:no-drag]"
                aria-label="New space"
                onClick={() => {
                  void newSpace().then((id) => {
                    if (id) setRenaming(id);
                  });
                }}
                data-testid="top-bar-new-space"
              >
                <Plus className="size-4" />
              </Button>
            </Tip>
          </>
        )}
      </div>
    </div>
  );
}
