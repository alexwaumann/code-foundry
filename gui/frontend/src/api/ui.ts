import { UiIntent_Notify_Level, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";

export type NotifyLevel = "info" | "warning" | "error";

export type UiIntentView =
  | { kind: "focusTerminal"; terminalId: string }
  | { kind: "focusSession"; sessionId: string }
  | { kind: "focusRepo"; repoId: string; worktreePath: string }
  | { kind: "openPalette"; query: string }
  | { kind: "notify"; level: NotifyLevel; title: string; body: string };

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
    case "focusSession":
      return { kind: "focusSession", sessionId: e.value.sessionId };
    case "focusRepo":
      return { kind: "focusRepo", repoId: e.value.repoId, worktreePath: e.value.worktreePath };
    case "openPalette":
      return { kind: "openPalette", query: e.value.query };
    case "notify":
      return { kind: "notify", level: levelMap[e.value.level], title: e.value.title, body: e.value.body };
    default:
      return null;
  }
}
