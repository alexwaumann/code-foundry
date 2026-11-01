/**
 * The MCP surface's chosen tab (Connected / Failed / Disabled, lib/mcp McpBucket) per
 * panel key (docs/notes/mcp-panel-tabs.md). Kept while that panel holds its MCP tab, so
 * each thread's panel remembers its own choice; dropped once the MCP tab closes, so it
 * reopens on Connected. In memory only: a reload starts on Connected too.
 */
import { create } from "zustand";
import type { McpBucket } from "@/lib/mcp";
import { MCP_KIND } from "@/surfaces/mcpTarget";
import { allTabs, usePanelStore, type PanelState } from "./panel";

interface McpTabsState {
  /** By panel key; absent means Connected. */
  byKey: Readonly<Record<string, McpBucket>>;
}

export const useMcpTabsStore = create<McpTabsState>()(() => ({ byKey: {} }));

export const MCP_DEFAULT_BUCKET: McpBucket = "connected";

/** The panel's chosen MCP tab (Connected until one is chosen). */
export function useMcpTab(panelKey: string): McpBucket {
  return useMcpTabsStore((s) => s.byKey[panelKey] ?? MCP_DEFAULT_BUCKET);
}

export function setMcpTab(panelKey: string, bucket: McpBucket): void {
  useMcpTabsStore.setState((s) => (s.byKey[panelKey] === bucket ? s : { byKey: { ...s.byKey, [panelKey]: bucket } }));
}

/** Drops the choice of every panel that no longer holds an MCP tab. */
export function pruneClosedMcpTabs(panels: PanelState): void {
  const byKey = useMcpTabsStore.getState().byKey;
  const keys = Object.keys(byKey);
  if (keys.length === 0) return;
  const holds = (key: string) => {
    const e = panels.byKey[key];
    return e !== undefined && allTabs(e).some((t) => t.kind === MCP_KIND);
  };
  if (keys.every(holds)) return;
  useMcpTabsStore.setState({ byKey: Object.fromEntries(Object.entries(byKey).filter(([k]) => holds(k))) });
}

usePanelStore.subscribe((s, prev) => {
  if (s.byKey !== prev.byKey) pruneClosedMcpTabs(s);
});
