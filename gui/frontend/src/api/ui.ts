import { UiIntent_Notify_Level, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";

export type NotifyLevel = "info" | "warning" | "error";

export type UiIntentView =
  | { kind: "focusTerminal"; terminalId: string }
  | { kind: "focusThread"; threadId: string }
  | { kind: "focusProject"; projectId: string; worktreePath: string }
  | { kind: "openPalette"; query: string }
  | { kind: "notify"; level: NotifyLevel; title: string; body: string }
  | { kind: "showView"; name: string }
  | { kind: "playAlertSound"; volume: number };

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
    default:
      return null;
  }
}
