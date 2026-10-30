import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, Folders, House, Layers, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { crumbParent, crumbPlace, type CrumbIcon, type CrumbParent } from "@/lib/threadCrumb";
import { cn } from "@/lib/utils";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { dropdownMenuKit, keepFocusAfterMenu } from "./menuKit";
import { ThreadMenuItems } from "./ThreadMenuItems";

const crumbIcons: Readonly<Record<CrumbIcon, LucideIcon>> = { folder: Folder, layers: Layers, folders: Folders, house: House };

/** The fields of a thread the crumb's place reads (shallow-stable: primitives, its project ids joined). */
function usePlaceInput(id: string) {
  return useThreadsStore(
    useShallow((s) => {
      const t = s.byId[id];
      return {
        projectId: t?.projectId ?? "",
        workspaceId: t?.workspaceId ?? "",
        worktreePath: t?.worktreePath ?? "",
        pendingWorktreePath: t?.pendingWorktreePath ?? "",
        projectIds: (t?.projectIds ?? []).join("\u0000"),
      };
    }),
  );
}

/** The crumb's separator. */
function Sep() {
  return <ChevronRight className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />;
}

/** The parent segment: a click opens that thread; a removed creator is plain text, "Thread removed" on hover. */
function ParentSegment({ parent }: { parent: CrumbParent }) {
  const className = "min-w-0 truncate rounded-sm px-1 text-cf-text-muted";
  if (!parent.exists)
    return (
      <Tip label="Thread removed">
        <span className={cn(className, "opacity-60")} data-testid="thread-crumb-parent" data-removed="true">
          {parent.name}
        </span>
      </Tip>
    );
  return (
    <button
      type="button"
      className={cn(className, "cursor-pointer outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus")}
      data-testid="thread-crumb-parent"
      data-id={parent.id}
      onClick={() => {
        useUiStore.getState().select({ kind: "thread", id: parent.id }, { focusPrompt: true });
      }}
    >
      {parent.name}
    </button>
  );
}

/**
 * Where the thread runs, in front of its title (lib/threadCrumb.ts): a project's folder
 * and name, a workspace's layers and name, an unnamed set's folders and "api +8", or home
 * and "No project"; then the parent thread (its creator, or what it was forked from),
 * which opens on a click. Muted, each segment followed by "›". The branch and the rest of
 * the place are the thread info card's.
 */
function ThreadCrumb({ id }: { id: string }) {
  const input = usePlaceInput(id);
  const wsName = useWorkspacesStore((s) => (input.workspaceId ? (s.byId[input.workspaceId]?.name ?? null) : null));
  // One string over the projects: a status refresh elsewhere does not re-render the crumb.
  const place = useProjectsStore((s) => {
    const t = { ...input, projectIds: input.projectIds ? input.projectIds.split("\u0000") : [] };
    const p = crumbPlace(t, s, { byId: wsName === null ? {} : { [input.workspaceId]: { name: wsName } } });
    return `${p.icon}\u0000${p.label}`;
  });
  const [icon, label] = place.split("\u0000") as [CrumbIcon, string];
  const parent = useThreadsStore(useShallow((s) => crumbParent(s.byId[id] ?? { createdBy: "", createdByName: "", parentId: "" }, s)));
  const crumb = { icon, label, parent };
  const Icon = crumbIcons[crumb.icon];
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-label text-cf-text-muted" data-testid="thread-crumb" data-icon={crumb.icon}>
      <span className="flex min-w-0 items-center gap-1.5 px-1">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" data-testid="thread-crumb-place">
          {crumb.label}
        </span>
      </span>
      <Sep />
      {crumb.parent && (
        <>
          <ParentSegment parent={crumb.parent} />
          <Sep />
        </>
      )}
    </span>
  );
}

/**
 * The thread's title as a menu button: its name, then a small muted chevron, always
 * shown. It opens the thread's menu (ThreadMenuItems, the sidebar row's items verbatim):
 * Enter or Space from the keyboard. While the menu is up the button stays pressed.
 */
function ThreadTitleMenu({ id }: { id: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name || id);
  // The daemon's cut of the first prompt until the naming model's title lands: muted and italic, as in the sidebar.
  const provisional = useThreadsStore((s) => s.byId[id]?.nameProvisional ?? false);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-6 min-w-12 shrink-[100] cursor-pointer items-center gap-1 rounded-md px-1.5 text-label font-medium text-cf-text outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover dark:hover:bg-cf-control-hover/50 dark:aria-expanded:bg-cf-control-hover/50",
          )}
          data-testid="thread-title"
        >
          <span className={cn("truncate", provisional && "text-cf-text-muted italic")} data-testid="thread-title-name">
            {name}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        data-testid="thread-title-menu"
        onCloseAutoFocus={(e) => {
          if (keepFocusAfterMenu(id)) e.preventDefault();
        }}
      >
        <ThreadMenuItems id={id} kit={dropdownMenuKit} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Left side of a thread's header: the crumb (where it runs, its parent), then the title and its menu. */
export function ThreadTitle({ id }: { id: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="thread-title-bar">
      <ThreadCrumb id={id} />
      <ThreadTitleMenu id={id} />
    </span>
  );
}
