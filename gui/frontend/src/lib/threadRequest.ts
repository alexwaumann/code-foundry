/**
 * What a thread's pending request carries, read from its JSON: Claude's
 * permission suggestions ("Allow for session adds Bash(git push:*)") and an
 * AskUserQuestion's questions. Pure.
 */
import { parseObject, str, type Json } from "./toolSummary";

/** "Bash(git push:*)" for each rule Claude suggests keeping for the session. */
export function suggestedRules(json: string): string[] {
  if (!json) return [];
  try {
    const list: unknown = JSON.parse(json);
    if (!Array.isArray(list)) return [];
    return (list as Json[]).flatMap((s) => {
      const rules = Array.isArray(s.rules) ? (s.rules as Json[]) : [];
      return rules.map((r) => (str(r, "ruleContent") ? `${str(r, "toolName")}(${str(r, "ruleContent")})` : str(r, "toolName"))).filter(Boolean);
    });
  } catch {
    return [];
  }
}

/** How many suggestions Claude made: "Allow for session" applies them all (0: no such button). */
export function suggestionCount(json: string): number {
  if (!json) return 0;
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

const MODE_LABELS: Record<string, string> = { acceptEdits: "Accept edits", default: "Supervised", auto: "Auto", bypassPermissions: "Full access", dontAsk: "Don't ask" };

/** The permission mode a "setMode" suggestion switches the session to ("Accept edits"), or "". */
export function suggestedMode(json: string): string {
  if (!json) return "";
  try {
    const list: unknown = JSON.parse(json);
    if (!Array.isArray(list)) return "";
    const s = (list as Json[]).find((x) => str(x, "type") === "setMode");
    const mode = s ? str(s, "mode") : "";
    return MODE_LABELS[mode] ?? mode;
  } catch {
    return "";
  }
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** AskUserQuestion's questions from its input. */
export function questionsOf(inputJson: string): Question[] {
  const qs = parseObject(inputJson).questions;
  if (!Array.isArray(qs)) return [];
  return (qs as Json[]).map((q) => ({
    question: str(q, "question"),
    header: str(q, "header"),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => ({ label: str(o, "label"), description: str(o, "description") })),
  }));
}


/** What the user picked for one question: option indexes (one for single-select) and Other. */
export interface QuestionPick {
  selected: readonly number[];
  /** Other is chosen (single-select: instead of an option; multi-select: besides them). */
  other: boolean;
  otherText: string;
}

export const NO_PICK: QuestionPick = { selected: [], other: false, otherText: "" };

/** The pick after choosing option `index` (index === options: Other). Single-select replaces, multi-select toggles. */
export function pickOption(q: Question, pick: QuestionPick, index: number): QuestionPick {
  const isOther = index === q.options.length;
  if (index < 0 || index > q.options.length) return pick;
  if (!q.multiSelect) return isOther ? { ...pick, selected: [], other: true } : { ...pick, selected: [index], other: false };
  if (isOther) return { ...pick, other: !pick.other };
  const selected = pick.selected.includes(index) ? pick.selected.filter((i) => i !== index) : [...pick.selected, index].sort((a, b) => a - b);
  return { ...pick, selected };
}

/**
 * One question's answer as the daemon expects it (ThreadService.Respond answers, the same
 * shape Claude Code's own UI sends): the chosen label, Other's text, or for a multi-select
 * the labels in option order then Other's text, joined with ", ". "" when unanswered.
 */
export function answerOf(q: Question, pick: QuestionPick): string {
  const labels = pick.selected.flatMap((i) => (q.options[i] ? [q.options[i].label] : []));
  const other = pick.other ? pick.otherText.trim() : "";
  if (!q.multiSelect) return other || (pick.other ? "" : (labels[0] ?? ""));
  return [...labels, ...(other ? [other] : [])].join(", ");
}

/** Every question's answer, question text -> answer; null while one is unanswered. */
export function answersOf(questions: readonly Question[], picks: readonly QuestionPick[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = answerOf(q, picks[i] ?? NO_PICK);
    if (!a) return null;
    out[q.question] = a;
  }
  return out;
}

export type PermissionDecision = "allow" | "allow-session" | "deny";

/** The permission buttons in order, numbered from 1: Allow, Allow for session (only with a rule to keep), Deny. */
export function permissionChoices(sessionRule: boolean): PermissionDecision[] {
  return sessionRule ? ["allow", "allow-session", "deny"] : ["allow", "deny"];
}

/** What a key does to a docked prompt. */
export type PromptKeyAction =
  | { kind: "decide"; decision: PermissionDecision }
  | { kind: "pick"; index: number }
  | { kind: "submit" }
  | { kind: "skip" }
  | { kind: "editor" };

export type PromptShape = { kind: "permission"; sessionRule: boolean } | { kind: "question"; options: number };

export interface PromptKey {
  key: string;
  /** No cmd, ctrl or alt (shift is fine: it is how some layouts type digits). */
  plain: boolean;
  /** Where focus is: the prompt itself, or the composer's editor (with whether it is empty). */
  from: "prompt" | "editor";
  editorEmpty: boolean;
}

/**
 * Keyboard routing for the oldest docked prompt (or the one focused). Digits answer a
 * permission (1 Allow, 2 Allow for session or Deny, 3 Deny) or pick a question's option
 * (the last number is Other); Enter submits a question; Escape skips a question or, on a
 * permission, hands focus back to the editor. From the editor only an empty editor's
 * digits and Enter are taken (a digit typed into a message stays in it), never Escape.
 */
export function promptKey(shape: PromptShape, k: PromptKey): PromptKeyAction | null {
  if (!k.plain) return null;
  if (k.from === "editor" && (!k.editorEmpty || k.key === "Escape")) return null;
  const digit = /^[1-9]$/.test(k.key) ? Number(k.key) : 0;
  if (shape.kind === "permission") {
    if (digit) {
      const decision = permissionChoices(shape.sessionRule)[digit - 1];
      return decision ? { kind: "decide", decision } : null;
    }
    return k.key === "Escape" ? { kind: "editor" } : null;
  }
  if (digit) return digit <= shape.options + 1 ? { kind: "pick", index: digit - 1 } : null;
  if (k.key === "Enter") return { kind: "submit" };
  return k.key === "Escape" ? { kind: "skip" } : null;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * Why the thread's permission mode asked, for the prompt's hint line: "Accept edits asks
 * before commands". "" for Claude's default mode (unknown rules).
 */
export function modeHint(permissionMode: string, toolName: string): string {
  switch (permissionMode) {
    case "supervised":
      return "Supervised asks before every tool call";
    case "accept-edits":
      return EDIT_TOOLS.has(toolName) ? "Accept edits asks for files outside the project" : "Accept edits asks before commands";
    case "auto":
      return "Auto asks when Claude's classifier is unsure";
    default:
      return "";
  }
}

/**
 * Who asked, for a request a subagent raised: its Agent (Task) call's subagent_type and
 * description ("code-reviewer · Review the fingerprint change") on one line, either alone
 * when the other is missing, "subagent" when the call is not known (not loaded, or input
 * not parsed yet), cut at 100 characters.
 */
export function askingAgentLabel(agentInputJson: string): string {
  const input = parseObject(agentInputJson);
  const oneLine = (key: string) => str(input, key).replace(/\s+/g, " ").trim();
  const label = [oneLine("subagent_type"), oneLine("description")].filter(Boolean).join(" · ") || "subagent";
  // The chip ellipsizes in a narrow pane and its tooltip has the rest; a description is
  // meant to be a few words, so a runaway one is cut here.
  return label.length > AGENT_LABEL_MAX ? `${label.slice(0, AGENT_LABEL_MAX - 1).trimEnd()}…` : label;
}

const AGENT_LABEL_MAX = 100;
