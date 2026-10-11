import { describe, expect, it } from "vitest";
import { enumOptionLabel, FALLBACK_MODEL_CHOICES, MODEL_SETTING_KEY, modelChoicesFromSchema, modelName } from "./models";

const modelField = {
  key: MODEL_SETTING_KEY,
  enumValues: ["fable", "opus", "claude-opus-4-8", "claude-opus-4-7", "sonnet", "claude-sonnet-5", "claude-sonnet-4-6", "haiku", "claude-haiku-4-5"],
  enumLabels: ["Fable (default)", "Opus (default)", "Opus 4.8", "Opus 4.7", "Sonnet (default)", "Sonnet 5", "Sonnet 4.6", "Haiku (default)", "Haiku 4.5"],
};

describe("modelChoicesFromSchema", () => {
  it("reads the registry from sessions.default_model, in order", () => {
    const got = modelChoicesFromSchema([{ key: "appearance.theme", enumValues: ["dark"], enumLabels: [] }, modelField]);
    expect(got?.map((c) => c.value)).toEqual(modelField.enumValues);
    expect(got?.map((c) => c.label)).toEqual(modelField.enumLabels);
  });

  it.each([
    ["no model field", [], null],
    ["an empty enum", [{ key: MODEL_SETTING_KEY, enumValues: [], enumLabels: [] }], null],
    [
      "values without labels name themselves; blank is dropped",
      [{ key: MODEL_SETTING_KEY, enumValues: ["", "opus", "claude-x"], enumLabels: [] }],
      [
        { value: "opus", label: "opus" },
        { value: "claude-x", label: "claude-x" },
      ],
    ],
  ])("%s", (_, fields, want) => {
    expect(modelChoicesFromSchema(fields)).toEqual(want);
  });
});

describe("modelName", () => {
  const choices = modelChoicesFromSchema([modelField]) ?? [];
  it.each([
    ["opus", "Opus (default)"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-haiku-4-5", "Haiku 4.5"],
    ["claude-opus-5-5[1m]", "claude-opus-5-5[1m]"],
  ])("%j is %j", (model, want) => {
    expect(modelName(choices, model)).toBe(want);
  });

  it("the fallback names the family aliases", () => {
    expect(FALLBACK_MODEL_CHOICES.map((c) => c.value)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(modelName(FALLBACK_MODEL_CHOICES, "sonnet")).toBe("Sonnet (default)");
    expect(modelName(FALLBACK_MODEL_CHOICES, "claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

describe("enumOptionLabel", () => {
  it.each([
    ["claude-opus-4-7", "Opus 4.7"],
    ["unknown", "unknown"],
  ])("%j is %j", (v, want) => {
    expect(enumOptionLabel(modelField, v)).toBe(want);
  });
  it("falls back to the value without labels", () => {
    expect(enumOptionLabel({ enumValues: ["dark"], enumLabels: [] }, "dark")).toBe("dark");
  });
});
