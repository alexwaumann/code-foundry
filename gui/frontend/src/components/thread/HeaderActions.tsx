import { GitFork, GitPullRequest, Layers, Pencil, Power } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { CommandButton } from "@/components/command/CommandButton";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { useSessionsStore } from "@/stores/sessions";

/** view.panel.linked-prs with the thread's link count; only once the thread has linked a pull request. */
function LinkedPrsButton({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => s.byId[sessionId]?.linkedPullRequests.length ?? 0);
  if (count === 0) return null;
  return <CommandButton command="view.panel.linked-prs" icon={GitPullRequest} count={count} data-testid="pane-linked-prs" />;
}

/**
 * The thread header's commands, run against the current selection (this thread) exactly
 * as the palette runs them. Each hides when the daemon does not list it as available.
 */
export function HeaderActions({ sessionId }: { sessionId: string }) {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <CommandButton command="session.rename" icon={Pencil} />
      <CommandButton command="session.fork" icon={GitFork} />
      <CommandButton command="session.close" icon={Power} />
      <LinkedPrsButton sessionId={sessionId} />
      {/* Only listed for a workspace thread (view.panel.workspace's availability). */}
      <CommandButton command="view.panel.workspace" icon={Layers} data-testid="pane-workspace" />
      <BottomToggle />
      <PanelToggle />
    </span>
  );
}
