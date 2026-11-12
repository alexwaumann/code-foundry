/**
 * Runs a linked-surface action (shell/linked.ts): a verb, quietly (the window shows what it did;
 * a failure is toasted), with a thread's context when it names one; the focus of an open tab,
 * with the keyboard following it into its pane; a terminal through PR 13's actions; or a note.
 */
import { toast } from "sonner";
import { runCommandForResult } from "@/stores/commands";
import { getUiContext } from "@/stores/context";
import { useLayoutStore } from "@/stores/layout";
import { requestPaneFocus } from "@/stores/shellView";
import { focusTabNow } from "./commands";
import { newFreeTerminalTab, newTerminalTab, openTerminalIn } from "./terminalActions";
import type { LinkedAction } from "./linked";

export async function runLinked(a: LinkedAction): Promise<void> {
  if ("focus" in a) {
    const pane = useLayoutStore.getState().tabs[a.focus]?.paneId ?? "";
    await focusTabNow(a.focus);
    if (pane) requestPaneFocus(pane);
    return;
  }
  if ("say" in a) {
    toast(a.say);
    return;
  }
  if ("terminal" in a) {
    if (a.terminal === "show") await openTerminalIn(a.id, a.pane);
    else if (a.thread) await newTerminalTab({ thread: a.thread, pane: a.pane });
    else await newFreeTerminalTab(a.pane);
    return;
  }
  await runCommandForResult(a.run, a.args, { quiet: true, ...(a.thread ? { ctx: getUiContext({ kind: "thread", id: a.thread }) } : {}) });
}
