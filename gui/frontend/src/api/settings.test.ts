import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { ConfirmationRequiredSchema } from "@/gen/codefoundry/v1/command_pb";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { SettingFieldSchema, SettingType } from "@/gen/codefoundry/v1/settings_pb";
import { UiIntentSchema } from "@/gen/codefoundry/v1/ui_pb";
import { confirmationOf } from "./command";
import { toEventView } from "./events";
import { toSettingFieldView } from "./settings";
import { toUiIntentView } from "./ui";

describe("settings mapping", () => {
  it("maps a settings event", () => {
    const ev = create(EventSchema, {
      event: {
        case: "settings",
        value: { event: { case: "snapshot", value: { values: { "appearance.theme": "dark" }, path: "/p", revision: 3n, restartPending: ["threads.scrollback_lines"] } } },
      },
    });
    expect(toEventView(ev)).toEqual({
      source: "settings",
      event: { values: { "appearance.theme": "dark" }, path: "/p", revision: 3, loadError: "", issues: [], restartPending: ["threads.scrollback_lines"] },
    });
  });

  it("maps a field", () => {
    const f = create(SettingFieldSchema, { key: "appearance.font_size", title: "Size", group: "appearance", type: SettingType.INT, min: 9n, max: 28n, defaultValue: "13" });
    expect(toSettingFieldView(f)).toMatchObject({ key: "appearance.font_size", type: "int", min: 9, max: 28, defaultValue: "13", restartRequired: false });
    expect(toSettingFieldView(create(SettingFieldSchema, { key: "keybindings.thread.new", type: SettingType.KEYBINDING })).type).toBe("keybinding");
  });

  it.each([
    ["labels parallel to the values", ["opus", "claude-opus-4-8"], ["Opus", "Opus 4.8"], ["Opus", "Opus 4.8"]],
    ["no labels", ["dark", "light"], [], []],
    ["labels that do not line up are dropped", ["a", "b"], ["A"], []],
  ])("maps enum labels: %s", (_, enumValues, enumLabels, want) => {
    const f = create(SettingFieldSchema, { key: "k", type: SettingType.ENUM, enumValues, enumLabels });
    expect(toSettingFieldView(f).enumLabels).toEqual(want);
  });

  it("maps ShowView intents", () => {
    expect(toUiIntentView(create(UiIntentSchema, { intent: { case: "showView", value: { name: "help" } } }))).toEqual({ kind: "showView", name: "help" });
  });
});

describe("confirmationOf", () => {
  it("reads the ConfirmationRequired detail", () => {
    const err = new ConnectError("Remove session s1?", Code.FailedPrecondition, undefined, [
      { desc: ConfirmationRequiredSchema, value: { command: "thread.remove", title: "Remove Session", message: "Remove session s1?" } },
    ]);
    expect(confirmationOf(err)).toEqual({ command: "thread.remove", title: "Remove Session", message: "Remove session s1?" });
    expect(confirmationOf(new ConnectError("nope", Code.FailedPrecondition))).toBeNull();
    expect(confirmationOf(new Error("x"))).toBeNull();
  });
});
