import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreview } from "@/api/files";
import type { PageAccessView } from "@/api/page";
import type { ThreadView } from "@/api/threads";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { usePageAnswers } from "@/stores/pageAnswers";
import { useThreadsStore } from "@/stores/threads";
import { HTML_PREVIEW_SANDBOX, THREAD_PAGE_SANDBOX } from "./HtmlFrame";
import { HtmlPreview } from "./HtmlPreview";

/*
 * Whom a File tab's page acts for and the user's answer for a page no thread owns
 * (docs/notes/page-ownership-gui.md): the band, which command each answer runs, the footer's
 * states and the held ready. The bridge host's own rules: stores/bridgeHost.test.ts.
 */

const previewFile = vi.fn();
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  previewFile: (...args: unknown[]) => previewFile(...args) as unknown,
}));
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  runCommandForResult,
}));
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  listCommands: () => Promise.resolve([]),
}));
vi.mock("@/api/page", async (orig) => ({
  ...(await orig<typeof import("@/api/page")>()),
  getPageFileStorage: () => Promise.resolve({ visits: "1" }),
}));

/** The page's resolved path (PageAccess.path), not the tab's spelling. */
const REAL = "/Users/me/real/board.html";
const TAB = "/Users/me/link/board.html";
const URL_ = "http://127.0.0.1:1/preview/g/board.html";

const access = (over: Partial<PageAccessView> = {}): PageAccessView => ({ path: REAL, ownerThread: "", ownerSource: "", consent: "not-asked", answer: "not-asked", unavailableReason: "", ...over });
const grant = (page: PageAccessView | null): FilePreview => ({ url: URL_, scope: "/Users/me/real", singleFile: false, pageThread: "", page });

/** The frame's window with its posts recorded, and a way to send a message as its page. */
function framePage() {
  const frame = screen.getByTestId<HTMLIFrameElement>("file-html-frame");
  const win = frame.contentWindow;
  if (!win) throw new Error("no contentWindow");
  const posts: Record<string, unknown>[] = [];
  vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
    posts.push(m as Record<string, unknown>);
  });
  const nonce = /#cf=([0-9a-f]+)$/.exec(frame.getAttribute("src") ?? "")?.[1] ?? "";
  const say = (type: string) => {
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { cf: 1, type, nonce }, source: win, origin: frame.getAttribute("sandbox")?.includes("allow-same-origin") ? "http://127.0.0.1:1" : "null" }));
    });
  };
  return { frame, posts, say, of: (type: string) => posts.filter((p) => p.type === type) };
}

function inTab(key: string) {
  return ({ children }: { children: ReactNode }) => <PanelKeyContext.Provider value={key}>{children}</PanelKeyContext.Provider>;
}

const footer = () => screen.getByTestId("file-html-footer");
const SANDBOXED = "Sandboxed from Code Foundry · scripts and network on · loads files under ~/real";

beforeEach(() => {
  useThreadsStore.setState({ byId: { "s-2": { id: "s-2", name: "Fix login" } as ThreadView }, order: ["s-2"] });
});

afterEach(() => {
  cleanup();
  previewFile.mockReset();
  runCommandForResult.mockReset();
  usePageAnswers.setState({ byPath: {} });
  vi.restoreAllMocks();
});

describe("HtmlPreview: a page no thread owns, not asked about yet", () => {
  it("asks nothing of a page that never loads the bridge", async () => {
    previewFile.mockResolvedValue(grant(access()));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    const { frame } = (await screen.findByTestId("file-html-frame"), framePage());
    fireEvent.load(frame);
    expect(screen.queryByTestId("page-consent")).toBeNull();
    expect(footer().textContent).toBe(SANDBOXED);
    expect(frame.getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
  });

  it("asks once the page says hello, holding its ready; Allow runs page.allow with the resolved path, reads the grant again and lets the ready go", async () => {
    previewFile.mockResolvedValue(grant(access()));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const page = framePage();
    page.say("cf:hello");
    const band = await screen.findByTestId("page-consent");
    expect(band.textContent).toContain("Let this page use Code Foundry?");
    expect(page.of("cf:asking")).toHaveLength(1);
    expect(page.of("cf:ready")).toHaveLength(0);
    // The page renders behind the band, untouched: its frame is not loaded again.
    expect(page.frame.dataset.load).toBe("0");

    runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
    previewFile.mockResolvedValue(grant(access({ consent: "allowed", answer: "allowed" })));
    fireEvent.click(screen.getByTestId("page-consent-allow"));
    expect(runCommandForResult).toHaveBeenCalledWith("page.allow", { path: REAL }, { inView: true });
    await waitFor(() => {
      expect(screen.queryByTestId("page-consent")).toBeNull();
    });
    expect(previewFile).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(page.of("cf:ready")).toHaveLength(1);
    });
    expect(page.of("cf:ready")[0]).toMatchObject({ thread: null, can: { storage: true, fetch: true }, refusal: "", storage: { visits: "1" } });
    expect(screen.getByTestId<HTMLIFrameElement>("file-html-frame")).toBe(page.frame);
    expect(page.frame.dataset.load).toBe("0");
    expect(footer().querySelector("span.truncate")?.textContent).toBe("Can use Code Foundry · scripts and network on · loads files under ~/real");
    expect(screen.getByTestId("file-html-consent").textContent).toBe("Stop allowing");
  });

  it("Don't allow runs page.disallow; the held ready says the user has not allowed the page", async () => {
    previewFile.mockResolvedValue(grant(access()));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const page = framePage();
    page.say("cf:hello");
    runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
    previewFile.mockResolvedValue(grant(access({ consent: "refused", answer: "refused" })));
    fireEvent.click(await screen.findByTestId("page-consent-deny"));
    expect(runCommandForResult).toHaveBeenCalledWith("page.disallow", { path: REAL }, { inView: true });
    await waitFor(() => {
      expect(page.of("cf:ready")).toHaveLength(1);
    });
    expect(page.of("cf:ready")[0]).toMatchObject({ can: { storage: false, fetch: false }, refusal: "the user has not allowed this page to use Code Foundry" });
    expect(screen.queryByTestId("page-consent")).toBeNull();
    expect(screen.getByTestId("file-html-consent").textContent).toBe("Allow Code Foundry");
  });

  it("keeps asking when the command fails (it toasts), the buttons back", async () => {
    previewFile.mockResolvedValue(grant(access()));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    framePage().say("cf:hello");
    runCommandForResult.mockResolvedValue(null);
    fireEvent.click(await screen.findByTestId("page-consent-allow"));
    await waitFor(() => {
      expect(screen.getByTestId<HTMLButtonElement>("page-consent-allow").disabled).toBe(false);
    });
    expect(previewFile).toHaveBeenCalledTimes(1);
  });
});

describe("HtmlPreview: the footer", () => {
  it.each([
    ["allowed: the state, and Stop allowing runs page.disallow", "allowed", "Can use Code Foundry · scripts and network on · loads files under ~/real", "Stop allowing", "page.disallow"],
    ["not allowed: the usual footer, and Allow Code Foundry runs page.allow", "refused", SANDBOXED, "Allow Code Foundry", "page.allow"],
  ] as const)("%s", async (_name, consent, text, button, verb) => {
    previewFile.mockResolvedValue(grant(access({ consent, answer: consent })));
    runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const link = screen.getByTestId("file-html-consent");
    expect(link.textContent).toBe(button);
    expect(footer().querySelector("span.truncate")?.textContent).toBe(text);
    fireEvent.click(link);
    expect(runCommandForResult).toHaveBeenCalledWith(verb, { path: REAL }, { inView: true });
    await waitFor(() => {
      expect(previewFile).toHaveBeenCalledTimes(2);
    });
  });

  it("an answer that changes what a page already had loads it again, so it starts over under the new one", async () => {
    previewFile.mockResolvedValue(grant(access({ consent: "refused", answer: "refused" })));
    runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const page = framePage();
    page.say("cf:hello");
    await waitFor(() => {
      expect(page.of("cf:ready")).toHaveLength(1);
    });
    previewFile.mockResolvedValue(grant(access({ consent: "allowed", answer: "allowed" })));
    fireEvent.click(screen.getByTestId("file-html-consent"));
    await waitFor(() => {
      expect(screen.getByTestId("file-html-frame").dataset.load).toBe("1");
    });
    expect(screen.queryByTestId("page-consent")).toBeNull();
  });

  it.each([
    ["a page owned by another thread names it, and has its bridge", "thread:s-1", "Can use Code Foundry for Fix login · scripts and network on · loads files under ~/real", THREAD_PAGE_SANDBOX],
    ["in an unlinked tab too", "", "Can use Code Foundry for Fix login · scripts and network on · loads files under ~/real", THREAD_PAGE_SANDBOX],
    ["a page owned by the tab's own thread names nobody", "thread:s-2", SANDBOXED, THREAD_PAGE_SANDBOX],
  ])("%s", async (_name, key, text, sandbox) => {
    previewFile.mockResolvedValue(grant(access({ consent: "owned", ownerThread: "s-2", ownerSource: "written" })));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />, { wrapper: inTab(key) });
    const frame = await screen.findByTestId("file-html-frame");
    expect(footer().querySelector("span.truncate")?.textContent).toBe(text);
    expect(frame.getAttribute("sandbox")).toBe(sandbox);
    expect(screen.queryByTestId("file-html-consent")).toBeNull();
    // An owned page never asks, even once it says hello.
    framePage().say("cf:hello");
    expect(screen.queryByTestId("page-consent")).toBeNull();
  });

  it("a file that is no page: the usual footer, never asked, its calls refused with the reason", async () => {
    previewFile.mockResolvedValue(grant(access({ path: "", consent: "unavailable", answer: "unavailable", unavailableReason: "a.htm is outside your home folder" })));
    render(<HtmlPreview path={TAB} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const page = framePage();
    page.say("cf:hello");
    await waitFor(() => {
      expect(page.of("cf:ready")).toHaveLength(1);
    });
    expect(page.of("cf:ready")[0]).toMatchObject({ refusal: "Code Foundry gives this page no bridge: a.htm is outside your home folder" });
    expect(screen.queryByTestId("page-consent")).toBeNull();
    expect(screen.queryByTestId("file-html-consent")).toBeNull();
    expect(footer().textContent).toBe(SANDBOXED);
  });
});
