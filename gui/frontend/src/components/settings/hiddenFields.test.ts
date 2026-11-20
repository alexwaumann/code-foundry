import { describe, expect, it } from "vitest";
import type { SettingFieldView } from "@/api/settings";
import { hiddenFieldKeys, hiddenWhileOff } from "./hiddenFields";

const field = (key: string, dependsOn = "", dependsOnValue = ""): SettingFieldView => ({ key, dependsOn, dependsOnValue }) as SettingFieldView;
const dictation = ["dictation.anywhere", "dictation.hold_key", "dictation.microphone", "dictation.sounds", "dictation.other_audio", "dictation.avoid_bluetooth", "dictation.spoken_symbols", "dictation.spoken_formatting"];
const fields = [field("dictation.enabled"), ...dictation.map((k) => field(k, "dictation.enabled")), field("notifications.sound_volume", "notifications.sound"), field("ember.model", "ember.enabled")];

describe("hiddenFieldKeys", () => {
  it.each([
    ["off", { "dictation.enabled": "false" }, dictation],
    ["no value yet", {}, dictation],
    ["on", { "dictation.enabled": "true" }, []],
  ])("dictation %s: every setting under the switch, Dictate anywhere too", (_name, values: Record<string, string>, want) => {
    expect(hiddenFieldKeys(fields, { "notifications.sound": "true", "ember.enabled": "true", ...values })).toEqual(want);
  });

  it.each([
    ["semantic", ["projects.branch_prefix", "projects.branch_instructions"]],
    ["prefix", ["projects.branch_instructions"]],
    ["custom", ["projects.branch_prefix"]],
  ] as const)("branch naming %s", (mode, want) => {
    const naming = [field("projects.branch_naming"), field("projects.branch_prefix", "projects.branch_naming", "prefix"), field("projects.branch_instructions", "projects.branch_naming", "custom")];
    expect(hiddenFieldKeys(naming, { "projects.branch_naming": mode })).toEqual(want);
  });

  it("leaves a dependent that only dims (the alert volume, Ember's settings)", () => {
    expect(hiddenFieldKeys(fields, { "dictation.enabled": "true", "notifications.sound": "false", "ember.enabled": "false" })).toEqual([]);
  });

  it("names the fields that leave rather than dim", () => {
    expect(dictation.every(hiddenWhileOff)).toBe(true);
    expect(["dictation.enabled", "notifications.sound_volume", "ember.model"].some(hiddenWhileOff)).toBe(false);
  });
});
