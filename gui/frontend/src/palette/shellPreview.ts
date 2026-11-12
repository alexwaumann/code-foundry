/**
 * "Toggle new shell (preview)" in the palette: a GUI view action, like the palette's own, that
 * turns the window shell (shell/flag.ts) on or off in this window and reloads, so the shell can
 * be tried in the real app window without developer tools while it is built on the `shell`
 * branch. It is not a registry command: it changes nothing but this window's localStorage. The
 * cutover PR (PR 20) removes it. See docs/notes/shell-15-spaces.md.
 */
import type { CommandView } from "@/api/command";
import { SHELL_FLAG_KEY, shellOn } from "@/shell/flag";

/** Its palette row's name; not a daemon command. */
export const SHELL_PREVIEW_ENTRY = "gui.shell.preview";

/** The palette row, shaped as a command so the palette ranks and draws it with the others. */
export const shellPreviewEntry: CommandView = {
  name: SHELL_PREVIEW_ENTRY,
  title: "Toggle new shell (preview)",
  description: "Turn the new window shell on or off in this window and reload",
  category: "View",
  args: [],
  keybindings: [],
  available: true,
};

/** Flips the flag (on: "1"; off: the key removed) and reloads the window. */
export function toggleShellPreview(store: Pick<Storage, "setItem" | "removeItem"> = localStorage, reload: () => void = () => {
  location.reload();
}): void {
  try {
    if (shellOn()) store.removeItem(SHELL_FLAG_KEY);
    else store.setItem(SHELL_FLAG_KEY, "1");
  } catch {
    // Storage can be blocked: the URL's ?shell=1 still turns it on.
  }
  reload();
}
