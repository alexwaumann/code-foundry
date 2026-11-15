/**
 * JSON as the Tree and Records previews read it. Not JSON.parse, for three reasons a viewer
 * cares about: object keys keep the file's order (JSON.parse moves integer-like keys first),
 * numbers keep their text (no precision lost on a 64-bit id, `1.0` stays `1.0`), and a
 * syntax error says where it is (WebKit's JSON.parse gives no position). Strict RFC 8259,
 * or JSONC (comments and trailing commas) when asked. Pure.
 */
import { memoByText } from "./memo";
import { plural } from "./table";

export type JsonNode =
  | { readonly t: "object"; readonly entries: readonly (readonly [string, JsonNode])[] }
  | { readonly t: "array"; readonly items: readonly JsonNode[] }
  | { readonly t: "string"; readonly v: string }
  | { readonly t: "number"; readonly raw: string }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "null" };

export interface JsonError {
  readonly message: string;
  /** Character offset into the text parsed. */
  readonly offset: number;
  /** 1-based. */
  readonly line: number;
  /** 1-based, in characters. */
  readonly column: number;
}

export type JsonParse = { readonly ok: true; readonly value: JsonNode } | { readonly ok: false; readonly error: JsonError };

export interface JsonOptions {
  /** JSONC: `//` and `/* *\/` comments, and a comma before `]` or `}`. */
  readonly jsonc?: boolean;
}

class Fail extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** Where `offset` is in `text`, 1-based. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, column: offset - start + 1 };
}

/** What a character is called in an error: `'x'`, or a name for one that does not print. */
function shown(text: string, at: number): string {
  if (at >= text.length) return "end of file";
  const c = text[at] ?? "";
  if (c === "\n" || c === "\r") return "line break";
  if (c === "\t") return "tab";
  return `'${c}'`;
}

export function parseJson(text: string, options: JsonOptions = {}): JsonParse {
  const jsonc = options.jsonc === true;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const space = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        i++;
        continue;
      }
      if (c === 47 /* / */) {
        const next = text.charCodeAt(i + 1);
        if (next !== 47 && next !== 42) throw new Fail(`Unexpected '/'`, i);
        if (!jsonc) throw new Fail("Comments are not allowed in JSON", i);
        if (next === 47) {
          const end = text.indexOf("\n", i);
          i = end < 0 ? n : end;
        } else {
          const end = text.indexOf("*/", i + 2);
          if (end < 0) throw new Fail("Unclosed comment", i);
          i = end + 2;
        }
        continue;
      }
      return;
    }
  };

  const string = (): string => {
    const open = i;
    i++; // the opening quote
    let out = "";
    for (;;) {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 34 || c === 92 || c < 32) break;
        j++;
      }
      out += text.slice(i, j);
      i = j;
      if (i >= n) throw new Fail("Unclosed string", open);
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return out;
      }
      if (c < 32) throw new Fail(`Unescaped ${c === 10 ? "line break" : "control character"} in a string`, i);
      // A backslash.
      const e = text[i + 1] ?? "";
      if (e === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Fail("Bad \\u escape", i);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const r = ESCAPES[e];
        if (r === undefined) throw new Fail(`Bad escape '\\${e}'`, i);
        out += r;
        i += 2;
      }
    }
  };

  const word = (w: string): boolean => {
    if (text.startsWith(w, i)) {
      const after = text.charCodeAt(i + w.length);
      // `trueish` is not `true`.
      if (!(after >= 97 && after <= 122)) {
        i += w.length;
        return true;
      }
    }
    return false;
  };

  const value = (): JsonNode => {
    space();
    if (i >= n) throw new Fail("Unexpected end of file: expected a value", i);
    const c = text.charCodeAt(i);
    if (c === 123 /* { */) {
      i++;
      const entries: [string, JsonNode][] = [];
      space();
      if (text.charCodeAt(i) === 125) {
        i++;
        return { t: "object", entries };
      }
      for (;;) {
        space();
        if (text.charCodeAt(i) === 125 && entries.length > 0) {
          if (!jsonc) throw new Fail("Trailing comma before '}'", i);
          i++;
          return { t: "object", entries };
        }
        if (text.charCodeAt(i) !== 34) throw new Fail(`Expected a key in double quotes, found ${shown(text, i)}`, i);
        const key = string();
        space();
        if (text.charCodeAt(i) !== 58) throw new Fail(`Expected ':' after the key, found ${shown(text, i)}`, i);
        i++;
        entries.push([key, value()]);
        space();
        const d = text.charCodeAt(i);
        if (d === 44) {
          i++;
          continue;
        }
        if (d === 125) {
          i++;
          return { t: "object", entries };
        }
        throw new Fail(`Expected ',' or '}', found ${shown(text, i)}`, i);
      }
    }
    if (c === 91 /* [ */) {
      i++;
      const items: JsonNode[] = [];
      space();
      if (text.charCodeAt(i) === 93) {
        i++;
        return { t: "array", items };
      }
      for (;;) {
        space();
        if (text.charCodeAt(i) === 93 && items.length > 0) {
          if (!jsonc) throw new Fail("Trailing comma before ']'", i);
          i++;
          return { t: "array", items };
        }
        items.push(value());
        space();
        const d = text.charCodeAt(i);
        if (d === 44) {
          i++;
          continue;
        }
        if (d === 93) {
          i++;
          return { t: "array", items };
        }
        throw new Fail(`Expected ',' or ']', found ${shown(text, i)}`, i);
      }
    }
    if (c === 34) return { t: "string", v: string() };
    if (c === 45 || (c >= 48 && c <= 57)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m || m[0] === "-") throw new Fail("Bad number", i);
      const end = i + m[0].length;
      const after = text.charCodeAt(end);
      // `01`, `1.`, `1e`: a number that stops early is not one.
      if ((after >= 48 && after <= 57) || after === 46 || after === 101 || after === 69) throw new Fail("Bad number", i);
      i = end;
      return { t: "number", raw: m[0] };
    }
    if (word("true")) return { t: "bool", v: true };
    if (word("false")) return { t: "bool", v: false };
    if (word("null")) return { t: "null" };
    throw new Fail(`Unexpected ${shown(text, i)}`, i);
  };

  try {
    const root = value();
    space();
    if (i < n) throw new Fail(`Unexpected ${shown(text, i)} after the value`, i);
    return { ok: true, value: root };
  } catch (e) {
    const fail = e instanceof Fail ? e : new Fail(e instanceof RangeError ? "Nested too deeply to show" : String(e), i);
    const at = Math.min(fail.at, n);
    return { ok: false, error: { message: fail.message, offset: at, ...lineColumn(text, at) } };
  }
}

/** The number of children of an object or array; 0 for anything else. */
export function childCount(node: JsonNode): number {
  return node.t === "object" ? node.entries.length : node.t === "array" ? node.items.length : 0;
}

/** `{5}` or `[3]`; "" for a value with no children. */
export function countLabel(node: JsonNode): string {
  return node.t === "object" ? `{${String(node.entries.length)}}` : node.t === "array" ? `[${String(node.items.length)}]` : "";
}

/** The node as compact JSON text (a nested value copied into a spreadsheet cell). */
export function jsonText(node: JsonNode): string {
  switch (node.t) {
    case "object":
      return `{${node.entries.map(([k, v]) => `${JSON.stringify(k)}:${jsonText(v)}`).join(",")}}`;
    case "array":
      return `[${node.items.map(jsonText).join(",")}]`;
    case "string":
      return JSON.stringify(node.v);
    case "number":
      return node.raw;
    case "bool":
      return String(node.v);
    case "null":
      return "null";
  }
}

/** Whether a path's JSON may have comments and trailing commas: .jsonc, and the config files every editor reads as JSONC. */
export function allowsComments(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.endsWith(".jsonc")) return true;
  if (/^[tj]sconfig(\..+)?\.json$/.test(name)) return true;
  if (lower.includes("/.vscode/") || name === "devcontainer.json" || name === ".devcontainer.json") return true;
  return false;
}

/** The read's parse, once per contents (the body and the meta share it). */
export const jsonOf = memoByText((text, path) => parseJson(text, { jsonc: allowsComments(path) }));

/** What row two counts for a document: an object's keys, an array's items, else the value's type. */
export function jsonSummary(p: JsonParse): string {
  if (!p.ok) return "Invalid";
  const v = p.value;
  if (v.t === "object") return plural(v.entries.length, "key");
  if (v.t === "array") return plural(v.items.length, "item");
  return v.t === "bool" ? "Boolean" : v.t === "null" ? "null" : v.t === "string" ? "String" : "Number";
}

/** The line the error is on, cut to about 80 characters around it, and the caret's column in what is shown. */
export function errorExcerpt(text: string, error: JsonError): { line: string; caret: number } {
  const start = text.lastIndexOf("\n", error.offset - 1) + 1;
  let end = text.indexOf("\n", error.offset);
  if (end < 0) end = text.length;
  const whole = text.slice(start, end).replace(/\r$/, "").replace(/\t/g, " ");
  const at = error.column - 1;
  const from = Math.max(0, at - 40);
  const shown = whole.slice(from, from + 80);
  return { line: (from > 0 ? "…" : "") + shown + (from + 80 < whole.length ? "…" : ""), caret: at - from + (from > 0 ? 1 : 0) };
}
