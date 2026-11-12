import { useMemo } from "react";
import { GitPullRequest, LayoutGrid, Plus, SquareTerminal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { moveToSpaceAction, newTerminalAction, spaceChoices, spaceTabs, surfaceAction, threadSurfaces, type LinkedAction, type ThreadSurfaceItem } from "@/shell/linked";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useLayoutStore, useTab } from "@/stores/layout";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0001";

/** A thread's surfaces in a space (shell/linked.ts threadSurfaces), from narrow selectors. */
function useThreadSurfaces(threadId: string, spaceId: string) {
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const names = useProjectsStore(useShallow((s) => projectIds.map((id) => s.byId[id]?.name ?? id)));
  // Newest linked first, as the sidebar's tag and the card list them.
  const prs = useThreadsStore(useShallow((s) => [...(s.byId[threadId]?.linkedPullRequests ?? [])].reverse().map((l) => l.slug + SEP + String(l.number))));
  const tabs = useLayoutStore(useShallow((s) => spaceTabs(s, spaceId)));
  return useMemo(() => {
    const checkouts = projectIds.map((projectId, i) => ({ projectId, path: paths[projectId] ?? "", name: names[i] ?? projectId }));
    const links = prs.map((k) => {
      const [slug = "", n = "0"] = k.split(SEP);
      return { slug, number: Number(n) };
    });
    return threadSurfaces(threadId, checkouts, links, tabs);
  }, [threadId, projectIds, paths, names, prs, tabs]);
}

/** The "open" mark of an item whose tab is open in the space: picking it focuses that tab where it is. */
function OpenMark({ open }: { open: boolean }) {
  return open ? <span className="ml-auto pl-4 text-caption text-cf-text-muted">open</span> : null;
}

/** A terminal tab's name, as its strip names it. */
function TerminalName({ tabId }: { tabId: string }) {
  const tab = useTab(tabId);
  const title = shellSurfaceOf("terminal").useTitle(tab ?? { id: tabId, kind: "terminal", thread: "", key: "", params: {}, title: "", name: "", paneId: "" });
  return <span className="truncate">{title === "terminal" ? "Terminal" : title}</span>;
}

function SurfaceItem({ item, onPick }: { item: ThreadSurfaceItem; onPick: () => void }) {
  const Icon = item.kind === "pullrequest" ? GitPullRequest : item.kind === "terminal" ? SquareTerminal : shellSurfaceOf("diff").icon;
  return (
    <DropdownMenuItem onSelect={onPick} data-testid="thread-surface-item" data-kind={item.kind} data-key={item.key} data-open={item.openTab ? "" : undefined}>
      <Icon className={item.kind === "pullrequest" ? "text-cf-success-text" : undefined} />
      {item.kind === "terminal" ? <TerminalName tabId={item.tabId} /> : <span className="truncate">{item.label}</span>}
      <OpenMark open={item.openTab !== ""} />
    </DropdownMenuItem>
  );
}

/**
 * A thread's surfaces, the items of its header's Open ▸ and of the "+" menu's thread submenu
 * (docs/notes/shell-model.md): its diff of each checkout and its pull requests, each marked
 * "open" when its tab is open in the space; then its terminal tabs there and New terminal tab.
 * Picking an open one focuses it where it is; another opens in `pane` (the "+" menu's) or, with
 * none, by the placement rules (shell/linked.ts surfaceAction). `onPick` runs the action.
 */
export function ThreadSurfaceItems({ threadId, spaceId, pane = "", onPick }: { threadId: string; spaceId: string; pane?: string; onPick: (a: LinkedAction) => void }) {
  const { diffs, prs, terminals } = useThreadSurfaces(threadId, spaceId);
  const views = [...diffs, ...prs];
  return (
    <>
      {views.map((item) => (
        <SurfaceItem
          key={item.key}
          item={item}
          onPick={() => {
            onPick(surfaceAction(threadId, item, pane));
          }}
        />
      ))}
      {views.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-caption text-cf-text-muted">Terminals</DropdownMenuLabel>
      {terminals.map((item) => (
        <SurfaceItem
          key={item.key}
          item={item}
          onPick={() => {
            onPick(surfaceAction(threadId, item, pane));
          }}
        />
      ))}
      <DropdownMenuItem
        data-testid="thread-surface-new-terminal"
        onSelect={() => {
          onPick(newTerminalAction(threadId, pane));
        }}
      >
        <Plus />
        New terminal tab
      </DropdownMenuItem>
    </>
  );
}

/**
 * Move to space ▸: the spaces in the top bar's order, the thread's own marked "here" and
 * disabled. Until the top bar (PR 15) there is one space, and the submenu shows it anyway.
 */
export function MoveToSpaceItems({ threadId, onPick }: { threadId: string; onPick: (a: LinkedAction) => void }) {
  const spaces = useLayoutStore(useShallow((s) => spaceChoices(s, threadId).map((c) => [c.id, c.name, c.here ? "1" : ""].join(SEP))));
  return (
    <>
      {spaces.map((k) => {
        const [id = "", name = "", here = ""] = k.split(SEP);
        return (
          <DropdownMenuItem
            key={id}
            disabled={here !== ""}
            data-testid="move-to-space-item"
            data-space-id={id}
            onSelect={() => {
              onPick(moveToSpaceAction(threadId, id));
            }}
          >
            <LayoutGrid />
            <span className="truncate">{name}</span>
            {here && <span className="ml-auto pl-4 text-caption text-cf-text-muted">here</span>}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
