import { useContext } from "react";
import { ACTION_ICON } from "@/components/actions/actionIcons";
import { GearMenuItem } from "@/components/threadinfo/GearMenuItem";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { BADGE_WORD } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { runAction } from "@/stores/actionActions";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useProjectActionIds } from "@/stores/actions";
import { StatusDot } from "./bits";
import type { CheckoutMenuPart } from "./menus";
import { OpenInSplitItem } from "./OpenInMenuItem";
import { RowMenuPickContext, type RowMenuParts } from "./RowContextMenu";
import { openThread } from "./workspaceHooks";

type Part<K extends CheckoutMenuPart["kind"]> = Extract<CheckoutMenuPart, { kind: K }>;

/** Open thread ›: each open thread on the checkout, its status dot, name and status word; a pick selects it. */
function ThreadsSub({ entry }: { entry: Part<"threads"> }) {
  const { pick } = useContext(RowMenuPickContext);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid={entry.testId}>Open thread</ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-w-80 min-w-56" data-testid={`${entry.testId}-menu`}>
        {entry.threads.map((t) => (
          <ContextMenuItem
            key={t.id}
            data-testid="checkout-menu-thread"
            data-thread-id={t.id}
            onSelect={() => {
              pick(() => {
                openThread(t.id);
              });
            }}
          >
            <StatusDot live={t.badge === "busy"} />
            <span className="min-w-0 truncate">{t.name}</span>
            <span className={cn("ml-auto shrink-0 pl-4 text-caption text-cf-text-muted", t.badge === "attention" && "text-cf-warning-text", t.badge === "error" && "text-cf-error-text")} data-testid="checkout-menu-thread-state">
              {BADGE_WORD[t.badge]}
            </span>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** One action: a pick runs it in the checkout; its gear (on the highlighted item) opens its editor. */
function ActionItem({ id, projectId, path }: { id: string; projectId: string; path: string }) {
  const { pick } = useContext(RowMenuPickContext);
  const action = useAction(id);
  if (!action) return null;
  const Icon = ACTION_ICON[action.icon];
  return (
    <GearMenuItem
      item={ContextMenuItem}
      data-testid="checkout-menu-action"
      data-action={id}
      gearLabel={`Edit ${action.name}`}
      gearTestId="checkout-menu-action-gear"
      onRun={() => {
        pick(() => void runAction(id, { kind: "worktree", projectId, path }));
      }}
      onGear={() => {
        pick(() => {
          openActionEditor({ mode: "edit", actionId: id, projectId, from: "projects" });
        });
      }}
    >
      <Icon aria-hidden />
      <span className="min-w-0 truncate">{action.name}</span>
    </GearMenuItem>
  );
}

/** Run action ›: the project's actions (run in this checkout, gear edits), then Add action. */
function ActionsSub({ entry }: { entry: Part<"actions"> }) {
  const { pick } = useContext(RowMenuPickContext);
  const ids = useProjectActionIds(entry.projectId);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid={entry.testId}>Run action</ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-w-80 min-w-52" data-testid={`${entry.testId}-menu`}>
        {ids.map((id) => (
          <ActionItem key={id} id={id} projectId={entry.projectId} path={entry.path} />
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="checkout-menu-add-action"
          onSelect={() => {
            pick(() => {
              openActionEditor({ mode: "new", projectId: entry.projectId, from: "projects" });
            });
          }}
        >
          Add action
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function OpenIn({ entry }: { entry: Part<"open-in"> }) {
  return <OpenInSplitItem projectId={entry.projectId} path={entry.path} testId={entry.testId} />;
}

/** The parts of a checkout's right-click menu (menus.ts checkoutMenu), by kind. */
export const CHECKOUT_MENU_PARTS: RowMenuParts<CheckoutMenuPart> = { threads: ThreadsSub, "open-in": OpenIn, actions: ActionsSub };
