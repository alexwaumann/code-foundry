import { useMemo } from "react";
import { GitPullRequest, Plus, SquareTerminal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { dropdownMenuKit, type MenuKit } from "@/components/thread/menuKit";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { moveToSpaceAction, newTerminalAction, spaceChoices, spaceTabs, surfaceAction, threadSurfaces, type LinkedAction, type ThreadSurfaceItem } from "@/shell/linked";
import { moveToNewSpace } from "@/shell/spaceActions";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useLayoutStore, useTab } from "@/stores/layout";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { SpaceIcon } from "./SpaceIcon";

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

const NO_TAB = { kind: "terminal", thread: "", key: "", params: {}, title: "", name: "", paneId: "" };

/** A terminal tab's icon and name, as its strip draws them (the terminal surface's: what runs in it). */
function TerminalTabLabel({ tabId }: { tabId: string }) {
  const tab = useTab(tabId) ?? { ...NO_TAB, id: tabId };
  const surface = shellSurfaceOf("terminal");
  const title = surface.useTitle(tab);
  const Icon = surface.TabIcon;
  return (
    <>
      {Icon ? <Icon tab={tab} /> : <SquareTerminal />}
      <span className="truncate">{title}</span>
    </>
  );
}

function SurfaceItem({ item, kit, onPick }: { item: ThreadSurfaceItem; kit: MenuKit; onPick: () => void }) {
  const Icon = item.kind === "pullrequest" ? GitPullRequest : shellSurfaceOf("diff").icon;
  return (
    <kit.Item onSelect={onPick} data-testid="thread-surface-item" data-kind={item.kind} data-key={item.key} data-open={item.openTab ? "" : undefined}>
      {item.kind === "terminal" ? (
        <TerminalTabLabel tabId={item.tabId} />
      ) : (
        <>
          <Icon className={item.kind === "pullrequest" ? "text-cf-success-text" : undefined} />
          <span className="truncate">{item.label}</span>
        </>
      )}
      <OpenMark open={item.openTab !== ""} />
    </kit.Item>
  );
}

/**
 * A thread's surfaces, the items of its header's Open ▸ and of the "+" menu's thread submenu
 * (docs/notes/shell-model.md): its diff of each checkout and its pull requests, each marked
 * "open" when its tab is open in the space; then its terminal tabs there and New terminal tab.
 * Picking an open one focuses it where it is; another opens in `pane` (the "+" menu's) or, with
 * none, by the placement rules (shell/linked.ts surfaceAction), which open a closed thread's in the
 * focused pane. `onPick` runs the action. `kit` is the menu's parts: a dropdown's (the header, the
 * "+") or a context menu's (the sidebar row).
 */
export function ThreadSurfaceItems({
  threadId,
  spaceId,
  pane = "",
  kit = dropdownMenuKit,
  onPick,
}: {
  threadId: string;
  spaceId: string;
  pane?: string;
  kit?: MenuKit;
  onPick: (a: LinkedAction) => void;
}) {
  const { diffs, prs, terminals } = useThreadSurfaces(threadId, spaceId);
  const views = [...diffs, ...prs];
  return (
    <>
      {views.map((item) => (
        <SurfaceItem
          key={item.key}
          item={item}
          kit={kit}
          onPick={() => {
            onPick(surfaceAction(threadId, item, pane));
          }}
        />
      ))}
      {views.length > 0 && <kit.Separator />}
      <kit.Label className="text-caption text-cf-text-muted">Terminals</kit.Label>
      {terminals.map((item) => (
        <SurfaceItem
          key={item.key}
          item={item}
          kit={kit}
          onPick={() => {
            onPick(surfaceAction(threadId, item, pane));
          }}
        />
      ))}
      <kit.Item
        data-testid="thread-surface-new-terminal"
        onSelect={() => {
          onPick(newTerminalAction(threadId, pane));
        }}
      >
        <Plus />
        New terminal tab
      </kit.Item>
    </>
  );
}

/**
 * Move to space ▸: the spaces in the top bar's order, each with its layout glyph, the thread's own
 * marked "here" and disabled; then New space, which makes one (without showing it) and moves the
 * thread there. thread.space.move takes the thread's linked tabs in its space along.
 */
export function MoveToSpaceItems({ threadId, kit = dropdownMenuKit, onPick }: { threadId: string; kit?: MenuKit; onPick: (a: LinkedAction) => void }) {
  const spaces = useLayoutStore(useShallow((s) => spaceChoices(s, threadId).map((c) => [c.id, c.name, c.here ? "1" : ""].join(SEP))));
  return (
    <>
      {spaces.map((k) => {
        const [id = "", name = "", here = ""] = k.split(SEP);
        return (
          <kit.Item
            key={id}
            disabled={here !== ""}
            data-testid="move-to-space-item"
            data-space-id={id}
            onSelect={() => {
              onPick(moveToSpaceAction(threadId, id));
            }}
          >
            <SpaceIcon spaceId={id} />
            <span className="truncate">{name}</span>
            {here && <span className="ml-auto pl-4 text-caption text-cf-text-muted">here</span>}
          </kit.Item>
        );
      })}
      <kit.Separator />
      <kit.Item
        data-testid="move-to-new-space"
        onSelect={() => {
          void moveToNewSpace(threadId);
        }}
      >
        <Plus />
        New space
      </kit.Item>
    </>
  );
}
