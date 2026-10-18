// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { locateQuote, quoteAt } from "@/lib/citation";
import { clampToRoot, offsetOf, plainText, rangeOf } from "./citeDom";

/** An answer as the markdown renders it: blocks with "\n" text nodes between them, inline code, a code block with its buttons. */
function answer(): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-cite-item", "i1");
  root.innerHTML =
    '<div class="cf-markdown"><p>The <code>gh/poller.go</code> fingerprints each PR.</p>\n<ul>\n<li>Touch it.</li>\n<li>Fold the <strong>head sha</strong> in.</li>\n</ul>\n<div class="cf-code"><pre><code>x := 1</code></pre><div class="cf-code-actions"><button>Copied</button></div></div></div><button class="copy-answer"></button>';
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("plainText", () => {
  it("text nodes in order, one newline between blocks, no button text, no whitespace between blocks", () => {
    expect(plainText(answer()).text).toBe("The gh/poller.go fingerprints each PR.\nTouch it.\nFold the head sha in.\nx := 1");
  });
});

describe("offsetOf / rangeOf", () => {
  it("a DOM point inside a text node, and back", () => {
    const root = answer();
    const pt = plainText(root);
    const strong = root.querySelector("strong")?.firstChild as Text;
    const at = offsetOf(pt, strong, 0);
    expect(pt.text.slice(at, at + 8)).toBe("head sha");
    const r = rangeOf(pt, at, at + 8);
    expect(r?.toString()).toBe("head sha");
  });

  it("an element boundary maps to the next text's start", () => {
    const root = answer();
    const pt = plainText(root);
    const ul = root.querySelector("ul") as HTMLElement;
    expect(pt.text.slice(offsetOf(pt, ul, 0)).startsWith("Touch it.")).toBe(true);
    expect(offsetOf(pt, root, root.childNodes.length)).toBe(pt.text.length);
  });

  it("a span across inline code and blocks: the range covers exactly its text", () => {
    const root = answer();
    const pt = plainText(root);
    const start = pt.text.indexOf("poller.go");
    const end = pt.text.indexOf("Touch") + 5;
    const r = rangeOf(pt, start, end);
    // The range spans the formatting newline between the blocks too.
    expect(r?.toString().replace(/\s+/g, " ")).toBe("poller.go fingerprints each PR. Touch");
    expect(rangeOf(pt, 5, 5)).toBeNull();
  });

  const TOOL_ROW = '<div style="user-select: none">Read 2 files</div>';
  it.each([
    ["ends at the next answer's start (a triple-click)", "", (next: Text) => [next.parentElement ?? next, 0] as const, true],
    ["ends past an unselectable tool row, at the next answer's start", TOOL_ROW, (next: Text) => [next.parentElement ?? next, 0] as const, true],
    ["ends in the whitespace before the next row", "", (next: Text) => [next.parentElement?.parentElement?.firstChild ?? next, 1] as const, true],
    ["runs into the next answer's text", "", (next: Text) => [next, 3] as const, false],
    ["runs past a selectable row's text", "<div>Read 2 files</div>", (next: Text) => [next.parentElement ?? next, 0] as const, false],
  ])("clampToRoot: a selection that %s", (_name, between, endAt, inside) => {
    const root = answer();
    const row = document.createElement("div");
    row.innerHTML = `\n${between}<p>The next answer.</p>`;
    document.body.appendChild(row);
    const next = row.querySelector("p")?.firstChild as Text;
    const li = root.querySelector("li")?.firstChild as Text;
    const r = document.createRange();
    r.setStart(li, 0);
    const [node, offset] = endAt(next);
    r.setEnd(node, offset);
    const c = clampToRoot(r, root);
    if (!inside) {
      expect(c).toBeNull();
      return;
    }
    expect(c).not.toBeNull();
    const pt = plainText(root);
    const q = c ? quoteAt(pt.text, offsetOf(pt, c.startContainer, c.startOffset), offsetOf(pt, c.endContainer, c.endOffset)) : null;
    expect(q?.text).toBe("Touch it.\nFold the head sha in.\nx := 1");
  });

  it("clampToRoot: a selection that starts before the root, past nothing selectable", () => {
    const root = answer();
    const prev = document.createElement("div");
    prev.innerHTML = TOOL_ROW;
    document.body.insertBefore(prev, root);
    const strong = root.querySelector("strong")?.firstChild as Text;
    const r = document.createRange();
    r.setStart(prev, 0);
    r.setEnd(strong, 4);
    const c = clampToRoot(r, root);
    expect(c?.toString().startsWith("The ")).toBe(true);
    expect(c?.toString().endsWith("head")).toBe(true);
  });

  it("clampToRoot: a selection inside the root is itself", () => {
    const root = answer();
    const strong = root.querySelector("strong")?.firstChild as Text;
    const r = document.createRange();
    r.setStart(strong, 0);
    r.setEnd(strong, 4);
    expect(clampToRoot(r, root)?.toString()).toBe("head");
  });

  it("a selection's quote is found again after the answer re-renders with text before it", () => {
    const root = answer();
    const pt = plainText(root);
    const s = pt.text.indexOf("Fold");
    const q = quoteAt(pt.text, s, s + "Fold the head sha".length);
    expect(q?.text).toBe("Fold the head sha");
    root.querySelector("p")?.insertAdjacentHTML("beforebegin", "<p>A new first paragraph.</p>");
    const again = plainText(root);
    const at = q ? locateQuote(again.text, q) : null;
    expect(at && again.text.slice(at.start, at.end)).toBe("Fold the head sha");
  });
});
