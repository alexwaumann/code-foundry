import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/stores/gh", () => ({ openUrl }));
vi.mock("@/lib/clipboard", () => ({ copyText }));
vi.mock("@/lib/notify", () => ({ notify }));

const { Markdown } = await import("@/components/pr/Markdown");
const { InlineView } = await import("@/components/plugin/parts");

const PR = "https://github.com/o/r/pull/42";

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
});

/** A picked item runs once the menu has closed (docs/notes/testing-gotchas.md). */
const settle = () => new Promise((r) => setTimeout(r, 0));

function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll("[role=menuitem]")].map((el) => el.textContent);
}

/** Right-clicks `el`; true when the app took the event (WebKit's own menu stays shut). */
function rightClick(el: Element): boolean {
  return !fireEvent.contextMenu(el);
}

const sources = [
  {
    name: "a thread or pull request's markdown",
    render: () => render(<Markdown>{`See [the pull request](${PR}) for details.`}</Markdown>),
  },
  {
    name: "a plugin's span",
    render: () => render(<InlineView value={{ spans: [{ text: "See " }, { text: "the pull request", url: PR }] }} />),
  },
];

describe.each(sources)("a link in $name", ({ render: show }) => {
  it("keeps its href and, on a right-click, shows the app's menu instead of WebKit's", async () => {
    show();
    const a = screen.getByRole("link", { name: "the pull request" });
    expect(a.getAttribute("href")).toBe(PR);
    expect(rightClick(a)).toBe(true);
    expect(entries(await screen.findByTestId("link-menu"))).toEqual(["Open in browser", "Copy link"]);
  });

  it("Open in browser opens the link through openUrl (view.open.url)", async () => {
    show();
    rightClick(screen.getByRole("link", { name: "the pull request" }));
    fireEvent.click(await screen.findByTestId("link-menu-open"));
    await settle();
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(PR);
    expect(copyText).not.toHaveBeenCalled();
  });

  it("Copy link copies the link and says so", async () => {
    show();
    rightClick(screen.getByRole("link", { name: "the pull request" }));
    fireEvent.click(await screen.findByTestId("link-menu-copy"));
    await settle();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(PR);
    expect(notify).toHaveBeenCalledWith({ level: "success", title: "Link copied", description: PR });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("shows the app's menu when the right-click lands on a link inside selected text", async () => {
    const { container } = show();
    // The reported path: text selected across the link, then a right-click on the link.
    window.getSelection()?.selectAllChildren(container);
    expect(window.getSelection()?.toString()).toContain("the pull request");
    expect(rightClick(screen.getByRole("link", { name: "the pull request" }))).toBe(true);
    expect(await screen.findByTestId("link-menu")).toBeTruthy();
  });

  it("leaves a right-click on the text around it to the system menu", () => {
    const { container } = show();
    window.getSelection()?.selectAllChildren(container);
    const text = screen.getByText(/See/);
    expect(text.closest("a")).toBeNull();
    expect(rightClick(text)).toBe(false);
    expect(screen.queryByTestId("link-menu")).toBeNull();
  });

  it("a click still opens the browser, not the app's webview", () => {
    show();
    const a = screen.getByRole("link", { name: "the pull request" });
    expect(fireEvent.click(a)).toBe(false);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(PR);
  });
});

describe("a link that goes nowhere", () => {
  it("is plain text with no menu", () => {
    render(<Markdown>{"[click](javascript:alert(1))"}</Markdown>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(rightClick(screen.getByText("click"))).toBe(false);
    expect(screen.queryByTestId("link-menu")).toBeNull();
  });
});
