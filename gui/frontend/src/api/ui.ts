import { UiIntent_Notify_Level, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";
import type { UiContextView } from "./command";

export type NotifyLevel = "info" | "warning" | "error";

export type UiIntentView =
  | { kind: "focusTerminal"; terminalId: string }
  | { kind: "focusThread"; threadId: string }
  | { kind: "focusProject"; projectId: string; worktreePath: string }
  | { kind: "openPalette"; query: string }
  | { kind: "notify"; level: NotifyLevel; title: string; body: string }
  | { kind: "showView"; name: string }
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
      return { kind: "focusThread", threadId: e.value.threadId };
    case "focusProject":
      return { kind: "focusProject", projectId: e.value.projectId, worktreePath: e.value.worktreePath };
    case "openPalette":
      return { kind: "openPalette", query: e.value.query };
    case "notify":
      return { kind: "notify", level: levelMap[e.value.level], title: e.value.title, body: e.value.body };
    case "showView":
      return { kind: "showView", name: e.value.name };
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
