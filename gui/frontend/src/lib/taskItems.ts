/**
 * The task-list items of a body a surface lets people tick (MarkdownExtras.task), counted
 * as the daemon counts them (internal/store/gh/task_items.go): the index a click sends must
 * name the same box there. internal/store/gh/testdata/task_items.json holds the cases both
 * sides' tests check.
 *
 * An item is what remark calls one, whose first block is a paragraph and whose box is
 * "[ ]", "[x]" or "[X]", outside footnotes (they render apart from where they are written,
 * and only when referenced). Nothing else is one, whatever it renders as: a box in raw HTML
 * becomes an <input> too, so telling them apart takes two passes. remarkTaskItems numbers
 * the items and leaves the number on the <li>; rehypeTaskItems, which runs before rehype-raw
 * so raw HTML is still text, moves it onto the <input> remark made for that item. MARK keeps
 * a body from writing the attribute itself.
 */
import type { HastNode } from "./inlineHtml";

export interface TaskItem {
  /** From 0 in source order, nested items after their parent. */
  index: number;
  checked: boolean;
  /** The rest of the box's source line without the spaces around it. The daemon compares it. */
  text: string;
}

/** On a box's <input>: MARK and its index, and its text. markdownPlugins lets them through the sanitizer. */
export const TASK_PROP = "dataCfTask";
export const TASK_TEXT_PROP = "dataCfTaskText";

/** New on every load, so no body can know it. */
const MARK = Math.random().toString(36).slice(2);

interface MdastNode {
  type: string;
  checked?: boolean | null;
  children?: MdastNode[];
  position?: { start: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

/** The item's text, when the source at start (its list marker) reaches a box. */
function taskText(source: string, start: number): string | null {
  const box = source.indexOf("[", start);
  if (box < 0 || !/^\[[ xX]\]/.test(source.slice(box, box + 3))) return null;
  const line = /^[^\r\n]*/.exec(source.slice(box + 3))?.[0] ?? "";
  return line.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Numbers the real task items, on their <li>. */
export function remarkTaskItems() {
  return (tree: MdastNode, file: { toString(): string }) => {
    const source = file.toString();
    let index = 0;
    const walk = (n: MdastNode) => {
      if (n.type === "footnoteDefinition") return;
      const start = n.position?.start.offset;
      if (n.type === "listItem" && typeof n.checked === "boolean" && n.children?.[0]?.type === "paragraph" && start !== undefined) {
        const text = taskText(source, start);
        if (text !== null) {
          n.data = { ...n.data, hProperties: { ...n.data?.hProperties, [TASK_PROP]: `${MARK}:${String(index)}`, [TASK_TEXT_PROP]: text } };
          index++;
        }
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** The <input> remark made for a task <li>: first in it, or first in its first paragraph (a loose list). */
function boxOf(li: HastNode): HastNode | undefined {
  const first = li.children?.find((c) => c.type === "element");
  return first?.tagName === "p" ? first.children?.find((c) => c.type === "element" && c.tagName === "input") : first?.tagName === "input" ? first : undefined;
}

/** Moves the number from each task <li> to its <input>. Must run before rehype-raw. */
export function rehypeTaskItems() {
  const walk = (n: HastNode) => {
    if (n.tagName === "li" && n.properties?.[TASK_PROP] !== undefined) {
      const { [TASK_PROP]: mark, [TASK_TEXT_PROP]: text, ...rest } = n.properties;
      n.properties = rest;
      const box = boxOf(n);
      if (box) box.properties = { ...box.properties, [TASK_PROP]: mark, [TASK_TEXT_PROP]: text };
    }
    n.children?.forEach(walk);
  };
  return walk;
}

/** The task item an <input> is, or null: a box in raw HTML, or any other, is none. */
export function taskItemOf(node: { properties?: Record<string, unknown> } | undefined): TaskItem | null {
  const mark = node?.properties?.[TASK_PROP];
  if (typeof mark !== "string" || !mark.startsWith(`${MARK}:`)) return null;
  const text = node?.properties?.[TASK_TEXT_PROP];
  return { index: Number(mark.slice(MARK.length + 1)), checked: node?.properties?.checked === true, text: typeof text === "string" ? text : "" };
}
