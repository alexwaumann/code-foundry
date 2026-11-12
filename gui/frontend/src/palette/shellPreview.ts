/**
 * "Toggle new shell (preview)" in the palette: a GUI view action, like the palette's own, that
 * turns the window shell (shell/flag.ts) off or on again in this window and reloads. Since the
 * cutover the shell is the default and this is the way back to the classic window, for one PR:
 * the next removes the classic window, the flag and this row. It is not a registry command: it
 * changes nothing but this window's localStorage. See docs/notes/shell-15-spaces.md and
 * docs/notes/shell-20-cutover.md.
 */
import type { CommandView } from "@/api/command";
import { SHELL_FLAG_KEY, shellOn } from "@/shell/flag";

/** Its palette row's name; not a daemon command. */
export const SHELL_PREVIEW_ENTRY = "gui.shell.preview";

/** The palette row, shaped as a command so the palette ranks and draws it with the others. */
export const shellPreviewEntry: CommandView = {
  name: SHELL_PREVIEW_ENTRY,
  title: "Toggle new shell (preview)",
  description: "Switch this window between the new shell and the classic window, and reload",
  category: "View",
  args: [],
  keybindings: [],
  available: true,
};

/** Flips the flag (off: "0"; on: the key removed, the default) and reloads the window. */
export function toggleShellPreview(store: Pick<Storage, "setItem" | "removeItem"> = localStorage, reload: () => void = () => {
  location.reload();
}): void {
  try {
    if (shellOn()) store.setItem(SHELL_FLAG_KEY, "0");
    else store.removeItem(SHELL_FLAG_KEY);
  } catch {
    // Storage can be blocked: the URL's ?shell=0 still turns it off.
  }
  reload();
}
