/**
 * Switching Threads open as from the settings page (docs/notes/threads-open-as-2-gui.md): the
 * daemon converts the layout when the setting changes (docs/notes/threads-open-as-1-rules.md),
 * closing the thread tabs and panes the new mode has no room for. Before the switch the page asks
 * the daemon what it would close and move (layout.threads-open-as.preview); when that is nothing
 * the switch is made at once, otherwise the confirm dialog says it with the real counts.
 */
import { runCommandForResult } from "@/stores/commands";
import { requestConfirm, type ConfirmRequest } from "@/stores/confirm";
import { threadsOpenAsOf, useThreadsOpenAs } from "@/shell/threadsOpenAs";

/** What layout.threads-open-as.preview says a switch would do (internal/layout Conformed). */
export interface SwitchPreview {
  threadTabs: number;
  composers: number;
  panes: number;
  moved: number;
  spaces: number;
}

const NONE: SwitchPreview = { threadTabs: 0, composers: 0, panes: 0, moved: 0, spaces: 0 };

/** The preview's JSON (snake case, as the daemon writes it); missing numbers are 0. */
export function previewOf(json: string): SwitchPreview {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return NONE;
  }
  const n = (k: string) => (typeof v[k] === "number" ? v[k] : 0);
  return { threadTabs: n("thread_tabs"), composers: n("composers"), panes: n("panes"), moved: n("moved"), spaces: n("spaces") };
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The line about tabs that move out of a thread's pane, when any do. */
function movedLine(p: SwitchPreview): string {
  if (p.moved === 0) return "";
  return p.moved === 1 ? " 1 other tab moves to a pane of its own." : ` ${String(p.moved)} other tabs move to a pane of their own.`;
}

/**
 * The confirm dialog's question for switching to `to`, or null when the switch closes and moves
 * nothing (it is made without asking). Toward Tabs nothing changes, so never a question.
 */
export function switchQuestion(to: string, p: SwitchPreview): ConfirmRequest | null {
  const mode = threadsOpenAsOf(to);
  const tabs = p.threadTabs + p.composers;
  if (mode === "tabs" || tabs + p.panes + p.moved === 0) return null;
  if (mode === "panes") {
    const closing = tabs > 0 ? ` ${count(tabs, "other thread tab", "other thread tabs")} in ${count(p.spaces, "space", "spaces")} will close.` : "";
    return {
      title: "Switch to Panes?",
      message: `Each pane keeps the thread it is showing now.${closing}${movedLine(p)}${tabs > 0 ? "\n\nNothing is lost: those threads stay in the sidebar and keep running, and each one's diff, files and terminals come back when you open it." : ""}`,
      confirmLabel: "Switch to Panes",
    };
  }
  // A pane closing takes its thread tabs with it; a kept pane's other thread tabs close too, so the tab count says the whole.
  const closing =
    p.panes > 0
      ? ` ${count(p.panes, "other thread pane", "other thread panes")}${tabs > p.panes ? ` (${count(tabs, "thread tab", "thread tabs")})` : ""} will close.`
      : tabs > 0
        ? ` ${count(tabs, "other thread tab", "other thread tabs")} will close.`
        : "";
  return {
    title: "Switch to Single?",
    message: `Each space keeps the thread pane you used last.${closing}${movedLine(p)}${tabs + p.panes > 0 ? "\n\nNothing is lost: those threads stay in the sidebar and keep running." : ""}`,
    confirmLabel: "Switch to Single",
  };
}

/**
 * Whether to go ahead with switching to `to`: at once when it closes and moves nothing (or the
 * daemon cannot say: the switch itself loses nothing), else the user's answer to the dialog.
 */
export async function confirmThreadsOpenAs(to: string): Promise<boolean> {
  const mode = threadsOpenAsOf(to);
  if (mode === "tabs") return true;
  const res = await runCommandForResult("layout.threads-open-as.preview", { to: mode }, { quiet: true, expected: () => true });
  const question = switchQuestion(mode, res ? previewOf(res.resultJson) : NONE);
  return question ? requestConfirm(question) : true;
}

/** Whether layout.smart_swap is on whatever it says: Threads open as Panes or Single (internal/layout ApplyWith). */
export function useSmartSwapForced(): boolean {
  return useThreadsOpenAs() !== "tabs";
}
