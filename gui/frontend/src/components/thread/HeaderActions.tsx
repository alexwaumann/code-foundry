import { useEffect } from "react";
import { Archive, ArchiveRestore, GitPullRequest, Layers, Power } from "lucide-react";
import { ThreadActionsMenu } from "@/components/actions/ActionsMenu";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { SnoozeButton } from "@/components/snooze/SnoozeMenu";
import { prStateLook, type PrStateTone } from "@/components/prs/prState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";

/** The header's PR colours: the PR lists' tones, darker in light mode for contrast. */
const toneClass: Record<PrStateTone, string> = {
  emerald: "text-emerald-600 dark:text-emerald-400",
  violet: "text-violet-600 dark:text-violet-400",
  red: "text-red-600 dark:text-red-400",
  muted: "text-muted-foreground",
};

/**
 * The thread's only linked pull request: its state icon and "#number" in the state's
 * colour (the PR's cached detail, read and kept fresh like a Linked PRs row). A click opens
 * it as a tab of the thread's side panel, as a Linked PRs row does.
 */
function SingleLinkedPr({ sessionId }: { sessionId: string }) {
  const slug = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests[0]?.slug ?? "");
  const number = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests[0]?.number ?? 0);
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
      className={cn("gap-1 px-1.5 text-[11.5px] font-medium tabular-nums", toneClass[look.tone])}
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
function LinkedPrs({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  if (count === 1) return <SingleLinkedPr sessionId={sessionId} />;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} className="text-muted-foreground" data-testid="pane-linked-prs" />;
}

/** The owning workspace by name, opening its surface (view.panel.workspace); only listed for a workspace thread. */
function WorkspaceChip({ sessionId }: { sessionId: string }) {
  const workspaceId = useSessionsStore((s) => s.byId[sessionId]?.workspaceId ?? "");
  // A workspace the slice does not know (older daemon, or just removed) shows its id, like the sidebar badge.
  const name = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? workspaceId) : ""));
  if (!workspaceId) return null;
  return (
    <CommandButton
      command="view.panel.workspace"
      icon={Layers}
      label={name}
      size="xs"
      className="min-w-0 gap-1.5 px-1.5 text-[11.5px] font-normal text-muted-foreground [&_svg]:size-3.5"
      data-testid="pane-workspace"
    />
  );
}

/**
 * session.archive for this thread: Archive, or Unarchive (its own icon and tooltip) while
 * it is archived. Run without args, the command toggles; the daemon asks for confirmation
 * only while Claude is mid-turn.
 */
function ArchiveButton({ sessionId }: { sessionId: string }) {
  const archived = useSessionsStore((s) => (s.byId[sessionId]?.archivedAtMs ?? null) !== null);
  return <CommandButton command="session.archive" icon={archived ? ArchiveRestore : Archive} title={archived ? "Unarchive Thread" : "Archive Thread"} />;
}

/**
 * The thread header's right side: the workspace, the linked pull requests, then the
 * thread's and window's commands, run against the current selection (this thread) exactly
 * as the palette runs them. Each command button hides when the daemon does not list it as
 * available.
 */
export function HeaderActions({ sessionId }: { sessionId: string }) {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <WorkspaceChip sessionId={sessionId} />
      <LinkedPrs sessionId={sessionId} />
      <CommandButton command="session.close" icon={Power} />
      <SnoozeButton sessionId={sessionId} />
      <ArchiveButton sessionId={sessionId} />
      <ThreadActionsMenu sessionId={sessionId} />
      <BottomToggle />
      <PanelToggle />
    </span>
  );
}
