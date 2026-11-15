import { useCallback, useEffect } from "react";
import { Composer } from "@/components/compose/Composer";
import { draftKey, type ComposeTarget } from "@/lib/compose";
import { composerTextChanged, usePendingDraft } from "@/shell/composerDrafts";
import { composeSelectionOf } from "@/stores/selectionBridge";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { TabEntry } from "@/stores/layout";

/**
 * The new-thread composer of a compose tab, for what its params say it starts from (project,
 * workspace, like; none: home). A draft tab's text is its own (its `draft` param, or the one being
 * started for it); what the user types starts, relabels and clears the draft (shell/composerDrafts.ts).
 */
export function ComposeTab({ tab }: { tab: TabEntry }) {
  const likeProject = useThreadsStore((s) => (tab.params.like ? (s.byId[tab.params.like]?.projectId ?? "") : ""));
  const firstMember = useWorkspacesStore((s) => (tab.params.workspace ? (s.byId[tab.params.workspace]?.members[0]?.projectId ?? "") : ""));
  const pending = usePendingDraft(tab.id);
  const draft = tab.params.draft || pending;
  const sel = composeSelectionOf(tab.params, { likeProject, firstMember });
  const target: ComposeTarget = sel.likeThreadId
    ? { kind: "like", threadId: sel.likeThreadId }
    : sel.workspaceId
      ? { kind: "workspace", workspaceId: sel.workspaceId }
      : sel.noProject
        ? { kind: "home" }
        : { kind: "project", projectId: sel.projectId };
  const targetKey = draftKey(target);
  const onTextChange = useCallback(() => {
    composerTextChanged(tab.id, draft, targetKey);
  }, [tab.id, draft, targetKey]);
  // Text already there when the tab shows its empty composer (a heading pick in a space with no
  // pane moved it here) is a draft, as if typed here. Not No project's: its welcome prefill is not
  // the user's text.
  const home = target.kind === "home";
  useEffect(() => {
    if (!draft && !home) composerTextChanged(tab.id, "", targetKey);
  }, [tab.id, draft, home, targetKey]);
  return (
    <Composer
      key={sel.likeThreadId ? `like:${sel.likeThreadId}` : sel.workspaceId ? `ws:${sel.workspaceId}` : sel.noProject ? "home:" : sel.projectId}
      projectId={sel.projectId}
      workspaceId={sel.workspaceId}
      noProject={sel.noProject}
      likeThreadId={sel.likeThreadId}
      draftId={draft || undefined}
      onTextChange={onTextChange}
      tabId={tab.id}
    />
  );
}
