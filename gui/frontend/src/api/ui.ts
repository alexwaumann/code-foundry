import { UiIntent_Notify_Level, UiIntentSchema, type UiIntent } from "@/gen/codefoundry/v1/ui_pb";

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

/**
 * True once ui.proto has `FocusSession focus_session` (added by Phase 2a). Until then the
 * mapping below still handles the case by name, so it works as soon as `make gen` runs.
 */
export const hasFocusSessionIntent: boolean = UiIntentSchema.fields.some((f) => f.localName === "focusSession");

export function toUiIntentView(i: UiIntent): UiIntentView | null {
  const e = i.intent;
  switch (e.case) {
    case "focusTerminal":
      return { kind: "focusTerminal", terminalId: e.value.terminalId };
    case "focusRepo":
      return { kind: "focusRepo", repoId: e.value.repoId, worktreePath: e.value.worktreePath };
    case "openPalette":
      return { kind: "openPalette", query: e.value.query };
    case "notify":
      return { kind: "notify", level: levelMap[e.value.level], title: e.value.title, body: e.value.body };
    default: {
      // TODO(phase2a merge): replace with a typed `case "focusSession"` once the generated
      // UiIntent has it. Expected shape: `message FocusSession { string session_id = 1; }`.
      const loose = e as { case?: string; value?: { sessionId?: unknown } };
      if (loose.case === "focusSession" && typeof loose.value?.sessionId === "string") {
        return { kind: "focusSession", sessionId: loose.value.sessionId };
      }
      return null;
    }
  }
}
