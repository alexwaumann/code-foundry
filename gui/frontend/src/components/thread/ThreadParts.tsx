import { type ReactNode } from "react";
import { ChevronRight, Folders, House, Layers, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ProjectIcon } from "@/components/icons/ProjectKindIcon";
import { Tip } from "@/components/ui/tooltip";
import { movingLabel } from "@/lib/move";
import { crumbLink, crumbParent, crumbPlace, type CrumbIcon, type CrumbParent } from "@/lib/threadCrumb";
import { runCommand } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { MovePicker } from "./MovePicker";
import { useCanMove } from "./useNoProject";
import { useMovingTo } from "./useMovingTo";

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

/** The crumb's separator. */
function Sep() {
  return <ChevronRight className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />;
}

/** A crumb segment that is a link. */
export const CRUMB_LINK = "min-w-0 cursor-pointer truncate rounded-sm px-1 text-cf-text-muted outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus";

/** The parent segment: a click opens that thread; a removed creator is plain text, "Thread removed" on hover. */
function ParentSegment({ parent }: { parent: CrumbParent }) {
  if (!parent.exists)
    return (
      <Tip label="Thread removed">
        <span className="min-w-0 truncate rounded-sm px-1 text-cf-text-muted opacity-60" data-testid="thread-crumb-parent" data-removed="true">
          {parent.name}
        </span>
      </Tip>
    );
  return (
    <button
      type="button"
      className={CRUMB_LINK}
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
 *
 * `run`: the crumb of one of the thread's subagent runs (SubagentPane), read-only: no move
 * picker, and `run.parent` (the way back up to this thread) in the parent's place.
 */
export function ThreadCrumb({ id, run }: { id: string; run?: { parent: ReactNode } }) {
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
  const movable = useCanMove(id) && icon === "house" && run === undefined;
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
      {run ? (
        <>
          {run.parent}
          <Sep />
        </>
      ) : (
        parent && (
          <>
            <ParentSegment parent={parent} />
            <Sep />
          </>
        )
      )}
    </span>
  );
}
