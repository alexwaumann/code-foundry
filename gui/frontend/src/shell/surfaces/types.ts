/**
 * One kind of tab in the window shell (docs/notes/shell-plan.md 2.7): what its strip shows and
 * the body its pane mounts. A kind is one file under src/shell/surfaces listed in registry.ts;
 * the pane and its strip look surfaces up by kind and never switch on it.
 */
import type { ComponentType, ReactNode } from "react";
import type { TabEntry } from "@/stores/layout";

export interface ShellSurface {
  /** A layout kind (internal/layout identity.go): thread, diff, file, pullrequest, prs, projects, compose, mcp, gallery, ember.board; plugin kinds are matched by prefix. */
  kind: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /** The tab's name, kept current (a hook): a thread's comes from the thread, looked up by id. */
  useTitle: (tab: TabEntry) => string;
  /**
   * The body. A pane mounts it only while the tab is the pane's active tab, under key={tab.id}:
   * a tab that is not showing holds no stream.
   */
  render: (tab: TabEntry) => ReactNode;
  /** An icon that follows the tab (a terminal's: what runs in it); drawn instead of `icon`. */
  TabIcon?: ComponentType<{ tab: TabEntry; className?: string }>;
  /** The items of the tab's context menu (ContextMenuItems); no menu without it. */
  tabMenu?: (tab: TabEntry) => ReactNode;
  /**
   * A kind that can belong to a thread: the noun of the row under the strip of a linked tab
   * ("Diff" of ● thread, components/shell/LinkedRow.tsx) and of the tab's hover.
   */
  linkedNoun?: string;
  /**
   * The right end of the row under a linked tab's strip, beside the link: a terminal's
   * "directory differs · Reset" hint (PR 13). Nothing when absent.
   */
  linkedRowEnd?: (tab: TabEntry) => ReactNode;
  /** A hook: the tab's thread needs the user, which its strip marks with the attention dot on the icon. */
  useAttention?: (tab: TabEntry) => boolean;
  /** A hook: the tab holds unsaved work (a File tab editing), which its strip marks with a dot. */
  useUnsaved?: (tab: TabEntry) => boolean;
  /** Asked before the user closes the tab (cmd+w, its ×, its pane); false keeps it open (shell/closeTab.ts). */
  beforeClose?: (tab: TabEntry) => true | Promise<boolean>;
}
