/**
 * What /cf/jsx.js (src/pagelib/jsx.ts) reads in a page's script with Sucrase's own tokenizer
 * (the one its transform runs, so jsx.js carries no second parser): the import specifiers to
 * make absolute, JSX tags that close the wrong element (Sucrase compiles `<b>…</div>`
 * without a word), and the source line an error points at, numbered as in the .html file.
 * docs/notes/page-library-fixes-a.md.
 */
import { parse, type SucraseToken } from "sucrase/dist/esm/parser/index.js";
import { ContextualKeyword } from "sucrase/dist/esm/parser/tokenizer/keywords.js";
import { TokenType as tt } from "sucrase/dist/esm/parser/tokenizer/types.js";
import * as parser from "sucrase/dist/esm/parser/traverser/base.js";

/** The tokens of code, or as far as the parser got before a syntax error. */
function tokens(code: string, jsx: boolean): SucraseToken[] {
  try {
    return parse(code, jsx, jsx, false).tokens;
  } catch {
    return parser.state?.tokens ?? [];
  }
}

/** Whether t is the string of an import or export's `from`, a bare `import "x"`, or `import("x")`. */
function isSpecifier(toks: SucraseToken[], i: number): boolean {
  const prev = toks[i - 1];
  if (!prev) return false;
  if (prev.type === tt._import) return true;
  if (prev.type === tt.name && prev.contextualKeyword === ContextualKeyword._from) return true;
  return prev.type === tt.parenL && toks[i - 2]?.type === tt._import;
}

/**
 * code (compiled JS) with its relative and root-relative import specifiers made absolute
 * against from: a blob module has no base of its own. Only real specifiers: a string that
 * merely reads like an import (`"run: import './setup.js' first"`) stays as written.
 */
export function absolutize(code: string, from: string): string {
  const toks = tokens(code, false);
  let out = "";
  let at = 0;
  for (const [i, t] of toks.entries()) {
    if (t.type !== tt.string || !isSpecifier(toks, i)) continue;
    const quote = code[t.start] ?? '"';
    const spec = code.slice(t.start + 1, t.end - 1);
    if (!/^(\.{1,2})?\//.test(spec)) continue;
    out += code.slice(at, t.start) + quote + new URL(spec, from).href + quote;
    at = t.end;
  }
  return out + code.slice(at);
}

/** "(line:col)" of a position, 1-based line and 0-based column as Sucrase writes them. */
function loc(source: string, pos: number): string {
  const before = source.slice(0, pos);
  const line = before.split("\n").length;
  return `(${String(line)}:${String(pos - before.lastIndexOf("\n") - 1)})`;
}

/**
 * The first closing tag that does not close the element open there, as a Sucrase-style
 * message ending "(line:col)" at the closing tag, or "" when every tag matches (or the
 * tokens stop before a mismatch: Sucrase's own error then says what is wrong).
 */
export function tagMismatch(source: string): string {
  const toks = tokens(source, true);
  const open: { name: string; pos: number; head: boolean }[] = [];
  // The element name from token i: a.b.c or a:b, "" for a fragment.
  const nameAt = (i: number): { name: string; next: number } => {
    let j = i;
    if (toks[j]?.type !== tt.jsxName) return { name: "", next: j };
    while ((toks[j + 1]?.type === tt.dot || toks[j + 1]?.type === tt.colon) && toks[j + 2]) j += 2;
    return { name: source.slice(toks[i]?.start ?? 0, toks[j]?.end ?? 0), next: j + 1 };
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.type === tt.jsxTagStart && toks[i + 1]?.type === tt.slash) {
      const { name, next } = nameAt(i + 2);
      const top = open.pop();
      if (top && top.name !== name) {
        const what = (n: string) => (n ? `<${n}>` : "<>");
        const closing = name ? `</${name}>` : "</>";
        return `${closing} closes ${what(top.name)}, opened at ${loc(source, top.pos).slice(1, -1)}; expected ${top.name ? `</${top.name}>` : "</>"} ${loc(source, t.start)}`;
      }
      i = next;
      continue;
    }
    if (t.type === tt.jsxTagStart) {
      const { name } = nameAt(i + 1);
      open.push({ name, pos: t.start, head: true });
      continue;
    }
    if (t.type === tt.jsxTagEnd) {
      const top = open.at(-1);
      if (!top?.head) continue;
      if (toks[i - 1]?.type === tt.slash) open.pop();
      else top.head = false;
    }
  }
  return "";
}

/**
 * The source line an error message's "(line:col)" points at, with a caret under the column,
 * numbered from firstLine (the line of the .html file the script's text starts on). The
 * message's own location is rewritten to the file's line too. Unchanged when it has none.
 */
export function locate(source: string, msg: string, firstLine: number): { message: string; frame: string } {
  const m = /\((\d+):(\d+)\)\s*$/.exec(msg);
  if (!m) return { message: msg, frame: "" };
  const line = Number(m[1]);
  const col = Number(m[2]);
  const text = source.split("\n")[line - 1];
  const fileLine = line + firstLine - 1;
  const message = msg.slice(0, m.index) + `(${String(fileLine)}:${String(col)})`;
  if (text === undefined) return { message, frame: "" };
  return { message, frame: `\n${String(fileLine)} | ${text}\n${" ".repeat(String(fileLine).length + 3 + col)}^` };
}

/**
 * The line of html an inline script's text starts on: the first occurrence of text at or
 * after from (scripts are found in document order). 0 when it is not there.
 */
export function scriptLine(html: string, text: string, from = 0): { line: number; end: number } {
  const at = text ? html.indexOf(text, from) : -1;
  if (at < 0) return { line: 0, end: from };
  return { line: html.slice(0, at).split("\n").length, end: at + text.length };
}
