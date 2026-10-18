import { describe, expect, it } from "vitest";
import type { Field, FormNodeData } from "@/api/plugin";
import { demoView } from "@/test/pluginFixtures";
import { flatFields, formValues, validateField, validateForm, valueString } from "./form";

const form = demoView("form").nodes.find((n) => n.form)?.form as FormNodeData;

describe("form values", () => {
  it("flattens fieldsets", () => {
    expect(flatFields(form.fields).map((f) => f.name)).toEqual(["name", "token", "project", "env", "tags", "notifyFail", "notifyDone"]);
  });

  it("sends the plugin's values for pristine fields and drafts for changed ones; secrets only typed and only in a submit", () => {
    expect(formValues(form, undefined, true)).toEqual({ name: "", project: "", env: "dev", tags: ["a"], notifyFail: true, notifyDone: false });
    const drafts = { name: "Ada", token: "tok", tags: ["a", "c"] };
    expect(formValues(form, drafts, true)).toMatchObject({ name: "Ada", token: "tok", tags: ["a", "c"] });
    expect(formValues(form, drafts, false)).not.toHaveProperty("token");
  });

  it("joins lists for commands and change events", () => {
    expect(valueString(["a", "b"])).toBe("a,b");
    expect(valueString(true)).toBe("true");
  });
});

describe("validation", () => {
  const name = form.fields[0] as Field;
  it.each([
    ["required and empty", "", "Required"],
    ["the pattern", "Ada1", "Letters and spaces only"],
    ["too long", "A".repeat(41), "At most 40 characters"],
    ["fine", "Ada Lovelace", null],
  ])("%s", (_n, v, want) => {
    expect(validateField(name, v)).toBe(want);
  });

  it("passes a required secret that is stored, and skips patterns JavaScript cannot read", () => {
    expect(validateField({ key: "t", name: "t", required: true, input: { kind: "secret", hasValue: true } }, undefined)).toBeNull();
    expect(validateField({ key: "t", name: "t", required: true, input: { kind: "secret" } }, undefined)).toBe("Required");
    expect(validateField({ key: "p", name: "p", input: { pattern: "(?P<x>a)" } }, "b")).toBeNull();
    expect(validateField({ key: "d", name: "d", required: true, disabled: true, input: {} }, "")).toBeNull();
  });

  it("checks the whole form", () => {
    expect(validateForm(form, undefined)).toEqual({ name: "Required" });
    expect(validateForm(form, { name: "Ada" })).toEqual({});
  });
});
