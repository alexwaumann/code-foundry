import { describe, expect, it } from "vitest";
import { canonicalModelName, enumOptionLabel, FALLBACK_MODEL_CHOICES, MODEL_SETTING_KEY, modelChoicesFromSchema, modelName } from "./models";

const modelField = {
  key: MODEL_SETTING_KEY,
  enumValues: [
    "claude-opus-5-5[1m]",
    "claude-opus-4-8[1m]",
    "claude-opus-4-7[1m]",
    "claude-sonnet-5-5[1m]",
    "claude-sonnet-5[1m]",
    "claude-sonnet-4-6[1m]",
    "claude-haiku-5-5[1m]",
    "claude-4.5-haiku[1m]",
  ],
  enumLabels: ["Opus 5.5", "Opus 4.8", "Opus 4.7", "Sonnet 5.5", "Sonnet 5", "Sonnet 4.6", "Haiku 5.5", "Haiku 4.5"],
};

describe("modelChoicesFromSchema", () => {
  it("reads the registry from threads.default_model, in order", () => {
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
    ["claude-opus-4-8[1m]", "Opus 4.8"],
    ["claude-4.5-haiku[1m]", "Haiku 4.5"],
    // A thread started before the 1M registry keeps its value.
    ["opus", "opus"],
    ["claude-opus-4-8", "claude-opus-4-8"],
  ])("%j is %j", (model, want) => {
    expect(modelName(choices, model)).toBe(want);
  });

  it("the fallback is the default model alone", () => {
    expect(FALLBACK_MODEL_CHOICES).toEqual([{ value: "claude-opus-4-8[1m]", label: "Opus 4.8" }]);
    expect(modelName(FALLBACK_MODEL_CHOICES, "claude-sonnet-5[1m]")).toBe("claude-sonnet-5[1m]");
  });
});

describe("enumOptionLabel", () => {
  it.each([
    ["claude-opus-4-7[1m]", "Opus 4.7"],
    ["unknown", "unknown"],
  ])("%j is %j", (v, want) => {
    expect(enumOptionLabel(modelField, v)).toBe(want);
  });
  it("falls back to the value without labels", () => {
    expect(enumOptionLabel({ enumValues: ["dark"], enumLabels: [] }, "dark")).toBe("dark");
  });
});

describe("canonicalModelName", () => {
  const choices = [
    { value: "opus", label: "Opus" },
    { value: "claude-opus-4-8", label: "Opus 4.8" },
    { value: "haiku", label: "Haiku" },
  ];
  it.each([
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-opus-4-8[1m]", "Opus 4.8"],
    ["claude-sonnet-4-6-20260101", "Sonnet 4.6"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-haiku-5-5-20261001[1m]", "Haiku 5.5"],
    ["claude-quill-6", "Quill 6"],
    ["haiku", "Haiku"],
    ["sonnet", "Sonnet"],
    ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022"],
    ["gpt-5", "gpt-5"],
    ["", ""],
  ])("%s → %s", (id, want) => {
    expect(canonicalModelName(choices, id)).toBe(want);
  });
});
