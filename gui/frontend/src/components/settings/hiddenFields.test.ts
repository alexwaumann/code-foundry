import { describe, expect, it } from "vitest";
import type { SettingFieldView } from "@/api/settings";
import { hiddenFieldKeys } from "./hiddenFields";

const field = (key: string, dependsOn = ""): SettingFieldView => ({ key, dependsOn }) as SettingFieldView;
const fields = [field("dictation.enabled"), field("dictation.anywhere"), field("dictation.hold_key", "dictation.enabled"), field("dictation.sounds", "dictation.enabled"), field("dictation.spoken_symbols", "dictation.enabled"), field("dictation.spoken_formatting", "dictation.enabled"), field("notifications.sound_volume", "notifications.sound")];

describe("hiddenFieldKeys", () => {
  it.each([
    ["off", { "dictation.enabled": "false" }, ["dictation.hold_key", "dictation.sounds", "dictation.spoken_symbols", "dictation.spoken_formatting"]],
    ["no value yet", {}, ["dictation.hold_key", "dictation.sounds", "dictation.spoken_symbols", "dictation.spoken_formatting"]],
    ["on", { "dictation.enabled": "true" }, []],
  ])("dictation %s", (_name, values: Record<string, string>, want) => {
    expect(hiddenFieldKeys(fields, values)).toEqual(want);
  });

  it("leaves a dependent that only dims", () => {
    expect(hiddenFieldKeys(fields, { "dictation.enabled": "true", "notifications.sound": "false" })).toEqual([]);
  });
});
