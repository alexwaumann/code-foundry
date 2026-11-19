/**
 * What dropping a thread does under Threads open as Panes or Single, in words: the drop
 * preview's label and the screen reader's phrase say whether it replaces a pane's thread or
 * opens beside it (docs/notes/threads-open-as-2-gui.md; the rules are the daemon's,
 * docs/notes/threads-open-as-1-rules.md "Entry points").
 */
import { threadLikeSource, type DragScene, type DragSource, type DropTarget } from "./targets";

export type ModeDrop = { kind: "replace"; name: string } | { kind: "beside" };

/**
 * What the drop of `source` on `target` does under the scene's mode; null under Tabs and for
 * anything that is not a thread (a pane, another tab), whose drop moves it as it always has.
 * On a thread pane (its middle or row) a thread replaces that pane's thread. On a pane of other
 * tabs it opens beside it under Panes, and under Single replaces the space's thread pane's thread
 * (beside when the space has none). An edge opens it beside (Panes; Single offers none).
 */
export function modeDrop(scene: Pick<DragScene, "modes">, source: DragSource, target: DropTarget): ModeDrop | null {
  const m = scene.modes;
  if (!m || !threadLikeSource(scene, source)) return null;
  if (target.kind === "outer" || target.kind === "edge") return { kind: "beside" };
  const name = m.threadPanes[target.pane];
  if (name !== undefined) return { kind: "replace", name };
  const shown = m.mode === "single" && m.target ? m.threadPanes[m.target] : undefined;
  return shown !== undefined ? { kind: "replace", name: shown } : { kind: "beside" };
}

/** The drop preview's label. */
export function modeDropLabel(d: ModeDrop): string {
  return d.kind === "replace" ? `Replace ${d.name}` : "Open beside";
}

/** After the target in "… is over <target>": what letting go does. */
export function modeDropOver(d: ModeDrop): string {
  return d.kind === "replace" ? `dropping replaces ${d.name}` : "dropping opens it beside";
}

/** After the target in "… was dropped on <target>": what it did. */
export function modeDropDone(d: ModeDrop): string {
  return d.kind === "replace" ? `it replaced ${d.name}` : "it opened beside";
}
