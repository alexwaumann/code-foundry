import { Composer } from "@/components/compose/Composer";
import { composeSelectionOf } from "@/stores/selectionBridge";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { TabEntry } from "@/stores/layout";

/** The new-thread composer of a compose tab, for what its params say it starts from (project, workspace, like; none: home). */
export function ComposeTab({ tab }: { tab: TabEntry }) {
  const likeProject = useThreadsStore((s) => (tab.params.like ? (s.byId[tab.params.like]?.projectId ?? "") : ""));
  const firstMember = useWorkspacesStore((s) => (tab.params.workspace ? (s.byId[tab.params.workspace]?.members[0]?.projectId ?? "") : ""));
  const sel = composeSelectionOf(tab.params, { likeProject, firstMember });
  return (
    <Composer
      key={sel.likeThreadId ? `like:${sel.likeThreadId}` : sel.workspaceId ? `ws:${sel.workspaceId}` : sel.noProject ? "home:" : sel.projectId}
      projectId={sel.projectId}
      workspaceId={sel.workspaceId}
      noProject={sel.noProject}
      likeThreadId={sel.likeThreadId}
    />
  );
}
