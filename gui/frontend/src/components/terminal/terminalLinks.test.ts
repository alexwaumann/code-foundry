import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openPullRequestInPanel = vi.hoisted(() => vi.fn<(ref: unknown, target?: string) => boolean>(() => true));
vi.mock("@/stores/gh", () => ({ openUrl }));
vi.mock("@/stores/prPanel", () => ({ openPullRequestInPanel }));

const { openTerminalLink } = await import("./terminalLinks");

afterEach(() => {
  openUrl.mockClear();
  openPullRequestInPanel.mockClear();
  openPullRequestInPanel.mockImplementation(() => true);
});

describe("openTerminalLink", () => {
  const cases: { name: string; uri: string; shift?: boolean; declines?: boolean; panel: unknown; browser: string | null }[] = [
    { name: "a pull request opens in the panel", uri: "https://github.com/octo/hello/pull/42", panel: { slug: "octo/hello", number: 42 }, browser: null },
    { name: "cmd+shift+click sends a pull request to the browser", uri: "https://github.com/octo/hello/pull/42", shift: true, panel: null, browser: "https://github.com/octo/hello/pull/42" },
    { name: "the browser when the panel declines", uri: "https://github.com/octo/hello/pull/42", declines: true, panel: { slug: "octo/hello", number: 42 }, browser: "https://github.com/octo/hello/pull/42" },
    { name: "an issue goes to the browser", uri: "https://github.com/octo/hello/issues/3", panel: null, browser: "https://github.com/octo/hello/issues/3" },
    { name: "any other http link goes to the browser", uri: "http://localhost:5173/", panel: null, browser: "http://localhost:5173/" },
    { name: "other schemes go nowhere", uri: "file:///etc/hosts", panel: null, browser: null },
  ];
  for (const c of cases) {
    it(c.name, () => {
      if (c.declines) openPullRequestInPanel.mockImplementation(() => false);
      openTerminalLink(c.uri, { shiftKey: c.shift ?? false });
      if (c.panel === null) expect(openPullRequestInPanel).not.toHaveBeenCalled();
      else expect(openPullRequestInPanel).toHaveBeenCalledWith(c.panel, "current");
      if (c.browser === null) expect(openUrl).not.toHaveBeenCalled();
      else expect(openUrl).toHaveBeenCalledWith(c.browser);
    });
  }
});
