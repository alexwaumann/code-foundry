import { useEffect } from "react";
import { Archive, ArchiveRestore, Eye, EyeOff, GitPullRequest, Layers } from "lucide-react";
import { ThreadActionsMenu } from "@/components/actions/ActionsMenu";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { prStateText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { SnoozeButton } from "@/components/snooze/SnoozeMenu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useSidebarShown } from "@/stores/lineage";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { showWorkspaceCard } from "@/stores/projectsPage";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { ThreadMenu } from "./ThreadMenu";

/**
 * The thread's only linked pull request: its state icon and "#number" in the state's
 * colour (the PR's cached detail, read and kept fresh like a Linked PRs row). A click opens
 * it as a tab of the thread's side panel, as a Linked PRs row does.
 */
function SingleLinkedPr({ threadId }: { threadId: string }) {
  const slug = useThreadsStore((s) => s.byId[threadId]?.linkedPullRequests[0]?.slug ?? "");
  const number = useThreadsStore((s) => s.byId[threadId]?.linkedPullRequests[0]?.number ?? 0);
  const key = pullRequestKey(slug, number);
  useEffect(() => pullRequestDetailResource.watch(key), [key]);
  const state = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.state ?? null);
  const draft = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.draft ?? false);
  const look = prStateLook(state, draft);
  const Icon = look.icon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn("gap-1 px-1.5 text-caption-sm font-medium tabular-nums", prStateText[look.tone])}
      tabIndex={-1}
      data-testid="pane-linked-pr"
      data-state={look.label}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={() => {
        openPullRequestInPanel({ slug, number });
      }}
    >
      <Icon className="size-3.5" aria-label={look.label} />#{number}
    </Button>
  );
}

/**
 * The thread's linked pull requests: one shows as that PR (SingleLinkedPr); two or more as
 * a muted count that opens the Linked PRs surface (view.panel.linked-prs); none, nothing.
 */
function LinkedPrs({ threadId }: { threadId: string }) {
  const count = useThreadsStore((s) => s.byId[threadId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  if (count === 1) return <SingleLinkedPr threadId={threadId} />;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} className="text-cf-text-muted" data-testid="pane-linked-prs" />;
}

/**
 * The referenced workspace by name, opening the Projects page with its card as the
 * cursor row (stores/projectsPage showWorkspaceCard, as after Add as workspace); only for
 * a thread that references a workspace the slice knows.
 */
function WorkspaceChip({ threadId }: { threadId: string }) {
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const name = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? "") : ""));
  if (!workspaceId || !name) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="min-w-0 gap-1.5 px-1.5 text-caption-sm text-cf-text-muted [&_svg]:size-3.5"
      tabIndex={-1}
      aria-label={`Workspace ${name}: show it on the Projects page`}
      data-testid="pane-workspace"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={() => {
        showWorkspaceCard(workspaceId);
      }}
    >
      <Layers aria-hidden />
      <span className="truncate">{name}</span>
    </Button>
  );
}

/**
 * thread.archive for this thread: Archive, or Unarchive (its own icon and tooltip) while
 * it is archived. Run without args, the command toggles; the daemon asks for confirmation
 * only while Claude is mid-turn.
 */
function ArchiveButton({ threadId }: { threadId: string }) {
  const archived = useThreadsStore((s) => (s.byId[threadId]?.archivedAtMs ?? null) !== null);
  return <CommandButton command="thread.archive" icon={archived ? ArchiveRestore : Archive} tooltip={archived ? "Unarchive Thread" : "Archive Thread"} />;
}

/**
 * thread.sidebar for a thread another thread created: "Hide from sidebar" (EyeOff) while
 * the rule shows it (lib/inSidebar.ts), "Show in sidebar" (Eye) while it is hidden. Run
 * without args, its presenter toggles (keys/bindings.ts). None on the user's own threads,
 * which are always shown.
 */
function SidebarButton({ threadId }: { threadId: string }) {
  const shown = useSidebarShown(threadId);
  if (shown === null) return null;
  return <CommandButton command="thread.sidebar" icon={shown ? EyeOff : Eye} tooltip={shown ? "Hide from sidebar" : "Show in sidebar"} data-testid="pane-sidebar" />;
}

/**
 * The thread header's right side: the workspace, the linked pull requests, then the
 * thread's commands (its "More" menu among them: ThreadMenu) and the window's, run against the current selection (this thread) exactly
 * as the palette runs them. Each command button hides when the daemon does not list it as
 * available.
 */
export function HeaderActions({ threadId }: { threadId: string }) {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <WorkspaceChip threadId={threadId} />
      <LinkedPrs threadId={threadId} />
      <SnoozeButton threadId={threadId} />
      <SidebarButton threadId={threadId} />
      <ArchiveButton threadId={threadId} />
      <ThreadMenu threadId={threadId} />
      <ThreadActionsMenu threadId={threadId} />
      <BottomToggle />
      <PanelToggle />
    </span>
  );
}
