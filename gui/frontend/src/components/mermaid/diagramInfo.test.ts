import { describe, expect, it } from "vitest";
import { diagramMeta, diagramTypeOf, isMermaidFence, messageSummary } from "./diagramInfo";

describe("diagramTypeOf", () => {
  it.each<[string, string, string | null]>([
    ["flowchart", "flowchart TD\n  a --> b", "Flowchart"],
    ["graph (the old keyword)", "graph LR\n  a --> b", "Flowchart"],
    ["sequence", "sequenceDiagram\n  a->>b: hi", "Sequence diagram"],
    ["a version suffix", "stateDiagram-v2\n  [*] --> a", "State diagram"],
    ["a beta suffix", "xychart-beta\n  x-axis [a]", "XY chart"],
    ["any case", "ERDIAGRAM\n  A ||--o{ B : has", "ER diagram"],
    ["comments and directives first", "%% the system\n%%{init: {\"theme\": \"dark\"}}%%\n\n  classDiagram\n  A <|-- B", "Class diagram"],
    ["front matter first", "---\ntitle: Flow\nconfig:\n  theme: base\n---\npie\n  \"a\": 1", "Pie chart"],
    ["front matter never closed", "---\ntitle: Flow\nflowchart TD", null],
    ["an unknown keyword", "notADiagram\n  a --> b", null],
    ["empty", "", null],
    ["blank lines only", "\n\n  \n", null],
  ])("%s", (_, source, want) => {
    expect(diagramTypeOf(source)).toBe(want);
  });
});

describe("diagramMeta", () => {
  it.each<[string | null, number | null, string]>([
    ["Flowchart", 9, "Flowchart · 9 nodes · 312 B · Mermaid"],
    ["Flowchart", 1, "Flowchart · 1 node · 312 B · Mermaid"],
    ["Sequence diagram", null, "Sequence diagram · 312 B · Mermaid"],
    [null, null, "312 B · Mermaid"],
  ])("%s, %s nodes", (type, nodes, want) => {
    expect(diagramMeta(type, nodes, "312 B")).toBe(want);
  });
});

describe("isMermaidFence: which fences become a diagram", () => {
  it.each<[string, boolean]>([
    ["mermaid", true],
    ["Mermaid", true],
    [" mermaid ", true],
    ["", false],
    ["mmd", false],
    ["mermaid-js", false],
    ["ts", false],
  ])("%j → %s", (lang, want) => {
    expect(isMermaidFence(lang)).toBe(want);
  });
});

describe("messageSummary", () => {
  it.each<[string, string, string]>([
    ["one line", "No diagram type detected matching given configuration for text: x", "No diagram type detected matching given configuration for text: x"],
    ["a parse error: its heading and its expectation", "Parse error on line 3:\n...b --> --> c\n---------^\nExpecting 'AMP', 'COLON', got 'LINK'", "Parse error on line 3: Expecting 'AMP', 'COLON', got 'LINK'"],
    ["a first line that is a sentence", "Lexical error.\nmore", "Lexical error."],
  ])("%s", (_, message, want) => {
    expect(messageSummary(message)).toBe(want);
  });
});
