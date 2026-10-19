import { describe, expect, it } from "vitest";
import { answerOf, askingAgentLabel, answersOf, modeHint, NO_PICK, pickOption, permissionChoices, promptKey, questionsOf, suggestedMode, suggestedRules, suggestionCount, type Question, type QuestionPick } from "./threadRequest";

const single: Question = {
  question: "How should I push?",
  header: "Push",
  multiSelect: false,
  options: [
    { label: "Force with lease", description: "" },
    { label: "New branch", description: "" },
  ],
};
const multi: Question = { ...single, question: "Which checks?", multiSelect: true, options: [{ label: "test", description: "" }, { label: "vet", description: "" }, { label: "lint", description: "" }] };

describe("questions", () => {
  it("reads AskUserQuestion's input", () => {
    const qs = questionsOf(JSON.stringify({ questions: [{ question: "Q", header: "H", multiSelect: true, options: [{ label: "a" }] }] }));
    expect(qs).toEqual([{ question: "Q", header: "H", multiSelect: true, options: [{ label: "a", description: "" }] }]);
    expect(questionsOf("not json")).toEqual([]);
  });

  it("picks: single-select replaces, multi-select toggles, the last index is Other", () => {
    let p = pickOption(single, NO_PICK, 1);
    expect(p).toMatchObject({ selected: [1], other: false });
    p = pickOption(single, p, 2);
    expect(p).toMatchObject({ selected: [], other: true });
    p = pickOption(single, p, 0);
    expect(p).toMatchObject({ selected: [0], other: false });
    expect(pickOption(single, p, 7)).toBe(p);

    let m = pickOption(multi, NO_PICK, 2);
    m = pickOption(multi, m, 0);
    expect(m.selected).toEqual([0, 2]);
    m = pickOption(multi, m, 2);
    expect(m.selected).toEqual([0]);
    m = pickOption(multi, m, 3);
    expect(m).toMatchObject({ selected: [0], other: true });
  });

  it("formats answers the way the daemon (and Claude Code) expects", () => {
    const p = (over: Partial<QuestionPick>): QuestionPick => ({ ...NO_PICK, ...over });
    expect(answerOf(single, p({ selected: [1] }))).toBe("New branch");
    expect(answerOf(single, p({ other: true, otherText: "  push to main  " }))).toBe("push to main");
    expect(answerOf(single, p({ other: true, otherText: " " }))).toBe("");
    expect(answerOf(single, NO_PICK)).toBe("");
    expect(answerOf(multi, p({ selected: [0, 2] }))).toBe("test, lint");
    expect(answerOf(multi, p({ selected: [1], other: true, otherText: "race" }))).toBe("vet, race");
    expect(answerOf(multi, p({ other: true, otherText: "" }))).toBe("");
    expect(answersOf([single, multi], [p({ selected: [0] }), p({ selected: [1, 2] })])).toEqual({ "How should I push?": "Force with lease", "Which checks?": "vet, lint" });
    expect(answersOf([single, multi], [p({ selected: [0] })])).toBeNull();
  });
});

describe("permission prompts", () => {
  it("numbers the choices", () => {
    expect(permissionChoices(true)).toEqual(["allow", "allow-session", "deny"]);
    expect(permissionChoices(false)).toEqual(["allow", "deny"]);
  });

  it("reads Claude's suggested rules", () => {
    expect(suggestedRules(JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }, { toolName: "Read" }] }]))).toEqual(["Bash(git push:*)", "Read"]);
    expect(suggestedRules("")).toEqual([]);
  });

  it("reads the session mode Claude suggests and counts suggestions", () => {
    const json = JSON.stringify([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    expect(suggestedMode(json)).toBe("Accept edits");
    expect(suggestionCount(json)).toBe(1);
    expect(suggestionCount("")).toBe(0);
    expect(suggestedMode("[]")).toBe("");
  });

  it("hints why the mode asked", () => {
    expect(modeHint("accept-edits", "Bash")).toBe("Accept edits asks before commands");
    expect(modeHint("accept-edits", "Write")).toBe("Accept edits asks for files outside the project");
    expect(modeHint("supervised", "Read")).toBe("Supervised asks before edits and commands");
    expect(modeHint("", "Bash")).toBe("");
  });
});

describe("promptKey", () => {
  const perm = { kind: "permission" as const, sessionRule: true };
  const permNoRule = { kind: "permission" as const, sessionRule: false };
  const ask = { kind: "question" as const, options: 3 };
  const prompt = { plain: true, from: "prompt" as const, editorEmpty: false };
  const editor = (empty: boolean) => ({ plain: true, from: "editor" as const, editorEmpty: empty });

  it.each([
    ["1 allows", perm, { key: "1", ...prompt }, { kind: "decide", decision: "allow" }],
    ["2 allows for the session", perm, { key: "2", ...prompt }, { kind: "decide", decision: "allow-session" }],
    ["3 denies", perm, { key: "3", ...prompt }, { kind: "decide", decision: "deny" }],
    ["without a rule 2 denies", permNoRule, { key: "2", ...prompt }, { kind: "decide", decision: "deny" }],
    ["without a rule 3 is nothing", permNoRule, { key: "3", ...prompt }, null],
    ["Escape returns to the editor", perm, { key: "Escape", ...prompt }, { kind: "editor" }],
    ["an empty editor's digit answers", perm, { key: "1", ...editor(true) }, { kind: "decide", decision: "allow" }],
    ["a typed message keeps its digits", perm, { key: "1", ...editor(false) }, null],
    ["the editor's Escape is not the prompt's", perm, { key: "Escape", ...editor(true) }, null],
    ["modifiers are someone else's", perm, { key: "1", ...prompt, plain: false }, null],
    ["a digit picks an option", ask, { key: "2", ...prompt }, { kind: "pick", index: 1 }],
    ["the last number is Other", ask, { key: "4", ...prompt }, { kind: "pick", index: 3 }],
    ["past Other is nothing", ask, { key: "5", ...prompt }, null],
    ["Enter submits", ask, { key: "Enter", ...prompt }, { kind: "submit" }],
    ["an empty editor's Enter submits", ask, { key: "Enter", ...editor(true) }, { kind: "submit" }],
    ["Enter in a message sends it", ask, { key: "Enter", ...editor(false) }, null],
    ["Escape skips", ask, { key: "Escape", ...prompt }, { kind: "skip" }],
    ["letters are nothing", ask, { key: "a", ...prompt }, null],
  ])("%s", (_name, shape, k, want) => {
    expect(promptKey(shape, k)).toEqual(want);
  });
});

describe("askingAgentLabel", () => {
  it.each([
    [JSON.stringify({ description: "Review the fingerprint change", subagent_type: "code-reviewer", prompt: "…" }), "code-reviewer · Review the fingerprint change"],
    [JSON.stringify({ description: "Create sub.txt" }), "Create sub.txt"],
    [JSON.stringify({ subagent_type: "Explore" }), "Explore"],
    [JSON.stringify({ description: "  ", subagent_type: "" }), "subagent"],
    ['{"description": "partial', "subagent"],
    ["", "subagent"],
    [JSON.stringify({ subagent_type: "general-purpose", description: "Check\n  the   logs" }), "general-purpose · Check the logs"],
    [JSON.stringify({ subagent_type: "general-purpose", description: "word ".repeat(40) }), `general-purpose · ${"word ".repeat(16)}w…`],
  ])("%s → %s", (json, want) => {
    const got = askingAgentLabel(json);
    expect(got).toBe(want);
    expect(got.length).toBeLessThanOrEqual(100);
  });
});
