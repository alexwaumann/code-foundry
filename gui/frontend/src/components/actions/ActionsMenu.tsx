import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Pencil, Play, Plus } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { runAction, type ActionOwner } from "@/stores/actionActions";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useProjectActionIds } from "@/stores/actions";
import { useProjectsStore } from "@/stores/projects";
import { ACTION_ICON } from "./actionIcons";

type From = "thread" | "projects";

/** Stops a pointer event at the pencil, so the Radix item under it neither selects nor closes. */
function stop(e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * One action: its icon and name; picking it runs it. The pencil at the right end shows on
 * the highlighted row (hover or keyboard) and opens the editor; ArrowRight does the same
 * from the keyboard (aria-keyshortcuts), the way it would open a submenu.
 */
function ActionItem({ id, onRun, onEdit }: { id: string; onRun: (id: string) => void; onEdit: (id: string) => void }) {
  const action = useAction(id);
  if (!action) return null;
  const Icon = ACTION_ICON[action.icon];
  return (
    <DropdownMenuItem
      className="group/item pr-1"
      data-testid="action-item"
      data-action={id}
      aria-keyshortcuts="ArrowRight"
      onSelect={() => {
        onRun(id);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== "ArrowRight" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        e.stopPropagation();
        onEdit(id);
      }}
    >
      <Icon aria-hidden />
      <span className="min-w-0 flex-1 truncate">{action.name}</span>
      <Tip label={`Edit ${action.name}`}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Edit ${action.name}`}
          data-testid="action-edit"
          className="-my-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm text-cf-text-muted opacity-0 group-hover/item:opacity-100 group-data-[highlighted]/item:opacity-100 hover:bg-cf-text/10 hover:text-cf-text [&_svg]:size-3.5"
          onPointerDown={stop}
          onPointerUp={stop}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit(id);
          }}
        >
          <Pencil aria-hidden />
        </button>
      </Tip>
    </DropdownMenuItem>
  );
}

/**
 * A project's actions as a dropdown, from a Projects page worktree row (runs for that
 * worktree; a thread's run from its info card's action row): one row per action (click runs it,
 * the pencil edits it), then "New action…". With none: "No actions for <project> yet" and
 * "New action…". What was picked runs once the menu has closed and handed focus back
 * (a run's tab or the editor then takes it), like the Projects page's overflow menus.
 */
export function ActionsMenu({ projectId, owner, from, testId }: { projectId: string; owner: ActionOwner; from: From; testId: string }) {
  const ids = useProjectActionIds(projectId);
  const project = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const [open, setOpen] = useState(false);
  const picked = useRef<(() => void) | null>(null);
  const before = useRef<Element | null>(null);
  // The closing menu's onCloseAutoFocus comes after its exit animation, maybe after it
  // opened again: it then must not move focus (that would dismiss the new one).
  const openRef = useRef(false);

  const pick = (run: () => void) => {
    picked.current = run;
    openRef.current = false;
    setOpen(false);
  };
  const onRun = (id: string) => {
    pick(() => void runAction(id, owner));
  };
  const onEdit = (id: string) => {
    pick(() => {
      openActionEditor({ mode: "edit", actionId: id, projectId, from });
    });
  };
  const onNew = () => {
    pick(() => {
      openActionEditor({ mode: "new", projectId, from });
    });
  };

  const label = "Run an action";
  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(o) => {
        if (o) before.current = document.activeElement;
        openRef.current = o;
        setOpen(o);
      }}
    >
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={label}
              data-testid={testId}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text [&_svg]:size-3.5"
              onClick={(e) => {
                e.stopPropagation();
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
              }}
            >
              <Play aria-hidden />
            </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        data-testid={`${testId}-menu`}
        onKeyDown={(e) => {
          // Keys stay in the menu (a Projects row's list must not move its cursor).
          e.stopPropagation();
        }}
        onClick={(e) => {
          // Portal events still bubble through React: not to a row.
          e.stopPropagation();
        }}
        onCloseAutoFocus={(e) => {
          // Back to where the keyboard was before the menu (the trigger keeps no focus),
          // then what was picked, which may move it on (a run's tab, the editor).
          e.preventDefault();
          if (!openRef.current) {
            const prev = before.current;
            before.current = null;
            if (prev instanceof HTMLElement && prev.isConnected && prev !== document.body) prev.focus({ preventScroll: true });
          }
          const run = picked.current;
          picked.current = null;
          run?.();
        }}
      >
        {ids.length === 0 ? (
          <DropdownMenuLabel className="font-normal" data-testid="actions-empty">
            No actions for {project} yet
          </DropdownMenuLabel>
        ) : (
          <>
            <DropdownMenuLabel data-testid="actions-project">{project}</DropdownMenuLabel>
            {ids.map((id) => (
              <ActionItem key={id} id={id} onRun={onRun} onEdit={onEdit} />
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem data-testid="action-new" onSelect={onNew}>
          <Plus aria-hidden />
          New action…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
