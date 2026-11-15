import { describe, expect, it } from "vitest";
import { inertCss, sanitizeSvg } from "./sanitizeSvg";

/** An SVG shaped like Mermaid's output around `inner`. */
function svg(inner: string, style = "#d1 .node rect{fill:#222}"): string {
  return `<svg id="d1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50"><style>${style}</style><defs><marker id="d1_arrow"><path d="M0 0L10 5z"/></marker></defs><g class="root">${inner}</g></svg>`;
}

/** The sanitized markup, parsed as the page parses it. */
function clean(markup: string): HTMLElement {
  const box = document.createElement("div");
  box.innerHTML = sanitizeSvg(markup);
  return box;
}

/** Every attribute in the tree, as name=value. */
function attrs(root: Element): string[] {
  return [...root.querySelectorAll("*")].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`));
}

describe("sanitizeSvg: a diagram renders inert", () => {
  it("keeps what Mermaid draws: shapes, text, markers, its id-scoped style", () => {
    const box = clean(svg('<g class="node" id="flowchart-a-0"><rect class="basic label-container" x="0" y="0" width="40" height="20"/><text>Start</text></g><path class="flowchart-link" marker-end="url(#d1_arrow)" d="M0 0L10 10"/>'));
    expect(box.querySelectorAll("g.node")).toHaveLength(1);
    expect(box.querySelector("text")?.textContent).toBe("Start");
    expect(box.querySelector("path.flowchart-link")?.getAttribute("marker-end")).toBe("url(#d1_arrow)");
    expect(box.querySelector("style")?.textContent).toContain(".node rect{fill:#222}");
    expect(box.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 50");
  });

  it("a <script> goes, in the SVG and in a label", () => {
    const box = clean(svg('<script>window.__cfPwned=1</script><g class="node"><text>a<script>window.__cfPwned=2</script></text></g>'));
    expect(box.querySelector("script")).toBeNull();
    expect(box.innerHTML).not.toContain("__cfPwned");
  });

  it("an onclick (or any handler) goes", () => {
    const box = clean(svg('<g class="node" onclick="window.__cfPwned=1" onmouseover="x()"><rect width="1" height="1" onload="y()"/><text onfocus="z()">a</text></g>'));
    expect(attrs(box).filter((a) => a.startsWith("on"))).toEqual([]);
  });

  it("a javascript: link (Mermaid's `click A href`) is no link; a link inside the diagram stays", () => {
    const box = clean(svg('<a xlink:href="javascript:window.__cfPwned=1"><text>a</text></a><a href="https://example.invalid/x"><text>b</text></a><a href="data:text/html,x"><text>c</text></a><a href="#d1_arrow"><text>d</text></a>'));
    expect(attrs(box).filter((a) => /href=(?!#)/.test(a))).toEqual([]);
    expect(box.querySelectorAll("a")[3]?.getAttribute("href")).toBe("#d1_arrow");
    // The text stays readable.
    expect(box.textContent).toContain("abcd");
  });

  it("an HTML label (a foreignObject) keeps its text and loses what runs or loads", () => {
    const box = clean(svg('<foreignObject width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><b>Bold</b><img src="x" onerror="window.__cfPwned=1"><iframe src="javascript:1"></iframe><a href="javascript:1">go</a></span></div></foreignObject>'));
    expect(box.textContent).toContain("Bold");
    expect(box.querySelector("img, iframe")).toBeNull();
    expect(attrs(box).filter((a) => a.startsWith("on") || a.includes("javascript:"))).toEqual([]);
  });

  it("styles load nothing from outside the diagram", () => {
    const box = clean(svg('<rect style="fill:url(https://example.invalid/a.png);stroke:url(#grad)" width="1" height="1"/>', '@import url("https://example.invalid/x.css");#d1 .node{background:url(https://example.invalid/b.png)}#d1 .x{fill:url(#grad)}'));
    expect(box.innerHTML).not.toContain("example.invalid");
    expect(box.querySelector("rect")?.getAttribute("style")).toContain("url(#grad)");
    expect(box.querySelector("style")?.textContent).toContain("url(#grad)");
  });
});

describe("inertCss", () => {
  it.each<[string, string, string]>([
    ["a remote url", "a{background:url(https://x/y.png)}", "a{background:none}"],
    ["a quoted remote url", "a{background:url( 'http://x/y.png' )}", "a{background:none}"],
    ["a fragment url stays", "a{fill:url(#g)}", "a{fill:url(#g)}"],
    ["an @import", '@import "x.css";a{}', "a{}"],
    ["an escaped function name", "a{background:\\75 rl(http://x)}", "a{background:75 rl(http://x)}"],
    ["image-set", 'a{background:image-set("http://x" 1x)}', 'a{background:none("http://x" 1x)}'],
    ["a url with a parenthesis in it", "a{background:url(http://x/(y).png)}", "a{background:none.png)}"],
    ["a url the first pass cannot read", "a{background:url(http://x/y.png", "a{background:none(http://x/y.png"],
  ])("%s", (_, css, want) => {
    expect(inertCss(css)).toBe(want);
  });
});
