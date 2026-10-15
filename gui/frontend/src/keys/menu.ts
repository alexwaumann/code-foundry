/**
 * The native app menu's items that run something in this window (Settings…, the Thread
 * and Help menus; gui/menu.go). The host emits EventRunCommand with a name; this starts it
 * exactly as the palette would, so the menu adds no user action of its own.
 */
import { toast } from "sonner";
import { onRunCommandMenu } from "@/api/app";
import { useCommandsStore } from "@/stores/commands";
import { openHelp } from "@/stores/views";
import { jumpToAttention, startCommandNamed } from "./bindings";

/**
 * GUI view actions the menu names (they are not registry commands; see viewActions in
 * bindings.ts). Keep the names in sync with gui/menu.go.
 */
const menuViewActions: Readonly<Record<string, () => void>> = {
  // Thread > Next Needing Attention, as cmd+shift+a and the sidebar's bell.
  "attention.next": () => {
    if (!jumpToAttention()) toast.info("No threads need attention");
  },
  // Help > Getting Started and Keyboard Shortcuts and Help: the help overlay on a tab.
  // Not view.help, a toggle: picking one while the overlay shows switches its tab.
  "help.guide": () => {
    openHelp("guide");
  },
  "help.shortcuts": () => {
    openHelp("shortcuts");
  },
};

/**
 * Runs a menu item's command here: a view action by name, else a registry command that
 * is startable in the current context (startCommandNamed). A native menu cannot grey out
 * per context, so one that is not available here says so instead of doing nothing.
 */
export function runMenuCommand(name: string): void {
  const action = menuViewActions[name];
  if (action) {
    action();
    return;
  }
  if (startCommandNamed(name)) return;
  const title = useCommandsStore.getState().commands.find((c) => c.name === name)?.title ?? name;
  toast.info(`${title} is not available here`);
}

/** Wires the app menu's command items to this window. Returns an unsubscribe. */
export function startMenuCommands(): () => void {
  return onRunCommandMenu(runMenuCommand);
}
