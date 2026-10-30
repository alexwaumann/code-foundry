import { useMemo, useState, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, CircleAlert, Code, FolderOpen, Layers, OctagonX, Play, Plug, Plus, Save, SquareTerminal, X } from "lucide-react";
import { FinderMark } from "@/components/icons/FinderMark";
import { ACTION_ICON } from "@/components/actions/actionIcons";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { envStaleTip } from "@/lib/envStale";
import { ownMovedText } from "@/lib/placementCandidates";
import { chooseAction, moreProjects } from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useActionsStore } from "@/stores/actions";
import { bottomKeyOf } from "@/stores/bottomPanel";
import { newBottomTerminal } from "@/stores/bottomActions";
import { runCommand } from "@/stores/commands";
import { useProjectRefusals } from "@/stores/placementChecks";
import { useProjectsStore } from "@/stores/projects";
import { openSaveWorkspace, useCanSaveAsWorkspace } from "@/stores/saveWorkspace";
import { runCardAction, useActionPicks, useEditorApps } from "@/stores/threadInfo";
import { runThreadIn, threadContext } from "@/stores/threadActions";
import { removeThreadProject } from "@/stores/threadProjects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { AddProjectPicker } from "./AddProjectPicker";
import { Group, HOVER_CARD, Row, RowMenu, SubLine } from "./Row";
import { useMembers } from "./useMembers";

/** A named workspace: its name and the set's size. */
function WorkspaceRow({ threadId }: { threadId: string }) {
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const count = useThreadsStore((s) => s.byId[threadId]?.projectIds.length ?? 0);
  const name = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? "") : ""));
  if (!name) return null;
  return (
    <Row icon={<Layers />} meta={`${String(count)} ${count === 1 ? "project" : "projects"}`} testId="ti-workspace">
      <span className="font-medium">{name}</span>
    </Row>
  );
}

/**
 * One "Run in" item: the member's name, a tick on the cwd, its branch when it differs from
 * the cwd's. Every other member has a × (on hover, and Delete or Backspace while it is
 * highlighted) that takes it out of the thread: thread.project.remove, which asks first
 * when its checkout has uncommitted changes. A member whose worktree moved off the
 * thread's branch is greyed with the daemon's refusal as its tooltip (thread.placement.check:
 * a new thread on the branch would be refused there); it can still be run in.
 */
function RunInItem({
  threadId,
  projectId,
  path,
  cwd,
  cwdBranch,
  createdBranch,
  refusal,
  onRemove,
}: {
  threadId: string;
  projectId: string;
  path: string;
  cwd: boolean;
  cwdBranch: string;
  /** The branch the thread's worktrees were made for ("" in checkout mode). */
  createdBranch: string;
  refusal?: string;
  onRemove: (projectId: string) => void;
}) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.path === path)?.branch ?? "");
  const detached = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.path === path)?.detached ?? false);
  // The thread's own checkout moved: say so, not the daemon's words naming this thread as the one working there.
  const tip = refusal ? (ownMovedText(path, createdBranch, branch, detached) ?? refusal) : undefined;
  const item = (
    <DropdownMenuItem
      data-testid="ti-runin-item"
      data-project={projectId}
      data-current={cwd ? "" : undefined}
      data-refused={tip ? "" : undefined}
      className="group/runin"
      onSelect={() => {
        if (!cwd) void runThreadIn(threadId, projectId);
      }}
      onKeyDown={(e) => {
        if (!cwd && (e.key === "Delete" || e.key === "Backspace")) {
          e.preventDefault();
          onRemove(projectId);
        }
      }}
    >
      {cwd ? <Check className="text-cf-link" aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">
        {name}
        {!cwd && branch && (branch !== cwdBranch || tip) && (
          <span className={cn("text-cf-text-muted", tip && "opacity-60")}>
            {" @ "}
            <span className="text-code">{branch}</span>
          </span>
        )}
      </span>
      {!cwd && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove ${name} from this thread`}
          data-testid="ti-runin-remove"
          className="-my-1 -mr-1 hidden size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted group-hover/runin:flex group-data-highlighted/runin:flex hover:bg-cf-control-hover hover:text-cf-text"
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove(projectId);
          }}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </DropdownMenuItem>
  );
  return tip ? (
    <Tip label={tip} side="left" data-testid="ti-runin-refusal">
      {item}
    </Tip>
  ) : (
    item
  );
}

/** What the project row's hover card says: the thread's plugin flags and a changed plugin environment. */
function useProjectNotes(threadId: string) {
  const flags = useThreadsStore(
    useShallow((s) => (s.byId[threadId]?.flags ?? []).map((f) => `${f.level}\u0000${f.pluginName}\u0000${f.reason}`)),
  );
  const envChange = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t?.pluginEnvStale ? (t.pluginEnvChange ?? "") : null;
  });
  return { flags: flags.map((f) => f.split("\u0000") as [string, string, string]), envChange };
}

/**
 * The project row's notes (once the thread header's flag chip and environment note): each
 * plugin flag, red for an error and amber for attention, then "Plugin environment changed"
 * with what changed. Restart Claude is the title menu's (components/thread/ThreadMenuItems).
 */
function ProjectNotes({ flags, envChange }: ReturnType<typeof useProjectNotes>) {
  return (
    <span className={cn(HOVER_CARD, "flex flex-col gap-1.5")} data-testid="ti-project-notes">
      {flags.map(([level, plugin, reason]) => (
        <span key={plugin} className={cn("flex items-start gap-1.5", level === "error" ? "text-cf-error-text" : "text-cf-warning-text")} data-testid="ti-project-flag" data-level={level}>
          {level === "error" ? <OctagonX className="mt-0.5 size-3 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />}
          <span>
            <span className="font-medium">{plugin}</span>: {reason}
          </span>
        </span>
      ))}
      {envChange !== null && (
        <span className="flex items-start gap-1.5" data-testid="ti-project-env-stale">
          <Plug className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span className="whitespace-pre-line">
            <span className="font-medium">Plugin environment changed</span>
            {"\n"}
            {envStaleTip(envChange)}
          </span>
        </span>
      )}
    </span>
  );
}

/** The mark before the project row's value while it has notes: the worst flag's icon, else the plug. */
function NotesMark({ flags, envChange }: ReturnType<typeof useProjectNotes>) {
  const error = flags.some(([level]) => level === "error");
  if (flags.length > 0) {
    const Icon = error ? OctagonX : CircleAlert;
    return <Icon className={cn("size-3 shrink-0", error ? "text-cf-error-text" : "text-cf-warning-text")} aria-hidden data-testid="ti-project-mark" />;
  }
  return envChange !== null ? <Plug className="size-3 shrink-0" aria-hidden data-testid="ti-project-mark" /> : null;
}

/**
 * The cwd's project: its name (bold without a workspace row; "+N" when an unnamed set has
 * more), "Fresh copy" or "Project folder". It opens a menu: Add project (the composer's
 * multi-select list, anchored under the row: thread.project.add per pick), Save as
 * workspace for an unnamed set of two or more, then Run in with every member (a × takes one
 * out: thread.project.remove). Adding or removing a member takes the thread out of its
 * workspace (the daemon's rule): the crumb then reads "<cwd> +N". The thread's plugin flags
 * and a changed plugin environment mark the row, and show on hover.
 */
function ProjectRow({ threadId }: { threadId: string }) {
  const { cwdProjectId, members, paths } = useMembers(threadId);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const named = useWorkspacesStore((s) => workspaceId !== "" && s.byId[workspaceId] !== undefined);
  const worktreeMode = useThreadsStore((s) => s.byId[threadId]?.createdWorktree ?? false);
  const createdBranch = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t?.createdWorktree ? t.branch : "";
  });
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const name = useProjectsStore((s) => s.byId[cwdProjectId]?.name ?? cwdProjectId);
  const git = useProjectsStore((s) => s.byId[cwdProjectId]?.git ?? false);
  const cwdBranch = useProjectsStore((s) => s.byId[cwdProjectId]?.worktrees.find((w) => w.path === cwd)?.branch ?? "");
  const canSave = useCanSaveAsWorkspace(threadId);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const notes = useProjectNotes(threadId);
  // While the menu is up: each member's worktree the daemon would refuse a new thread on the branch in.
  const refusals = useProjectRefusals(members, createdBranch, open && members.length > 1);
  if (!cwdProjectId) return null;
  const noted = notes.flags.length > 0 || notes.envChange !== null;
  // The hover card wraps the row (outside a menu trigger, as Tip asks).
  const withNotes = (row: ReactElement) =>
    noted ? (
      <Tip label={<ProjectNotes {...notes} />} side="left">
        {row}
      </Tip>
    ) : (
      row
    );
  const more = moreProjects(members.length, named);
  const label = (
    <>
      <span className={cn(!named && "font-medium")}>{name}</span>
      {more && <span className="text-cf-text-muted"> {more}</span>}
    </>
  );
  const meta = (
    <>
      {noted && <NotesMark {...notes} />}
      {worktreeMode && git ? "Fresh copy" : "Project folder"}
    </>
  );
  const remove = (projectId: string) => {
    setOpen(false);
    void removeThreadProject(threadId, projectId);
  };
  return (
    <div className="relative flex flex-col">
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        {withNotes(
          <DropdownMenuTrigger asChild>
            <Row icon={<FolderOpen />} meta={meta} chevron={open || picking ? "open" : "closed"} testId="ti-project">
              {label}
            </Row>
          </DropdownMenuTrigger>,
        )}
        <RowMenu testId="ti-project-menu">
          <DropdownMenuItem
            data-testid="ti-add-project"
            onSelect={() => {
              // After the menu has let go of the keyboard, or the list would close as a focus outside.
              queueMicrotask(() => {
                setPicking(true);
              });
            }}
          >
            <Plus aria-hidden />
            Add project
          </DropdownMenuItem>
          {!named && members.length > 1 && (
            <DropdownMenuItem
              disabled={!canSave}
              data-testid="ti-save-workspace"
              onSelect={() => {
                openSaveWorkspace(threadId);
              }}
            >
              <Save aria-hidden />
              Save as workspace
            </DropdownMenuItem>
          )}
          {members.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="font-normal text-cf-text-muted">Run in</DropdownMenuLabel>
              {members.map((id) => (
                <RunInItem
                  key={id}
                  threadId={threadId}
                  projectId={id}
                  path={paths[id] ?? ""}
                  cwd={id === cwdProjectId}
                  cwdBranch={cwdBranch}
                  createdBranch={createdBranch}
                  refusal={refusals[id]}
                  onRemove={remove}
                />
              ))}
            </>
          )}
        </RowMenu>
      </DropdownMenu>
      <AddProjectPicker
        threadId={threadId}
        members={members}
        open={picking}
        onOpenChange={setPicking}
        anchor={<span className="pointer-events-none absolute inset-x-0 bottom-0 h-0" aria-hidden />}
      />
    </div>
  );
}

/** "Open in Finder": a click reveals the cwd; the chevron's menu offers Finder, the installed editors and a terminal. */
function OpenInRow({ threadId }: { threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const [open, setOpen] = useState(false);
  const editors = useEditorApps();
  if (!cwd) return null;
  const ctx = () => threadContext(threadId);
  const reveal = () => void runCommand("worktree.reveal", { worktree: cwd }, ctx());
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Row icon={<FinderMark />} chevron={open ? "open" : "closed"} onActivate={reveal} menuOnChevron testId="ti-open-in">
          Open in Finder
        </Row>
      </DropdownMenuTrigger>
      <RowMenu testId="ti-open-in-menu">
        <DropdownMenuItem onSelect={reveal} data-testid="ti-open-finder">
          <FinderMark aria-hidden />
          Finder
        </DropdownMenuItem>
        {editors.map((a) => (
          <DropdownMenuItem
            key={a.bundleId}
            data-testid="ti-open-editor"
            data-app={a.bundleId}
            onSelect={() => void runCommand("worktree.open.editor", { worktree: cwd, app: a.bundleId }, ctx())}
          >
            <Code aria-hidden />
            {a.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="ti-open-terminal"
          onSelect={() => {
            const key = bottomKeyOf({ kind: "thread", id: threadId });
            if (key !== null) void newBottomTerminal(key);
          }}
        >
          <SquareTerminal aria-hidden />
          Terminal
        </DropdownMenuItem>
      </RowMenu>
    </DropdownMenu>
  );
}

/** A menu item that runs an action for the thread. */
function ActionItem({ threadId, id }: { threadId: string; id: string }) {
  const action = useAction(id);
  if (!action) return null;
  const Icon = ACTION_ICON[action.icon];
  return (
    <DropdownMenuItem data-testid="ti-action-item" data-action={id} onSelect={() => void runCardAction(id, threadId)}>
      <Icon aria-hidden />
      <span className="min-w-0 truncate">{action.name}</span>
    </DropdownMenuItem>
  );
}

function ProjectName({ id }: { id: string }) {
  return <>{useProjectsStore((s) => s.byId[id]?.name ?? id)}</>;
}

/** "Add action": the editor for the project; in a workspace a submenu picks the project. */
function AddActionItems({ members }: { members: readonly string[] }) {
  if (members.length <= 1) {
    const only = members[0] ?? "";
    return (
      <DropdownMenuItem
        data-testid="ti-add-action"
        onSelect={() => {
          openActionEditor({ mode: "new", projectId: only, from: "thread" });
        }}
      >
        <Plus aria-hidden />
        Add action
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="ti-add-action" className="text-caption text-cf-text">
        <Plus aria-hidden />
        Add action
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent data-testid="ti-add-action-projects">
        {members.map((id) => (
          <DropdownMenuItem
            key={id}
            className="text-caption text-cf-text"
            onSelect={() => {
              openActionEditor({ mode: "new", projectId: id, from: "thread" });
            }}
          >
            <ProjectName id={id} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The action to run: the one last run in this thread (else the cwd's project's last, else
 * its first; lib/threadInfo chooseAction), by name, with its project on a second line when
 * that is not the cwd's. A click runs it; the chevron lists every action by project, then
 * Add action. With no actions at all: a muted "Add action" row.
 */
function ActionRow({ threadId }: { threadId: string }) {
  const { cwdProjectId, members } = useMembers(threadId);
  const { withActions, picks } = useActionPicks(threadId, members);
  const choice = useMemo(() => (picks ? chooseAction(picks, cwdProjectId) : null), [picks, cwdProjectId]);
  const byProject = useActionsStore(useShallow((s) => withActions.map((id) => (s.byProject[id] ?? []).join(","))));
  const [open, setOpen] = useState(false);
  const projectName = useProjectsStore((s) => (choice ? (s.byId[choice.action.projectId]?.name ?? "") : ""));
  if (members.length === 0) return null;
  if (withActions.length === 0) {
    if (members.length === 1) {
      return (
        <Row
          icon={<Plus />}
          onActivate={() => {
            openActionEditor({
              mode: "new",
              projectId: cwdProjectId,
              from: "thread",
            });
          }}
          testId="ti-add-action-row"
        >
          <span className="text-cf-text-muted">Add action</span>
        </Row>
      );
    }
    return (
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Row icon={<Plus />} testId="ti-add-action-row">
            <span className="text-cf-text-muted">Add action</span>
          </Row>
        </DropdownMenuTrigger>
        <RowMenu testId="ti-action-menu">
          <DropdownMenuLabel className="font-normal text-cf-text-muted">Add an action to</DropdownMenuLabel>
          {members.map((id) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => {
                openActionEditor({
                  mode: "new",
                  projectId: id,
                  from: "thread",
                });
              }}
            >
              <ProjectName id={id} />
            </DropdownMenuItem>
          ))}
        </RowMenu>
      </DropdownMenu>
    );
  }
  const action = choice?.action;
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Row
          icon={<Play />}
          tall={choice?.showProject}
          chevron={open ? "open" : "closed"}
          onActivate={action ? () => void runCardAction(action.id, threadId) : undefined}
          menuOnChevron={Boolean(action)}
          testId="ti-action"
          data-action={action?.id}
        >
          <span className="truncate">{action?.name ?? "Actions"}</span>
          {choice?.showProject && <SubLine testId="ti-action-project">{projectName}</SubLine>}
        </Row>
      </DropdownMenuTrigger>
      <RowMenu testId="ti-action-menu">
        {withActions.map((pid, i) => (
          <div key={pid} className="contents">
            {members.length > 1 && (
              <DropdownMenuLabel className="font-normal text-cf-text-muted" data-testid="ti-action-group">
                <ProjectName id={pid} />
              </DropdownMenuLabel>
            )}
            {(byProject[i] ?? "")
              .split(",")
              .filter(Boolean)
              .map((id) => (
                <ActionItem key={id} threadId={threadId} id={id} />
              ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <AddActionItems members={members} />
      </RowMenu>
    </DropdownMenu>
  );
}

/** The card's first group: the workspace, the cwd's project, Open in, and the action. */
export function PlaceGroup({ threadId }: { threadId: string }) {
  const has = useThreadsStore((s) => Boolean(s.byId[threadId]?.worktreePath));
  if (!has) return null;
  return (
    <Group testId="ti-place">
      <WorkspaceRow threadId={threadId} />
      <ProjectRow threadId={threadId} />
      <OpenInRow threadId={threadId} />
      <ActionRow threadId={threadId} />
    </Group>
  );
}
