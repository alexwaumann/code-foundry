/**
 * What the top bar's controls run (docs/notes/shell-model.md, "Structure"): each is a layout verb
 * (internal/command commands_space.go, commands_layout_threads.go, commands_tab.go,
 * commands_pane.go), invoked from the window as a key or the palette would.
 * See docs/notes/shell-15-spaces.md.
 */
import { guardRemoveSpaceArchive } from "@/stores/fileEditGuards";
import { toast } from "sonner";
import { errorMessage } from "@/api/stream";
import { invokeConfirmed } from "@/stores/commands";
import { getUiContext } from "@/stores/context";
import { useLayoutStore } from "@/stores/layout";
import { requestPaneFocus } from "@/stores/shellView";
import { afterRev, runLayoutCommand, type LayoutCommandResult } from "./commands";
import { removeSpaceArgs, spaceAtIndex, type RemoveChoice, type SpaceCommand } from "./spaces";

/** After a commit that showed another space, the keyboard goes into its focused pane. */
async function keyboardInto(res: LayoutCommandResult | null): Promise<void> {
  if (!res) return;
  await afterRev(res.rev);
  const s = useLayoutStore.getState();
  const pane = s.spaces[s.currentSpaceId]?.focus ?? "";
  if (pane) requestPaneFocus(pane);
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

/** Move to space ▸ New space: a new space after the others (not shown), then the thread moves there with its linked tabs. */
export async function moveToNewSpace(thread: string): Promise<void> {
  const made = await runLayoutCommand("space.new", { focus: "false" });
  if (!made?.space) return;
  await afterRev(made.rev);
  await runLayoutCommand("thread.space.move", { id: thread, space: made.space });
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
    toast.error("Remove Space failed", { description: errorMessage(err) });
    return false;
  }
}

/** Runs a drop on a space tab (spaces.ts spaceDropCommands), one verb after the other; stops at a refusal. */
export async function runSpaceDrop(cmds: readonly SpaceCommand[]): Promise<void> {
  for (const c of cmds) {
    const res = await runLayoutCommand(c.name, c.args);
    if (!res) return;
    await afterRev(res.rev);
  }
}
