import { createElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { pluginIcon } from "@/components/plugin/icons";
import { dropdownMenuKit, type MenuKit } from "@/components/thread/menuKit";
import { DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { spaceTabs, type LinkedAction } from "@/shell/linked";
import { pluginSurfaceAction } from "@/shell/plusPlugins";
import { useLayoutStore } from "@/stores/layout";
import { surfaceManifestOf, usePluginsStore } from "@/stores/plugins";
import { useListedSurfaceKinds, useShowCommands } from "./usePluginSurfaces";

/** One surface: its manifest icon and title, its plugin's name muted at the right end ("· open" when its tab is). */
function PluginSurfaceRow({ kind, kit, open = false, onPick }: { kind: string; kit: MenuKit; open?: boolean; onPick: (showCommand: string) => void }) {
  const m = usePluginsStore(
    useShallow((s) => {
      const x = surfaceManifestOf(kind, s);
      return x ? { title: x.title || x.id, icon: x.icon, plugin: x.pluginDisplayName || x.plugin, show: x.showCommand } : null;
    }),
  );
  if (!m) return null;
  return (
    <kit.Item
      data-testid="plugin-surface-item"
      data-kind={kind}
      data-open={open ? "" : undefined}
      onSelect={() => {
        onPick(m.show);
      }}
    >
      {createElement(pluginIcon(m.icon), { "aria-hidden": true })}
      <span className="truncate">{m.title}</span>
      <span className="ml-auto pl-4 text-caption text-cf-text-muted">{open ? `${m.plugin} · open` : m.plugin}</span>
    </kit.Item>
  );
}

/**
 * A thread's plugin surface in its Open ▸ and the "+" menu's thread submenu: one already open in
 * the space is marked and focused where it is; another opens linked to the thread, in `pane` (the
 * "+" menu's) or by the placement rules.
 */
export function ThreadPluginItem({ kind, threadId, spaceId, pane, kit, onPick }: { kind: string; threadId: string; spaceId: string; pane: string; kit: MenuKit; onPick: (a: LinkedAction) => void }) {
  const openTab = useLayoutStore((s) => spaceTabs(s, spaceId).find((t) => t.kind === kind && t.thread === threadId)?.id ?? "");
  return (
    <PluginSurfaceRow
      kind={kind}
      kit={kit}
      open={openTab !== ""}
      onPick={(showCommand) => {
        onPick(pluginSurfaceAction({ showCommand }, { pane, thread: threadId, openTab }));
      }}
    />
  );
}

/**
 * The "+" menu's Plugins list: after a separator and a quiet label, each surface that is no
 * thread's and can show here; a pick opens it in this pane. Nothing, not even the label, when
 * there is none.
 */
export function PlusPluginItems({ paneId, pick }: { paneId: string; pick: (a: LinkedAction) => void }) {
  const kinds = useListedSurfaceKinds(false, useShowCommands());
  if (kinds.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-caption text-cf-text-muted">Plugins</DropdownMenuLabel>
      {kinds.map((kind) => (
        <PluginSurfaceRow
          key={kind}
          kind={kind}
          kit={dropdownMenuKit}
          onPick={(showCommand) => {
            pick(pluginSurfaceAction({ showCommand }, { pane: paneId }));
          }}
        />
      ))}
    </>
  );
}
