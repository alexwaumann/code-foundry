/**
 * Syntax highlighting for a thread's code (fenced blocks, diffs, shell commands):
 * lowlight (highlight.js grammars, the `common` set) run synchronously, so a streaming
 * block re-highlights as it grows without a flash. Output is plain tokens with hljs class
 * names; the colours are the terminal palette (components/thread/thread.css), so code
 * looks like the terminal it replaces. Highlighting goes line by line over the whole text
 * (multi-line strings and comments keep their colour on every line).
 */
import { common, createLowlight } from "lowlight";

const lowlight = createLowlight(common);

/** One styled run of a line: its text and the hljs classes around it ("" for none). */
export interface Token {
  text: string;
  cls: string;
}

/** The hast lowlight returns, as far as this file reads it. */
interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** Aliases highlight.js does not know, and file extensions, to grammar names. */
const ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  console: "shell",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  svg: "xml",
  vue: "xml",
  toml: "ini",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  kt: "kotlin",
  cs: "csharp",
  proto: "go",
  mk: "makefile",
  gql: "graphql",
};

/** The grammar for a fence's info string or a language name, or "" when there is none. */
export function grammarFor(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (!l) return "";
  const name = ALIASES[l] ?? l;
  return lowlight.registered(name) ? name : "";
}

/** The grammar for a file path, by its extension or name ("" when unknown). */
export function grammarForPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "Makefile" || base === "makefile") return "makefile";
  if (base === "Dockerfile") return "bash";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? grammarFor(base.slice(dot + 1)) : "";
}

function classesOf(n: HastNode): string {
  const c = n.properties?.className;
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === "string").join(" ") : "";
}

/** The hast tree as lines of tokens (text split at newlines, classes carried across). */
export function treeLines(root: HastNode): Token[][] {
  const lines: Token[][] = [[]];
  const walk = (n: HastNode, cls: string) => {
    if (n.type === "text") {
      const parts = (n.value ?? "").split("\n");
      parts.forEach((p, i) => {
        if (i > 0) lines.push([]);
        if (p) lines[lines.length - 1]?.push({ text: p, cls });
      });
      return;
    }
    const own = n.type === "element" ? classesOf(n) : "";
    const next = own ? (cls ? `${cls} ${own}` : own) : cls;
    for (const c of n.children ?? []) walk(c, next);
  };
  walk(root, "");
  return lines;
}

/** Code as lines of tokens, highlighted with `grammar` (grammarFor) or plain when "". */
export function highlightLines(code: string, grammar: string): Token[][] {
  if (!grammar) return code.split("\n").map((text) => (text ? [{ text, cls: "" }] : []));
  try {
    return treeLines(lowlight.highlight(grammar, code));
  } catch {
    return code.split("\n").map((text) => (text ? [{ text, cls: "" }] : []));
  }
}

/**
 * A shell command's tokens, coloured like the sketch's command lines: the command word of
 * each pipeline segment ("sh-cmd"), flags ("sh-flag"), quoted strings ("sh-str"),
 * operators and the rest plain.
 */
export function shellTokens(command: string): Token[] {
  const out: Token[] = [];
  const re = /("(?:\\.|[^"\\])*"?|'[^']*'?|\s+|&&|\|\||[|;&()<>]|[^\s"'|;&()<>]+)/g;
  let expectCmd = true;
  for (const m of command.matchAll(re)) {
    const t = m[0];
    let cls = "";
    if (/^\s+$/.test(t)) {
      if (t.includes("\n")) expectCmd = true;
    } else if (/^(&&|\|\||[|;&()])$/.test(t)) {
      expectCmd = true;
    } else if (t.startsWith('"') || t.startsWith("'")) {
      cls = "sh-str";
      expectCmd = false;
    } else if (expectCmd && !/^\w+=/.test(t)) {
      cls = "sh-cmd";
      expectCmd = false;
    } else if (t.startsWith("-")) {
      cls = "sh-flag";
    }
    const last = out[out.length - 1];
    if (last && last.cls === cls && cls === "") last.text += t;
    else out.push({ text: t, cls });
  }
  return out;
}

/** A token that may fall inside a diff line's changed span. */
export interface MarkedToken extends Token {
  marked: boolean;
}

/** Splits a line's tokens at a changed span [start, end) (lib/diff mark); everything unmarked without one. */
export function markTokens(tokens: readonly Token[], mark: readonly [number, number] | undefined): MarkedToken[] {
  if (!mark || mark[0] >= mark[1]) return tokens.map((t) => ({ ...t, marked: false }));
  const out: MarkedToken[] = [];
  let pos = 0;
  for (const t of tokens) {
    const end = pos + t.text.length;
    const cuts = [pos, Math.min(Math.max(mark[0], pos), end), Math.min(Math.max(mark[1], pos), end), end];
    for (let i = 0; i < 3; i++) {
      const a = cuts[i] ?? pos;
      const b = cuts[i + 1] ?? end;
      if (b > a) out.push({ text: t.text.slice(a - pos, b - pos), cls: t.cls, marked: i === 1 });
    }
    pos = end;
  }
  return out;
}
