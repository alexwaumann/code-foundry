import { useState } from "react";
import { ChevronDown, ChevronRight, Folders, House, Layers, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon } from "@/components/icons/ProjectKindIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { movingLabel, movingTo } from "@/lib/move";
import { crumbLink, crumbParent, crumbPlace, type CrumbIcon, type CrumbParent } from "@/lib/threadCrumb";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useMovePickerStore } from "@/stores/movePicker";
import { useWorkspacesStore } from "@/stores/workspaces";
import { dropdownMenuKit, focusPromptAfterMenu, keepFocusAfterMenu } from "./menuKit";
import { MovePicker } from "./MovePicker";
import { useCanMove } from "./useNoProject";
import { ThreadMenuItems } from "./ThreadMenuItems";
import { TranscriptDeletedChip } from "./TranscriptDeleted";

/** The place icons other than one project's (that one is the project's kind icon). */
const crumbIcons: Readonly<Record<Exclude<CrumbIcon, "folder">, LucideIcon>> = { layers: Layers, folders: Folders, house: House };

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

/**
 * Where the thread is moving to, by name (lib/move movingTo): its pending_move, else a
 * move this window sent and the daemon has not answered; null when it is not moving.
 */
function useMovingTo(id: string): string | null {
  const pending = useThreadsStore(useShallow((s) => {
    const m = s.byId[id]?.pendingMove;
    return m ? { projectId: m.projectId, workspaceId: m.workspaceId } : null;
  }));
  const sending = useMovePickerStore((s) => s.sending[id]);
  const project = useProjectsStore((s) => (pending?.projectId ? s.byId[pending.projectId]?.name : undefined));
  const workspace = useWorkspacesStore((s) => (pending?.workspaceId ? s.byId[pending.workspaceId]?.name : undefined));
  return movingTo(pending, sending, { project: () => project, workspace: () => workspace });
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
 * which opens on a click. Muted, each segment followed by "›". The place opens its page on
 * the Projects view on a click (view.projects --workspace or --project: the workspace's,
 * else the primary project's); no project, or a removed one, is plain text. The branch and
 * the rest of the place are the thread info card's.
 */
function ThreadCrumb({ id }: { id: string }) {
  const input = usePlaceInput(id);
  const wsName = useWorkspacesStore((s) => (input.workspaceId ? (s.byId[input.workspaceId]?.name ?? null) : null));
  // Primitives over the projects (shallow): a status refresh elsewhere does not re-render the crumb.
  const { icon, label, workspace, project } = useProjectsStore(
    useShallow((s) => {
      const t = { ...input, projectIds: input.projectIds ? input.projectIds.split("\u0000") : [] };
      const workspaces = { byId: wsName === null ? {} : { [input.workspaceId]: { name: wsName } } };
      const link = crumbLink(t, s, workspaces);
      return { ...crumbPlace(t, s, workspaces), workspace: link && "workspace" in link ? link.workspace : "", project: link && "project" in link ? link.project : "" };
    }),
  );
  const parent = useThreadsStore(useShallow((s) => crumbParent(s.byId[id] ?? { createdBy: "", createdByName: "", parentId: "" }, s)));
  // No project: the place opens the move picker (MovePicker); while it moves, "Moving to <name>…".
  const movable = useCanMove(id) && icon === "house";
  const moving = useMovingTo(id);
  // view.projects' args (--workspace or --project); null: plain text.
  const args: Record<string, string> | null = workspace ? { workspace } : project ? { project } : null;
  const Icon = icon === "folder" ? null : crumbIcons[icon];
  const content = (
    <>
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : <ProjectIcon projectId={input.projectId} className="size-3.5 shrink-0" />}
      <span className="truncate" data-testid="thread-crumb-place">
        {moving === null ? label : movingLabel(moving)}
      </span>
    </>
  );
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-label text-cf-text-muted" data-testid="thread-crumb" data-icon={icon}>
      {movable && moving === null ? (
        <MovePicker threadId={id}>{content}</MovePicker>
      ) : args ? (
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
          data-testid="thread-crumb-place-link"
          onClick={() => {
            void runCommand("view.projects", args);
          }}
        >
          {content}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 px-1">{content}</span>
      )}
      <Sep />
      {parent && (
        <>
          <ParentSegment parent={parent} />
          <Sep />
        </>
      )}
    </span>
  );
}

const STALE_TIP = "Plugin environment changed · Restart Claude from this menu";

/**
 * The thread's title as a menu button: its name, then a small muted chevron, always
 * shown. It opens the thread's menu (ThreadMenuItems, the sidebar row's items verbatim):
 * Enter or Space from the keyboard. While the menu is up the button stays pressed. While a
 * plugin's environment changed since Claude started, a warning dot on the chevron says so
 * (its tooltip points at the menu's Restart Claude).
 */
function ThreadTitleMenu({ id }: { id: string }) {
  const name = useThreadsStore((s) => s.byId[id]?.name || id);
  // The daemon's cut of the first prompt until the utility model's title lands, or a name being
  // regenerated (thread.regenerate-name): muted and italic, as in the sidebar.
  const provisional = useThreadsStore((s) => (s.byId[id]?.nameProvisional || s.byId[id]?.naming) ?? false);
  // With the card off nothing else says it: a warning dot on the chevron, and the menu has Restart Claude.
  const stale = useThreadsStore((s) => s.byId[id]?.pluginEnvStale ?? false);
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tip label={stale ? STALE_TIP : null} data-testid="thread-title-stale-tip">
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
            <span className="relative flex shrink-0">
              <ChevronDown className="size-3.5 text-cf-text-muted" aria-hidden />
              {stale && <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-cf-warning" data-testid="thread-title-stale" role="img" aria-label={STALE_TIP} />}
            </span>
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        data-testid="thread-title-menu"
        onCloseAutoFocus={(e) => {
          if (!keepFocusAfterMenu(id)) return;
          e.preventDefault();
          focusPromptAfterMenu(id);
        }}
      >
        <ThreadMenuItems id={id} kit={dropdownMenuKit} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Left side of a thread's header: the crumb (where it runs, its parent), then the title
 * and its menu, then "Transcript deleted" when Claude Code deleted the transcript.
 */
export function ThreadTitle({ id }: { id: string }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="thread-title-bar">
      <ThreadCrumb id={id} />
      <ThreadTitleMenu id={id} />
      <TranscriptDeletedChip id={id} />
    </span>
  );
}
