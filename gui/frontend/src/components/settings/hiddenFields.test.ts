import { describe, expect, it } from "vitest";
import type { SettingFieldView } from "@/api/settings";
import { hiddenFieldKeys } from "./hiddenFields";

const field = (key: string, dependsOn = "", dependsOnValue = ""): SettingFieldView => ({ key, dependsOn, dependsOnValue }) as SettingFieldView;
const fields = [field("dictation.enabled"), field("dictation.anywhere"), field("dictation.hold_key", "dictation.enabled"), field("dictation.microphone", "dictation.enabled"), field("dictation.sounds", "dictation.enabled"), field("dictation.other_audio", "dictation.enabled"), field("dictation.avoid_bluetooth", "dictation.enabled"), field("dictation.spoken_symbols", "dictation.enabled"), field("dictation.spoken_formatting", "dictation.enabled"), field("notifications.sound_volume", "notifications.sound")];

describe("hiddenFieldKeys", () => {
  it.each([
    ["off", { "dictation.enabled": "false" }, ["dictation.hold_key", "dictation.microphone", "dictation.sounds", "dictation.other_audio", "dictation.avoid_bluetooth", "dictation.spoken_symbols", "dictation.spoken_formatting"]],
    ["no value yet", {}, ["dictation.hold_key", "dictation.microphone", "dictation.sounds", "dictation.other_audio", "dictation.avoid_bluetooth", "dictation.spoken_symbols", "dictation.spoken_formatting"]],
    ["on", { "dictation.enabled": "true" }, []],
  ])("dictation %s", (_name, values: Record<string, string>, want) => {
    expect(hiddenFieldKeys(fields, values)).toEqual(want);
  });

  it.each([
    ["semantic", "section", ["projects.branch_prefix", "projects.branch_instructions"]],
    ["prefix", "section", ["projects.branch_instructions"]],
    ["custom", "section", ["projects.branch_prefix"]],
    ["semantic", "search", []],
  ] as const)("branch naming %s, from the %s", (mode, from, want) => {
    const naming = [field("projects.branch_naming"), field("projects.branch_prefix", "projects.branch_naming", "prefix"), field("projects.branch_instructions", "projects.branch_naming", "custom")];
    expect(hiddenFieldKeys(naming, { "projects.branch_naming": mode }, from)).toEqual(want);
  });

  it("leaves a dependent that only dims", () => {
    expect(hiddenFieldKeys(fields, { "dictation.enabled": "true", "notifications.sound": "false" })).toEqual([]);
  });
});
