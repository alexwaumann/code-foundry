import { useMemo, type HTMLAttributes, type Ref } from "react";
import { ThreadContext } from "@/components/thread/context";
import { PlaceChip, ThreadHeaderMenu } from "@/components/thread/ThreadHeader";
import { TranscriptDeletedChip } from "@/components/thread/TranscriptDeleted";
import { ThreadInfoToggle } from "@/components/threadinfo/ThreadInfoToggle";
import { Tip } from "@/components/ui/tooltip";
import { PANE_HEADER_HEIGHT } from "@/components/window/titleBand";
import { mergeHandlers } from "@/lib/mergeHandlers";
import { cn } from "@/lib/utils";
import { shellTabDomId } from "@/shell/domIds";
import { usePaneDrag } from "@/shell/drag/draggable";
import { keepPreviewTab } from "@/shell/preview";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useIsEmberThread } from "@/stores/ember";
import { useTab, type TabEntry } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { FullscreenButton, PREVIEW_DASHES, StatusDot, TabContentIcon, TabContextMenu } from "./PaneTabStrip";
import { PaneCollapseButton } from "./PaneCollapseButton";
import { PanePlusMenu } from "./PanePlusMenu";

const notProvisional = (): boolean => false;

/**
 * The thread's icon with its status dot, then its name as plain text (muted and italic while not
 * final, as the tab's); a preview is dashed as its tab is, and a double click keeps it.
 */
function HeaderTitle({ tab }: { tab: TabEntry }) {
  const surface = shellSurfaceOf(tab.kind);
  const title = surface.useTitle(tab);
  // A tab's kind never changes, so the hook its surface has (or none) is the same on every render.
  const provisional = (surface.useNameProvisional ?? notProvisional)(tab);
  return (
    <span
      className={cn("relative flex min-w-0 shrink-[100] items-center gap-1.5", tab.preview && cn("-ml-1.5 h-7 px-1.5", PREVIEW_DASHES))}
      data-testid="thread-pane-header-title"
      data-tab-id={tab.id}
      data-preview={tab.preview || undefined}
      onDoubleClick={() => {
        // As the preview tab's double click: keep it (a kept tab's double click does nothing).
        if (tab.preview) void keepPreviewTab(tab.id);
      }}
    >
      <span className="relative flex shrink-0">
        <TabContentIcon tab={tab} />
        {surface.useStatus && <StatusDot use={surface.useStatus} tab={tab} />}
      </span>
      <Tip label={title} whenTruncated side="bottom">
        <span
          id={shellTabDomId(tab.id)}
          className={cn("min-w-0 truncate text-label font-medium", provisional ? "text-cf-text-muted italic" : "text-cf-text")}
          data-testid="thread-pane-header-name"
          data-provisional={provisional || undefined}
        >
          {title}
        </span>
      </Tip>
      {tab.preview && <span className="sr-only">, preview</span>}
    </span>
  );
}

/**
 * The row's element: the pane's drag handle (dnd-kit's ref and pointer listener) and, for a
 * thread, its context menu's trigger (Radix's Slot: its ref and handlers). Both get the element
 * and every event, as a strip's tab does (PaneTabStrip ShellTabBox). A thread's rename is the
 * tab's: Rename in either menu edits its name in the sidebar (cmd+r too).
 */
function HeaderBox({ tab, focused, fullscreen, ref: triggerRef, ...rest }: { tab: TabEntry; focused: boolean; fullscreen: boolean; ref?: Ref<HTMLDivElement> } & HTMLAttributes<HTMLDivElement>) {
  const paneId = tab.paneId;
  const thread = tab.kind === "thread" ? tab.thread : "";
  const { setNodeRef, listeners, describedBy } = usePaneDrag(paneId);
  const handlers = mergeHandlers(rest, listeners);
  const cwd = useThreadsStore((s) => (thread ? (s.byId[thread]?.worktreePath ?? "") : ""));
  const ctx = useMemo(() => ({ threadId: thread, cwd }), [thread, cwd]);
  // Ember's chat draws its own header under the row (components/ember/EmberPane.tsx): the row keeps only the name and the pane's buttons.
  const ember = useIsEmberThread(thread);
  const own = thread !== "" && !ember;
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        if (typeof triggerRef === "function") triggerRef(el);
        else if (triggerRef) triggerRef.current = el;
      }}
      {...rest}
      {...handlers}
      role="group"
      aria-label="Thread pane"
      aria-describedby={describedBy}
      data-testid="thread-pane-header"
      data-tab-id={tab.id}
      data-kind={tab.kind}
      data-focused={focused || undefined}
      className="relative flex shrink-0 items-center gap-2 border-b border-cf-divider pr-1.5 pl-3 [--wails-draggable:no-drag]"
      style={{ height: PANE_HEADER_HEIGHT }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2" data-testid="thread-title-bar">
        <HeaderTitle tab={tab} />
        {own && <PlaceChip threadId={thread} />}
        {own && <TranscriptDeletedChip id={thread} />}
      </span>
      <span
        className="flex shrink-0 items-center gap-0.5 text-cf-text-muted"
        data-testid="pane-actions"
        // The buttons are not the pane's grip: a press on one is the button's.
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
      >
        <PanePlusMenu paneId={paneId} />
        {own && (
          <ThreadContext.Provider value={ctx}>
            <ThreadInfoToggle />
            <ThreadHeaderMenu threadId={thread} paneId={paneId} />
          </ThreadContext.Provider>
        )}
        {!fullscreen && <PaneCollapseButton paneId={paneId} />}
        <FullscreenButton paneId={paneId} on={fullscreen} pushed />
      </span>
    </div>
  );
}

/**
 * A thread pane's one header row under "Threads open as" Panes and Single
 * (docs/notes/threads-open-as-2-gui.md): the sidebar is the thread switcher, so a pane that shows
 * one thread draws no strip for it. Left, the thread's icon with its status dot, its name and its
 * branch chip (the thread header's); right, the "+" menu, the thread info toggle, the thread's
 * menu, then collapse and full screen as the strip has them. No close button: the row's context
 * menu (the tab's) and the "…" menu have Close. The row drags the pane, as a strip's free space
 * does. A composer's row shows its "New thread" or draft label and no thread buttons.
 */
export function ThreadPaneHeader({ tabId, focused, fullscreen = false }: { tabId: string; focused: boolean; fullscreen?: boolean }) {
  const tab = useTab(tabId);
  if (!tab) return null;
  return (
    <TabContextMenu tab={tab}>
      <HeaderBox tab={tab} focused={focused} fullscreen={fullscreen} />
    </TabContextMenu>
  );
}
