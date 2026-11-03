import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openPullRequestInPanel = vi.hoisted(() => vi.fn<(ref: unknown, target?: string) => boolean>(() => true));
vi.mock("@/stores/gh", () => ({ openUrl }));
vi.mock("@/stores/prPanel", () => ({ openPullRequestInPanel }));

const { Markdown } = await import("./Markdown");
const { openPullRequestLink, usePanelMarkdownExtras } = await import("./prLinks");
const { ThreadMarkdown } = await import("@/components/thread/Code");
const { PanelKeyContext } = await import("@/components/panel/panelKeyContext");
const { AgentReport } = await import("@/components/thread/ToolDetail");
const { usePanelStore, makeTab } = await import("@/stores/panel");

/** Puts pull request tabs into a panel's one group, the active one first given. */
function seedPanel(key: string, refs: { slug: string; number: number }[], active: number): void {
  const tabs = refs.map((r) => makeTab("pullrequest", `#${String(r.number)}`, { slug: r.slug, number: String(r.number) }));
  usePanelStore.setState((s) => ({ byKey: { ...s.byKey, [key]: { open: true, groups: [{ tabs, activeTabId: tabs[active]?.id ?? null }], focused: 0 } } }));
}

afterEach(() => {
  cleanup();
  openUrl.mockClear();
  openPullRequestInPanel.mockClear();
  openPullRequestInPanel.mockImplementation(() => true);
  usePanelStore.setState({ byKey: {} });
});

const PR = "https://github.com/octo/hello/pull/42/files#discussion_r7";
const REF = { slug: "octo/hello", number: 42 };

function link(c: HTMLElement): HTMLAnchorElement {
  const a = c.querySelector("a");
  if (!a) throw new Error("no link");
  return a;
}

describe("openPullRequestLink", () => {
  it("opens a pull request page in the target's panel", () => {
    expect(openPullRequestLink("thread:t1")(PR)).toBe(true);
    expect(openPullRequestInPanel).toHaveBeenCalledWith(REF, "thread:t1");
  });

  it("declines with no panel to open (nothing selected), so the browser opens it", () => {
    openPullRequestInPanel.mockImplementation(() => false);
    expect(openPullRequestLink("current")(PR)).toBe(false);
  });

  it("reuses the panel's tab for the same pull request in another letter case", () => {
    seedPanel("thread:t1", [{ slug: "octo/hello", number: 42 }], 0);
    expect(openPullRequestLink("thread:t1")("https://github.com/Octo/Hello/pull/42")).toBe(true);
    expect(openPullRequestInPanel).toHaveBeenCalledWith(REF, "thread:t1");
  });

  it("sends a link into the page of the pull request already showing to the browser", () => {
    seedPanel("thread:t1", [{ slug: "octo/hello", number: 42 }], 0);
    expect(openPullRequestLink("thread:t1")(PR)).toBe(false);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });

  it("opens an anchored link of a pull request that is open but not showing", () => {
    seedPanel("thread:t1", [{ slug: "octo/other", number: 1 }, { slug: "octo/hello", number: 42 }], 0);
    expect(openPullRequestLink("thread:t1")(PR)).toBe(true);
    expect(openPullRequestInPanel).toHaveBeenCalledWith(REF, "thread:t1");
  });

  it("declines any other link without touching the panel", () => {
    expect(openPullRequestLink("current")("https://github.com/octo/hello/issues/42")).toBe(false);
    expect(openPullRequestLink("current")("https://example.com/pull/1")).toBe(false);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });
});

describe("a thread message's links", () => {
  const thread = (body: string) => render(<ThreadMarkdown>{body}</ThreadMarkdown>).container;

  it("opens a pull request link in the selection's panel on a plain click", () => {
    fireEvent.click(link(thread(`See [the PR](${PR}).`)));
    expect(openPullRequestInPanel).toHaveBeenCalledWith(REF, "current");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("opens a bare autolinked pull request URL in the panel too", () => {
    fireEvent.click(link(thread(`Opened ${PR}`)));
    expect(openPullRequestInPanel).toHaveBeenCalledWith(REF, "current");
  });

  it.each([
    ["cmd", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("opens the browser on a %s+click", (_name, mods) => {
    fireEvent.click(link(thread(`[the PR](${PR})`)), mods);
    expect(openUrl).toHaveBeenCalledWith(PR);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });

  it("opens the browser on a middle click", () => {
    fireEvent(link(thread(`[the PR](${PR})`)), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(openUrl).toHaveBeenCalledWith(PR);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });

  it("opens the browser when there is no panel to open", () => {
    openPullRequestInPanel.mockImplementation(() => false);
    fireEvent.click(link(thread(`[the PR](${PR})`)));
    expect(openUrl).toHaveBeenCalledWith(PR);
  });

  it("opens any other link in the browser", () => {
    fireEvent.click(link(thread("[the issue](https://github.com/octo/hello/issues/42)")));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/octo/hello/issues/42");
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });

  it("keeps the link's URL as its href (the tooltip shows it)", () => {
    expect(link(thread(`[the PR](${PR})`)).getAttribute("href")).toBe(PR);
  });
});

function PanelBody({ body }: { body: string }) {
  return <Markdown extras={usePanelMarkdownExtras()}>{body}</Markdown>;
}

describe("a pull request's description and comments", () => {
  it("open a pull request link as a tab of the panel holding them", () => {
    const c = render(
      <PanelKeyContext value="view:pullrequests">
        <PanelBody body={`Follows [#41](https://github.com/octo/hello/pull/41).`} />
      </PanelKeyContext>,
    ).container;
    fireEvent.click(link(c));
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "octo/hello", number: 41 }, "view:pullrequests");
  });

  it("resolve a relative pull request link against github.com", () => {
    const c = render(
      <PanelKeyContext value="view:pullrequests">
        <PanelBody body="Follows [#41](/octo/hello/pull/41)." />
      </PanelKeyContext>,
    ).container;
    fireEvent.click(link(c));
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "octo/hello", number: 41 }, "view:pullrequests");
  });
});

describe("a subagent's report in a tool row", () => {
  it("opens a pull request link in the browser (tool output)", () => {
    const c = render(<AgentReport text={`Opened [the PR](${PR}).`} />).container;
    fireEvent.click(link(c));
    expect(openUrl).toHaveBeenCalledWith(PR);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });
});

describe("Markdown without openLink (plugin nodes, file previews, help)", () => {
  it.each([
    ["no extras", undefined],
    ["other extras", { link: () => null }],
  ])("opens a pull request link in the browser (%s)", (_name, extras) => {
    const c = render(<Markdown extras={extras}>{`[the PR](${PR})`}</Markdown>).container;
    fireEvent.click(link(c));
    expect(openUrl).toHaveBeenCalledWith(PR);
    expect(openPullRequestInPanel).not.toHaveBeenCalled();
  });

  it("leaves a middle click alone", () => {
    const c = render(<Markdown>{`[the PR](${PR})`}</Markdown>).container;
    fireEvent(link(c), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
