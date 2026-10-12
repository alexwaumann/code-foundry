/**
 * What a rendered thread's pending request carries, read from its JSON: Claude's
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

