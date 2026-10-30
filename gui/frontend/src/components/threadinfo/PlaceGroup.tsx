import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Code, FolderOpen, Layers, Play, Plus, Save, SquareTerminal } from "lucide-react";
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
import { chooseAction, moreProjects } from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { runAction, type ActionOwner } from "@/stores/actionActions";
import { openActionEditor } from "@/stores/actionDialog";
import { useAction, useActionsStore } from "@/stores/actions";
import { bottomKeyOf } from "@/stores/bottomPanel";
import { newBottomTerminal } from "@/stores/bottomActions";
import { runCommand } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useActionPicks, useEditorApps } from "@/stores/threadInfo";
import { runThreadIn, threadContext } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Group, Row, RowMenu, SubLine } from "./Row";
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

/** One "Run in" item: the member's name, a tick on the cwd, its branch when it differs from the cwd's. */
function RunInItem({ threadId, projectId, path, cwd, cwdBranch }: { threadId: string; projectId: string; path: string; cwd: boolean; cwdBranch: string }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.path === path)?.branch ?? "");
  return (
    <DropdownMenuItem
      data-testid="ti-runin-item"
      data-project={projectId}
      data-current={cwd ? "" : undefined}
      onSelect={() => {
        if (!cwd) void runThreadIn(threadId, projectId);
      }}
    >
      {cwd ? <Check className="text-cf-link" aria-hidden /> : <span className="size-4 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">
        {name}
        {!cwd && branch && branch !== cwdBranch && (
          <span className="text-cf-text-muted">
            {" @ "}
            <span className="text-code">{branch}</span>
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * The cwd's project: its name (bold without a workspace row; "+N" when an unnamed set has
 * more), "Fresh copy" or "Project folder". With several projects it opens a menu: Add
 * project and Save as workspace (placeholders until the card's PR 4), then Run in.
 */
function ProjectRow({ threadId }: { threadId: string }) {
  const { cwdProjectId, members, paths } = useMembers(threadId);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const named = useWorkspacesStore((s) => workspaceId !== "" && s.byId[workspaceId] !== undefined);
  const worktreeMode = useThreadsStore((s) => s.byId[threadId]?.createdWorktree ?? false);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const name = useProjectsStore((s) => s.byId[cwdProjectId]?.name ?? cwdProjectId);
  const git = useProjectsStore((s) => s.byId[cwdProjectId]?.git ?? false);
  const cwdBranch = useProjectsStore((s) => s.byId[cwdProjectId]?.worktrees.find((w) => w.path === cwd)?.branch ?? "");
  const [open, setOpen] = useState(false);
  if (!cwdProjectId) return null;
  const more = moreProjects(members.length, named);
  const label = (
    <>
      <span className={cn(!named && "font-medium")}>{name}</span>
      {more && <span className="text-cf-text-muted"> {more}</span>}
    </>
  );
  const meta = worktreeMode && git ? "Fresh copy" : "Project folder";
  if (members.length <= 1) {
    return (
      <Row icon={<FolderOpen />} meta={meta} testId="ti-project">
        {label}
      </Row>
    );
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Row icon={<FolderOpen />} meta={meta} chevron={open ? "open" : "closed"} testId="ti-project">
          {label}
        </Row>
      </DropdownMenuTrigger>
      <RowMenu testId="ti-project-menu">
        <DropdownMenuItem disabled data-testid="ti-add-project">
          <Plus aria-hidden />
          Add project
        </DropdownMenuItem>
        {!named && (
          <DropdownMenuItem disabled data-testid="ti-save-workspace">
            <Save aria-hidden />
            Save as workspace
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-normal text-cf-text-muted">Run in</DropdownMenuLabel>
        {members.map((id) => (
          <RunInItem key={id} threadId={threadId} projectId={id} path={paths[id] ?? ""} cwd={id === cwdProjectId} cwdBranch={cwdBranch} />
        ))}
      </RowMenu>
    </DropdownMenu>
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

/**
 * Who runs an action from the card: the thread for its cwd's project; another member's
 * action runs in that member's checkout (the daemon runs a thread's actions in its cwd's
 * project only), like a Projects page row's.
 */
function ownerFor(threadId: string, projectId: string, cwdProjectId: string, paths: Readonly<Record<string, string>>): ActionOwner {
  const path = paths[projectId] ?? "";
  return projectId === cwdProjectId || !path ? { kind: "thread", threadId } : { kind: "worktree", projectId, path };
}

/** A menu item that runs an action for the thread. */
function ActionItem({ owner, id }: { owner: (projectId: string) => ActionOwner; id: string }) {
  const action = useAction(id);
  if (!action) return null;
  const Icon = ACTION_ICON[action.icon];
  return (
    <DropdownMenuItem data-testid="ti-action-item" data-action={id} onSelect={() => void runAction(id, owner(action.projectId))}>
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
  const { cwdProjectId, members, paths } = useMembers(threadId);
  const owner = (projectId: string) => ownerFor(threadId, projectId, cwdProjectId, paths);
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
          onActivate={action ? () => void runAction(action.id, owner(action.projectId)) : undefined}
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
                <ActionItem key={id} owner={owner} id={id} />
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
