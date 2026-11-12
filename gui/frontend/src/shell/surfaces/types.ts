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
}
