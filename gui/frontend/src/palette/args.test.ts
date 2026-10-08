import { describe, expect, it } from "vitest";
import type { ArgSpecView, CommandView } from "@/api/command";
import { argChoices, groupByCategory, previousArg, promptedArgs, startPrompt, submitArg, UNSET_CHOICE, validateArg } from "./args";

function arg(over: Partial<ArgSpecView>): ArgSpecView {
  return { name: "x", type: "string", required: true, description: "", enumValues: [], defaultValue: "", ...over };
}

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "c", title: "C", description: "", category: "Misc", args: [], keybindings: [], available: true, ...over };
}

describe("validateArg", () => {
  it.each([
    ["string keeps spaces", arg({}), "  a b ", { ok: true, value: "  a b " }],
    ["required empty", arg({}), "", { ok: false, error: "x is required" }],
    ["empty uses default", arg({ defaultValue: "d" }), "", { ok: true, value: "d" }],
    ["optional empty", arg({ required: false }), "", { ok: true, value: "" }],
    ["int ok", arg({ type: "int" }), " 42 ", { ok: true, value: "42" }],
    ["int negative", arg({ type: "int" }), "-3", { ok: true, value: "-3" }],
    ["int bad", arg({ type: "int" }), "4.2", { ok: false, error: "x must be a whole number" }],
    ["bool yes", arg({ type: "bool" }), "Yes", { ok: true, value: "true" }],
    ["bool 0", arg({ type: "bool" }), "0", { ok: true, value: "false" }],
    ["bool bad", arg({ type: "bool" }), "maybe", { ok: false, error: "x must be true or false" }],
    ["enum ok", arg({ type: "enum", enumValues: ["opus", "sonnet"] }), "sonnet", { ok: true, value: "sonnet" }],
    ["enum bad", arg({ type: "enum", enumValues: ["opus", "sonnet"] }), "gpt", { ok: false, error: "x must be one of opus, sonnet" }],
    ["path untouched (~ expanded daemon-side)", arg({ type: "path" }), " ~/src ", { ok: true, value: "~/src" }],
  ])("%s", (_name, spec, raw, want) => {
    expect(validateArg(spec, raw)).toEqual(want);
  });
});

describe("argChoices", () => {
  it.each([
    [arg({ type: "enum", enumValues: ["a", "b"] }), ["a", "b"]],
    [arg({ type: "bool" }), ["false", "true"]],
    [arg({ type: "bool", defaultValue: "true" }), ["true", "false"]],
    [arg({ type: "path" }), null],
    [arg({ type: "enum", required: false, enumValues: ["low", "high"] }), [UNSET_CHOICE, "low", "high"]],
    [arg({ type: "enum", required: false, enumValues: ["low", "high"], defaultValue: "high" }), ["low", "high"]],
  ])("%#", (spec, want) => {
    expect(argChoices(spec)).toEqual(want);
  });
});

describe("optional enum prompts (session.new model/effort)", () => {
  const c = cmd({
    name: "session.new",
    args: [
      arg({ name: "worktree", type: "path", required: false }),
      arg({ name: "model", type: "enum", required: false, enumValues: ["opus", "sonnet"], defaultValue: "opus" }),
      arg({ name: "effort", type: "enum", required: false, enumValues: ["low", "high"] }),
      arg({ name: "prompt", required: false }),
    ],
  });

  it("prompts enums even when optional, not other optional args", () => {
    expect(promptedArgs(c).map((a) => a.name)).toEqual(["model", "effort"]);
  });

  it("sends the picked value, and omits an optional enum left at Default", () => {
    const s1 = submitArg(startPrompt(c), "sonnet");
    if (s1.kind !== "next") throw new Error("expected next");
    expect(submitArg(s1.prompt, UNSET_CHOICE)).toEqual({ kind: "done", values: { model: "sonnet" } });
    expect(submitArg(s1.prompt, "high")).toEqual({ kind: "done", values: { model: "sonnet", effort: "high" } });
  });
});

describe("arg prompt sequence", () => {
  const c = cmd({
    args: [arg({ name: "branch" }), arg({ name: "base", required: false }), arg({ name: "n", type: "int" })],
  });

  it("prompts only required args, in order", () => {
    expect(promptedArgs(c).map((a) => a.name)).toEqual(["branch", "n"]);
  });

  it("collects values, reports errors without advancing, and finishes", () => {
    const p0 = startPrompt(c);
    const s1 = submitArg(p0, "feat/x");
    expect(s1.kind).toBe("next");
    if (s1.kind !== "next") return;
    expect(submitArg(s1.prompt, "abc")).toEqual({ kind: "error", error: "n must be a whole number" });
    expect(submitArg(s1.prompt, "3")).toEqual({ kind: "done", values: { branch: "feat/x", n: "3" } });
  });

  it("goes back and forgets the previous value", () => {
    const s1 = submitArg(startPrompt(c), "feat/x");
    if (s1.kind !== "next") throw new Error("expected next");
    const back = previousArg(s1.prompt);
    expect(back?.index).toBe(0);
    expect(back?.values).toEqual({});
    expect(back && previousArg(back)).toBeNull();
  });
});

describe("groupByCategory", () => {
  it("sorts categories and titles", () => {
    const groups = groupByCategory([cmd({ name: "b", title: "Zed", category: "T" }), cmd({ name: "a", title: "Alpha", category: "T" }), cmd({ name: "c", title: "Mid", category: "R" })]);
    expect(groups.map(([cat, list]) => [cat, list.map((x) => x.title)])).toEqual([
      ["R", ["Mid"]],
      ["T", ["Alpha", "Zed"]],
    ]);
  });
});
