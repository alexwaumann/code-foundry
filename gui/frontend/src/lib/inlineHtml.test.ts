import { describe, expect, it } from "vitest";
import { buildInline, inlineTag, type HastNode } from "./inlineHtml";

describe("inlineTag", () => {
  it.each<[string, ReturnType<typeof inlineTag>]>([
    ["<small>", { kind: "open", name: "small" }],
    ["</small>", { kind: "close", name: "small" }],
    ["<MARK>", { kind: "open", name: "mark" }],
    ["<kbd >", { kind: "open", name: "kbd" }],
    ["<br>", { kind: "br" }],
    ["<br/>", { kind: "br" }],
    ["<br />", { kind: "br" }],
    ["</br>", null],
    ["<small/>", null],
    ['<small class="x">', null],
    ["<pasted_content>", null],
    ["<file>", null],
    ["<div>", null],
    ["<script>", null],
    ["<!-- note -->", null],
    ["<small>\nfine\n</small>", null],
  ])("%j", (raw, want) => {
    expect(inlineTag(raw)).toEqual(want);
  });
});

describe("buildInline", () => {
  const raw = (value: string): HastNode => ({ type: "raw", value });
  const t = (value: string): HastNode => ({ type: "text", value });
  /** The nodes as a compact string: elements as <tag>…</tag>, text as is. */
  const show = (ns: readonly HastNode[]): string => ns.map((n) => (n.type === "element" ? `<${n.tagName ?? ""}>${show(n.children ?? [])}</${n.tagName ?? ""}>` : `"${n.value ?? ""}"`)).join("");

  it.each<[string, HastNode[], string]>([
    ["a matched pair", [t("a "), raw("<small>"), t("b"), raw("</small>"), t(" c")], `"a "<small>"b"</small>" c"`],
    ["an unclosed open tag: literal, its content kept after it", [raw("<small>"), t("b")], `"<small>""b"`],
    ["a stray close tag", [t("a"), raw("</small>")], `"a""</small>"`],
    ["an unknown tag", [raw("<file>"), t("x"), raw("</file>")], `"<file>""x""</file>"`],
    ["nested pairs", [raw("<small>"), raw("<mark>"), t("x"), raw("</mark>"), raw("</small>")], `<small><mark>"x"</mark></small>`],
    ["a closing tag past an unclosed inner one", [raw("<small>"), raw("<mark>"), t("x"), raw("</small>")], `<small>"<mark>""x"</small>`],
    ["br", [t("a"), raw("<br>"), t("b")], `"a"<br></br>"b"`],
  ])("%s", (_name, children, want) => {
    expect(show(buildInline(children))).toBe(want);
  });
});
