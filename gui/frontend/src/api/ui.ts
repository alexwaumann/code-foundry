import { UiIntent_Notify_Level, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";
import type { UiContextView } from "./command";

export type NotifyLevel = "info" | "warning" | "error";

export type UiIntentView =
  | { kind: "focusTerminal"; terminalId: string }
  /**
   * Select a thread. `explicit` (a view.panel.* verb's --focus: the user asked) selects
   * even a hidden thread just created, which a focusThread otherwise leaves alone.
   */
  | { kind: "focusThread"; threadId: string; explicit?: boolean }
  | { kind: "focusProject"; projectId: string; worktreePath: string }
  | { kind: "openPalette"; query: string }
  | { kind: "notify"; level: NotifyLevel; title: string; body: string }
  /**
   * A named view, or a panel action. `threadId` (a view.panel.* verb run inside a thread)
   * scopes a panel action to that thread's panel, whatever the window has selected
   * (stores/threadPanelIntent.ts); absent, it acts on the selection. `params` name the
   * item a panel action opens ("panel.file" path and line, "panel.diff", "panel.pr").
   */
  | { kind: "showView"; name: string; threadId?: string; params?: Record<string, string> }
  | { kind: "playAlertSound"; volume: number }
  /** thread.agent.open: select the thread and show one of its own subagent runs read-only. */
  | { kind: "showAgentRun"; threadId: string; runId: string }
  /**
   * A plugin's host/invoke with confirm "ask": run the command through runCommand, so the
   * daemon's own confirm dialog asks the user. `caller` is who asked ("plugin:hello").
   */
  | { kind: "invokeCommand"; name: string; args: Record<string, string>; context: UiContextView | null; caller: string };

const levelMap: Record<UiIntent_Notify_Level, NotifyLevel> = {
  [UiIntent_Notify_Level.UNSPECIFIED]: "info",
  [UiIntent_Notify_Level.INFO]: "info",
  [UiIntent_Notify_Level.WARNING]: "warning",
  [UiIntent_Notify_Level.ERROR]: "error",
};

export function toUiIntentView(i: UiIntent): UiIntentView | null {
  const e = i.intent;
  switch (e.case) {
    case "focusTerminal":
      return { kind: "focusTerminal", terminalId: e.value.terminalId };
    case "focusThread":
      return e.value.explicit ? { kind: "focusThread", threadId: e.value.threadId, explicit: true } : { kind: "focusThread", threadId: e.value.threadId };
    case "focusProject":
      return { kind: "focusProject", projectId: e.value.projectId, worktreePath: e.value.worktreePath };
    case "openPalette":
      return { kind: "openPalette", query: e.value.query };
    case "notify":
      return { kind: "notify", level: levelMap[e.value.level], title: e.value.title, body: e.value.body };
    case "showView": {
      const { name, threadId, params } = e.value;
      if (!threadId) return { kind: "showView", name };
      return Object.keys(params).length > 0 ? { kind: "showView", name, threadId, params: { ...params } } : { kind: "showView", name, threadId };
    }
    case "playAlertSound":
      return { kind: "playAlertSound", volume: e.value.volume };
    case "showAgentRun":
      return { kind: "showAgentRun", threadId: e.value.threadId, runId: e.value.runId };
    case "invokeCommand": {
      const c = e.value.context;
      return {
        kind: "invokeCommand",
        name: e.value.name,
        args: { ...e.value.args },
        context: c
          ? {
              activeTerminalId: c.activeTerminalId,
              activeThreadId: c.activeThreadId,
              activeProjectId: c.activeProjectId,
              activeWorktreePath: c.activeWorktreePath,
              activeView: c.activeView,
              activeWorkspaceId: c.activeWorkspaceId,
            }
          : null,
        caller: e.value.caller,
      };
    }
    default:
      return null;
  }
}
