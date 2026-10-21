import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/stores/gh", () => ({ openUrl }));
const readAttachment = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@/api/threads", () => ({ readAttachment }));

const { ThreadMarkdown } = await import("./Code");

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

function md(body: string): HTMLElement {
  return render(<ThreadMarkdown>{body}</ThreadMarkdown>).container;
}

describe("ThreadMarkdown", () => {
  it("shows angle brackets in Claude's prose as text, never as markup", () => {
    const c = md("It returns Result<T, E> and <Option> values.\n\n<script>window.__pwned = 1</script>\n\n<b>bold?</b>");
    expect(c.textContent).toContain("It returns Result<T, E> and <Option> values.");
    expect(c.textContent).toContain("<script>window.__pwned = 1</script>");
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
  });

  it("opens links through openUrl and drops unsafe ones", () => {
    const c = md("[docs](https://example.com/a) and [x](javascript:alert(1))");
    const links = c.querySelectorAll("a");
    expect(links).toHaveLength(1);
    fireEvent.click(links[0] as HTMLAnchorElement);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("a relative link is a path chip when it reads as a path, else plain text, never github.com", () => {
    const c = md("See [main.go](src/main.go), [notes](./docs/a.md#L3) and [about](about) or [site](https://example.com).");
    const chips = [...c.querySelectorAll('[data-testid="path-chip"]')].map((x) => x.getAttribute("data-path"));
    expect(chips).toEqual(["src/main.go", "./docs/a.md"]);
    expect(c.querySelector('[data-testid="link-plain"]')?.textContent).toBe("about");
    expect(c.querySelector('a[href*="github.com"]')).toBeNull();
    expect([...c.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com/"]);
  });

  it("highlights fenced code; images load over https only or as staged attachments", () => {
    const c = md("```go\nfunc a() {}\n```\n\n![a](http://x.test/a.png) ![b](/att/b.png)");
    expect(c.querySelector('pre[data-lang="go"] .hljs-keyword')?.textContent).toBe("func");
    expect(c.querySelector('img[src^="http:"]')).toBeNull();
    expect(readAttachment).toHaveBeenCalledWith("/att/b.png");
  });

  it("wraps tables in the frame that scrolls them sideways", () => {
    const c = md("| a | b |\n|---|---|\n| 1 | `x` |");
    const table = c.querySelector(".cf-markdown > .cf-table > table");
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelector("td code")?.textContent).toBe("x");
  });
});
