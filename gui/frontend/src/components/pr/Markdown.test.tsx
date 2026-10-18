import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/stores/gh", () => ({ openUrl }));

const { Markdown } = await import("./Markdown");

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

function md(body: string): HTMLElement {
  return render(<Markdown>{body}</Markdown>).container;
}

describe("Markdown", () => {
  it("renders a javascript: link as plain text that opens nothing", () => {
    const c = md("[click](javascript:alert(1)) and <a href=\"javascript:alert(2)\">raw</a>");
    expect(c.querySelectorAll("a")).toHaveLength(0);
    expect(c.textContent).toContain("click");
    expect(c.textContent).toContain("raw");
    expect(c.innerHTML).not.toContain("javascript:");
  });

  it("drops raw script and style, and event handlers", () => {
    const c = md('before\n\n<script>window.__pwned = 1</script>\n\n<style>body{display:none}</style>\n\n<img src="https://x.test/a.png" onerror="alert(1)">\n\nafter');
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("style")).toBeNull();
    expect(c.textContent).not.toContain("__pwned");
    expect(c.innerHTML).not.toContain("onerror");
    expect(c.textContent).toContain("after");
  });

  it("keeps https images (markdown and raw) and drops http ones", () => {
    const c = md('![shot](https://user-images.githubusercontent.com/1/a.png)\n\n<img width="200" src="https://github.com/b.png" alt="raw">\n\n![plain](http://x.test/c.png)');
    const srcs = [...c.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["https://user-images.githubusercontent.com/1/a.png", "https://github.com/b.png"]);
  });

  it("resolves a relative link against github.com and opens it through openUrl", () => {
    const c = md("[the issue](/alexwaumann/code-foundry/issues/3)");
    const a = c.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://github.com/alexwaumann/code-foundry/issues/3");
    fireEvent.click(a as HTMLAnchorElement);
    expect(openUrl).toHaveBeenCalledWith("https://github.com/alexwaumann/code-foundry/issues/3");
  });

  it("keeps details/summary, br, sub, sup and kbd", () => {
    const c = md("<details><summary>Logs</summary>\n\nline one<br>line two <sub>a</sub><sup>b</sup> <kbd>⌘K</kbd>\n\n</details>");
    expect(c.querySelector("details summary")?.textContent).toBe("Logs");
    expect(c.querySelector("details br")).not.toBeNull();
    expect(c.querySelector("sub")?.textContent).toBe("a");
    expect(c.querySelector("sup")?.textContent).toBe("b");
    expect(c.querySelector("kbd")?.textContent).toBe("⌘K");
  });

  it("keeps small, mark, ins and s (GitHub bodies' fine print, highlights, edits)", () => {
    const c = md("Done <small>(after the rebase)</small> <mark>breaking</mark> <ins>added</ins> <s>removed</s>");
    expect(c.querySelector("small")?.textContent).toBe("(after the rebase)");
    expect(c.querySelector("mark")?.textContent).toBe("breaking");
    expect(c.querySelector("ins")?.textContent).toBe("added");
    expect(c.querySelector("s")?.textContent).toBe("removed");
  });

});

/** A thread's answers (html: false): only matched pairs of the inline allowlist render; every other tag stays literal. */
describe("Markdown without raw HTML (a thread)", () => {
  const thread = (body: string) => render(<Markdown extras={{ html: false }}>{body}</Markdown>).container;
  /** The rendered HTML inside the wrapper, for exact comparisons. */
  const inner = (body: string) => (thread(body).firstElementChild as HTMLElement).innerHTML;

  it.each(["small", "mark", "sub", "sup", "kbd", "ins", "s", "del", "u"])("<%s> renders", (tag) => {
    expect(inner(`x <${tag}>tiny</${tag}> y`)).toBe(`<p>x <${tag}>tiny</${tag}> y</p>`);
  });

  it.each<[string, string, string]>([
    ["br", "one<br>two<br/>three", "<p>one<br>two<br>three</p>"],
    ["upper case", "x <SMALL>tiny</SMALL> y", "<p>x <small>tiny</small> y</p>"],
    ["nested", "<small>a <mark>b</mark> c</small>", "<p><small>a <mark>b</mark> c</small></p>"],
    ["markdown inside", "<small>see **this**</small>", "<p><small>see <strong>this</strong></small></p>"],
    ["in a list item", "- <small>fine</small> print", "<ul>\n<li><small>fine</small> print</li>\n</ul>"],
  ])("%s", (_name, body, want) => {
    expect(inner(body)).toBe(want);
  });

  it.each<[string, string, string]>([
    ["an unknown tag", "Paste: <pasted_content>hi</pasted_content> done", "Paste: <pasted_content>hi</pasted_content> done"],
    ["a file tag", "<file>a.go</file>", "<file>a.go</file>"],
    ["a generic", "Result<T, E> and Vec<u8>", "Result<T, E> and Vec<u8>"],
    ["an allowlisted tag with attributes", '<small class="x">a</small>', '<small class="x">a</small>'],
    ["a script tag", "<script>alert(1)</script>", "<script>alert(1)</script>"],
    ["a self-closed pair tag", "a <small/> b", "a <small/> b"],
    ["a stray closing tag", "a </small> b", "a </small> b"],
    ["in a code span", "`<small>x</small>`", "<small>x</small>"],
    ["in a code block", "```\n<small>x</small>\n```", "<small>x</small>\n"],
    ["an HTML block (tag alone on its line)", "<small>\nfine print\n</small>", "<small>\nfine print\n</small>"],
  ])("%s stays literal", (_name, body, want) => {
    const c = thread(body);
    expect(c.textContent).toBe(want);
    expect(c.querySelector("small, script, pasted_content, file")).toBeNull();
  });

  it("an unclosed allowlisted tag stays literal and swallows nothing after it", () => {
    const c = thread("Before <small>never closed and **bold**\n\nNext paragraph <mark>x</mark>");
    expect(c.querySelector("small")).toBeNull();
    const [p1, p2] = [...c.querySelectorAll("p")];
    expect(p1?.innerHTML).toBe("Before &lt;small&gt;never closed and <strong>bold</strong>");
    expect(p2?.innerHTML).toBe("Next paragraph <mark>x</mark>");
  });

  it("a pair split across paragraphs does not match: both tags stay literal", () => {
    const c = thread("<small>one\n\ntwo</small>");
    expect(c.querySelector("small")).toBeNull();
    expect(c.textContent).toBe("<small>one\ntwo</small>");
  });

  it("an inner unclosed tag stays literal inside the outer pair", () => {
    expect(inner("<small>a <mark>b</small> c")).toBe("<p><small>a &lt;mark&gt;b</small> c</p>");
  });

  it("still renders GFM task lists and tables", () => {
    const c = md("- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(c.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(c.querySelector("table td")?.textContent).toBe("1");
  });
});

describe("Markdown extras", () => {
  it("hands fenced blocks to the code renderer and local images to the image renderer", () => {
    const code = vi.fn((lang: string, text: string) => <pre data-lang={lang}>{text}</pre>);
    const image = vi.fn((src: string, alt: string) => <span data-src={src}>{alt}</span>);
    const extras = { code, image };
    const c = render(
      <Markdown extras={extras}>{"```go\nfunc f() {}\n```\n\n```\nplain\n```\n\n![shot](/att/a.png) ![web](https://x.test/b.png)"}</Markdown>,
    ).container;
    expect(code.mock.calls).toEqual([
      ["go", "func f() {}"],
      ["", "plain"],
    ]);
    expect(c.querySelector('pre[data-lang="go"]')?.textContent).toBe("func f() {}");
    expect(image.mock.calls).toEqual([["/att/a.png", "shot"]]);
    expect(c.querySelector("img")?.getAttribute("src")).toBe("https://x.test/b.png");
  });
});
