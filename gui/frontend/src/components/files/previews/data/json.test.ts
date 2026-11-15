import { describe, expect, it } from "vitest";
import { allowsComments, errorExcerpt, jsonSummary, jsonText, parseJson, type JsonNode } from "./json";

/** A node back as plain JS, to compare (numbers as their text). */
function plain(n: JsonNode): unknown {
  switch (n.t) {
    case "object":
      return { $entries: n.entries.map(([k, v]) => [k, plain(v)]) };
    case "array":
      return n.items.map(plain);
    case "string":
      return n.v;
    case "number":
      return { $n: n.raw };
    case "bool":
      return n.v;
    case "null":
      return null;
  }
}

describe("parseJson", () => {
  it.each<[string, string, unknown]>([
    ["object keeps key order", '{"b":1,"10":2,"2":3}', { $entries: [["b", { $n: "1" }], ["10", { $n: "2" }], ["2", { $n: "3" }]] }],
    ["numbers keep their text", "[1.0, 12345678901234567890, -0.5e-3, 0]", [{ $n: "1.0" }, { $n: "12345678901234567890" }, { $n: "-0.5e-3" }, { $n: "0" }]],
    ["escapes", '"a\\"b\\\\c\\n\\u00e9\\/"', 'a"b\\c\né/'],
    ["surrogate pair", '"\\ud83d\\ude00"', "😀"],
    ["literals", "[true,false,null]", [true, false, null]],
    ["whitespace and BOM", '﻿ \n\t{ "a" : [ ] }\r\n', { $entries: [["a", []]] }],
    ["duplicate keys both kept", '{"a":1,"a":2}', { $entries: [["a", { $n: "1" }], ["a", { $n: "2" }]] }],
    ["scalar root", '"just text"', "just text"],
    ["empty containers", '{"o":{},"a":[]}', { $entries: [["o", { $entries: [] }], ["a", []]] }],
  ])("%s", (_name, text, want) => {
    const p = parseJson(text);
    if (!p.ok) throw new Error(p.error.message);
    expect(plain(p.value)).toEqual(want);
  });

  // Each case: the text, the start of the message, and where (line, column).
  it.each<[string, string, string, number, number]>([
    ["empty", "", "Unexpected end of file", 1, 1],
    ["trailing comma", '{"a": 1,}', "Trailing comma before '}'", 1, 9],
    ["missing comma", '{\n  "a": 1\n  "b": 2\n}', "Expected ',' or '}', found '\"'", 3, 3],
    ["unquoted key", "{a: 1}", "Expected a key in double quotes, found 'a'", 1, 2],
    ["single quotes", "['x']", "Unexpected '''", 1, 2],
    ["comment", '{"a": 1 // no\n}', "Comments are not allowed in JSON", 1, 9],
    ["unclosed string", '{"a": "b', "Unclosed string", 1, 7],
    ["line break in a string", '"a\nb"', "Unescaped line break in a string", 1, 3],
    ["bad escape", '"\\x"', "Bad escape '\\x'", 1, 2],
    ["leading zero", "[01]", "Bad number", 1, 2],
    ["bare minus", "-", "Bad number", 1, 1],
    ["text after the value", '{"a":1} x', "Unexpected 'x' after the value", 1, 9],
    ["two values", "1 2", "Unexpected '2' after the value", 1, 3],
    ["truncated", '{"a": [1, 2', "Expected ',' or ']', found end of file", 1, 12],
    ["NaN", "[NaN]", "Unexpected 'N'", 1, 2],
    ["trueish", "trueish", "Unexpected 't'", 1, 1],
  ])("%s fails", (_name, text, message, line, column) => {
    const p = parseJson(text);
    if (p.ok) throw new Error("parsed");
    expect(p.error.message.startsWith(message)).toBe(true);
    expect([p.error.line, p.error.column]).toEqual([line, column]);
  });

  it("reads JSONC: comments and trailing commas", () => {
    const text = '// top\n{\n  /* block */ "a": [1, 2,], // after\n  "b": 3,\n}\n';
    const p = parseJson(text, { jsonc: true });
    if (!p.ok) throw new Error(p.error.message);
    expect(plain(p.value)).toEqual({ $entries: [["a", [{ $n: "1" }, { $n: "2" }]], ["b", { $n: "3" }]] });
    expect(parseJson("/* open", { jsonc: true }).ok).toBe(false);
  });

  it("refuses nesting too deep to walk, without throwing", () => {
    const p = parseJson("[".repeat(200_000));
    expect(p.ok).toBe(false);
  });
});

describe("helpers", () => {
  it.each<[string, boolean]>([
    ["/x/a.json", false],
    ["/x/a.jsonc", true],
    ["/x/tsconfig.json", true],
    ["/x/tsconfig.app.json", true],
    ["/x/jsconfig.json", true],
    ["/x/.vscode/settings.json", true],
    ["/x/.devcontainer/devcontainer.json", true],
    ["/x/package.json", false],
  ])("allowsComments(%s) = %s", (path, want) => {
    expect(allowsComments(path)).toBe(want);
  });

  it("writes compact JSON back", () => {
    const p = parseJson('{ "a" : [ 1.50, "x\\"y", null, {} ] }');
    if (!p.ok) throw new Error(p.error.message);
    expect(jsonText(p.value)).toBe('{"a":[1.50,"x\\"y",null,{}]}');
  });

  it.each<[string, string]>([
    ['{"a":1,"b":2}', "2 keys"],
    ['{"a":1}', "1 key"],
    ["[1,2,3]", "3 items"],
    ['"x"', "String"],
    ["4", "Number"],
    ["{", "Invalid"],
  ])("summary of %s", (text, want) => {
    expect(jsonSummary(parseJson(text))).toBe(want);
  });

  it("cuts the error's line around the error, with the caret under it", () => {
    const text = `{\n  "key": ${"x".repeat(100)}\n}`;
    const p = parseJson(text);
    if (p.ok) throw new Error("parsed");
    const { line, caret } = errorExcerpt(text, p.error);
    expect(line.startsWith('  "key": xxx')).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line[caret]).toBe("x");
    expect(caret).toBe(9);
  });
});
