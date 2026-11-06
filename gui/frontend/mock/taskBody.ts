/**
 * pr.checkbox on a fixture's description, for mock/prDetail.ts and src/test/prWorld.ts: the
 * daemon's answers (internal/store/gh/task_items.go) for bodies with plain task lines, which
 * is all the fixtures hold.
 */
const TASK_LINE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+)(.*)$/gm;

export type TaskChange = { body: string; changed: boolean } | { refusal: string };

export function setTaskLine(body: string, index: number, shown: string, checked: boolean): TaskChange {
  const lines = [...body.matchAll(TASK_LINE)];
  const line = lines[index];
  if (!line) return { refusal: `has no task ${String(index + 1)} in its description any more (it has ${String(lines.length)})` };
  const [, head = "", mark = "", tail = "", text = ""] = line;
  if (text.trim() !== shown) return { refusal: `has a different task ${String(index + 1)} in its description now ("${text.trim()}", was "${shown}")` };
  if ((mark !== " ") === checked) return { body, changed: false };
  const at = line.index;
  return { body: `${body.slice(0, at)}${head}${checked ? "x" : " "}${tail}${text}${body.slice(at + line[0].length)}`, changed: true };
}

/** The daemon's message for a change. */
export const taskMessage = (number: number, index: number, checked: boolean): string => `${checked ? "Checked" : "Unchecked"} task ${String(index + 1)} on #${String(number)}`;
