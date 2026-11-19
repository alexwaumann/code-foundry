/**
 * What the top bar's controls run (docs/notes/shell-model.md, "Structure"): each is a layout verb
 * (internal/command commands_space.go, commands_layout_threads.go, commands_tab.go,
 * commands_pane.go), invoked from the window as a key or the palette would.
 * See docs/notes/shell-15-spaces.md.
 */
import { guardRemoveSpaceArchive } from "@/stores/fileEditGuards";
import { notify } from "@/lib/notify";
import { errorMessage } from "@/api/stream";
import { invokeConfirmed, runCommandForResult, type CommandSource } from "@/stores/commands";
import { getUiContext } from "@/stores/context";
import { useLayoutStore } from "@/stores/layout";
import { requestPaneFocus } from "@/stores/shellView";
import { afterRev, runLayoutCommand, type LayoutCommandResult } from "./commands";
import { resolveStep, type DropStep } from "./drag/groupDrop";
import { removeSpaceArgs, spaceAtIndex, type RemoveChoice } from "./spaces";

/** The keyboard goes into the current space's focused pane. */
function keyboardIntoFocusedPane(): void {
  const s = useLayoutStore.getState();
  const pane = s.spaces[s.currentSpaceId]?.focus ?? "";
  if (pane) requestPaneFocus(pane);
}

/** After a commit that showed another space, the keyboard goes into its focused pane. */
async function keyboardInto(res: LayoutCommandResult | null): Promise<void> {
  if (!res) return;
  await afterRev(res.rev);
  keyboardIntoFocusedPane();
}

/** Shows a space (space.switch), the keyboard following into its focused pane. */
export async function switchSpace(id: string): Promise<void> {
  if (useLayoutStore.getState().currentSpaceId === id) return;
  await keyboardInto(await runLayoutCommand("space.switch", { space: id, focus: "true" }));
}

/** ctrl+cmd+n: the nth space in the top bar, when there is one. */
export function switchSpaceAt(n: number): void {
  const id = spaceAtIndex(useLayoutStore.getState().spaceOrder, n);
  if (id) void switchSpace(id);
}

/** "+": a new space after the others, shown at once (space.new --focus). Resolves its id, "" when it failed. */
export async function newSpace(): Promise<string> {
  const res = await runLayoutCommand("space.new", { focus: "true" });
  if (!res) return "";
  await afterRev(res.rev);
  return res.space ?? "";
}

/**
 * Move to space ▸ <space> from a thread's menu: thread.space.move, which takes its linked tabs
 * along. The thread's tab and row leave this space; unless the menu's row was the place that
 * showed it going (`inView`, the sidebar row's menu), "Moved to <space>" with Go to space
 * (docs/notes/toast-success-rule.md). A drop on a space tab (runSpaceDrop) stays silent: the
 * tab it was dropped on is the place.
 */
export async function moveThreadToSpace(thread: string, space: string, source: CommandSource = {}): Promise<void> {
  const res = await runCommandForResult("thread.space.move", { id: thread, space }, { quiet: true, ctx: getUiContext({ kind: "thread", id: thread }) });
  if (res && !source.inView) noticeMoved(space);
}

function noticeMoved(space: string): void {
  const name = useLayoutStore.getState().spaces[space]?.name ?? space;
  notify({
    level: "success",
    title: `Moved to ${name}`,
    action: {
      label: "Go to space",
      onClick: () => {
        void switchSpace(space);
      },
    },
  });
}

/** Move to space ▸ New space: a new space after the others (not shown), then the thread moves there with its linked tabs (moveThreadToSpace). */
export async function moveToNewSpace(thread: string, source: CommandSource = {}): Promise<void> {
  const made = await runLayoutCommand("space.new", { focus: "false" });
  if (!made?.space) return;
  await afterRev(made.rev);
  await moveThreadToSpace(thread, made.space, source);
}

/** Renames a space (space.rename); an empty or unchanged name does nothing. */
export async function renameSpace(id: string, name: string): Promise<void> {
  const next = name.trim();
  if (!next || useLayoutStore.getState().spaces[id]?.name === next) return;
  await runLayoutCommand("space.rename", { name: next, space: id });
}

/** A space tab dropped at another place (space.move --index, from 1). */
export function moveSpace(id: string, index: number): Promise<LayoutCommandResult | null> {
  return runLayoutCommand("space.move", { space: id, index: String(index) });
}

/**
 * Removes a space (space.remove) as the remove dialog chose: its threads move to another space or
 * are archived. The dialog was the question, so the daemon's own confirmation is answered yes.
 * Resolves whether it was removed.
 */
export async function removeSpace(id: string, choice: RemoveChoice): Promise<boolean> {
  // Archiving its threads ends their files' unsaved edits for good: asked first. Moving them keeps them.
  if (choice.kind === "archive" && !(await guardRemoveSpaceArchive(id))) return false;
  try {
    const res = await invokeConfirmed("space.remove", removeSpaceArgs(id, choice), getUiContext(), undefined, { ask: () => Promise.resolve(true) });
    return res !== null;
  } catch (err) {
    notify({ level: "error", title: "Remove Space failed", description: errorMessage(err) });
    return false;
  }
}

/**
 * Runs a drop on a space tab (spaces.ts spaceDropCommands), one verb after the other; stops at a
 * refusal. A step placed after a thread's tab (a dragged group's next thread, drag/groupDrop.ts)
 * is placed from the layout the step before committed. Resolves whether every verb ran.
 */
export async function runSpaceDrop(cmds: readonly DropStep[]): Promise<boolean> {
  for (const step of cmds) {
    const s = useLayoutStore.getState();
    const c = resolveStep(step, s, s.currentSpaceId);
    if (!c) return false;
    const res = await runLayoutCommand(c.name, c.args);
    if (!res) return false;
    await afterRev(res.rev);
  }
  return true;
}

/**
 * Runs a drop in the grid (a tab or pane moved, a thread opened), then the keyboard goes into the
 * pane the drop focused: the dragged tab's node, which had it, went with the move.
 */
export async function runGridDrop(cmds: readonly DropStep[]): Promise<boolean> {
  const ok = await runSpaceDrop(cmds);
  if (ok) keyboardIntoFocusedPane();
  return ok;
}
