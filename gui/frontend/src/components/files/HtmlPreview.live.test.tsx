import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePreview } from "@/api/files";
import type { PageAccessView } from "@/api/page";
import type { ThreadView } from "@/api/threads";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { dispatchEvent } from "@/stores/events";
import { usePageAnswers } from "@/stores/pageAnswers";
import { useThreadsStore } from "@/stores/threads";
import { HTML_PREVIEW_SANDBOX, THREAD_PAGE_SANDBOX } from "./HtmlFrame";
import { HtmlPreview } from "./HtmlPreview";

/*
 * A File tab follows what the daemon says of its page now, not what it said when the tab
 * opened (docs/notes/page-access-live.md): the page source (an answer given in another window
 * or the CLI, an owner removed), a Refresh and an edit read the grant again, and the frame and
 * footer follow it. The host's side (a refused call, onStale): stores/bridgeHost.test.ts.
 */

const previewFile = vi.fn();
vi.mock("@/api/files", async (orig) => ({
  ...(await orig<typeof import("@/api/files")>()),
  previewFile: (...args: unknown[]) => previewFile(...args) as unknown,
}));
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  listCommands: () => Promise.resolve([]),
}));
vi.mock("@/api/page", async (orig) => ({
  ...(await orig<typeof import("@/api/page")>()),
  getPageFileStorage: () => Promise.resolve({}),
}));
vi.mock("@/api/pageStorage", () => ({ getPageStorage: () => Promise.resolve({}), setPageStorage: () => Promise.resolve({}) }));

const REAL = "/Users/me/real/board.html";
const URL_ = "http://127.0.0.1:1/preview/g/board.html";
const access = (over: Partial<PageAccessView> = {}): PageAccessView => ({ path: REAL, ownerThread: "", ownerSource: "", consent: "not-asked", answer: "not-asked", unavailableReason: "", ...over });
const grant = (page: PageAccessView | null): FilePreview => ({ url: URL_, scope: "/Users/me/real", singleFile: false, pageThread: "", page });
const ALLOWED = access({ consent: "allowed", answer: "allowed" });
const REFUSED = access({ consent: "refused", answer: "refused" });
const OWNED = access({ consent: "owned", answer: "not-asked", ownerThread: "s-9", ownerSource: "shown" });

function inTab(key: string) {
  return ({ children }: { children: ReactNode }) => <PanelKeyContext.Provider value={key}>{children}</PanelKeyContext.Provider>;
}

/** Says hello as the frame's page: its document wants the bridge. Returns what the frame posts it. */
function hello(): unknown[] {
  const frame = screen.getByTestId<HTMLIFrameElement>("file-html-frame");
  const win = frame.contentWindow;
  if (!win) throw new Error("no contentWindow");
  const posts: unknown[] = [];
  vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
    posts.push(m);
  });
  const nonce = /#cf=([0-9a-f]+)$/.exec(frame.getAttribute("src") ?? "")?.[1] ?? "";
  const origin = frame.getAttribute("sandbox")?.includes("allow-same-origin") ? "http://127.0.0.1:1" : "null";
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { cf: 1, type: "cf:hello", nonce }, source: win, origin }));
  });
  return posts;
}

const footer = () => screen.getByTestId("file-html-footer");
const pageEvent = (event: { paths?: string[]; removedThread?: string; all?: boolean }) => {
  act(() => {
    dispatchEvent({ source: "page", event: { paths: [], removedThread: "", all: false, ...event } });
  });
};

beforeEach(() => {
  useThreadsStore.setState({ byId: { "s-2": { id: "s-2", name: "Fix login" } as ThreadView, "s-9": { id: "s-9", name: "Board" } as ThreadView }, order: ["s-2", "s-9"] });
});

afterEach(() => {
  cleanup();
  previewFile.mockReset();
  usePageAnswers.setState({ byPath: {}, byThread: {}, all: 0 });
  vi.restoreAllMocks();
});

describe("HtmlPreview follows the daemon's word about its page", () => {
  it("stopped allowing in another window: the page source reads the grant again, the live page loads again refused and the footer says so", async () => {
    previewFile.mockResolvedValue(grant(ALLOWED));
    render(<HtmlPreview path={REAL} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    const posts = hello();
    await waitFor(() => {
      expect(posts).toContainEqual(expect.objectContaining({ type: "cf:ready", thread: null }));
    });
    expect(screen.getByTestId("file-html-consent").textContent).toBe("Stop allowing");
    const frame = screen.getByTestId("file-html-frame");
    expect(frame.dataset.load).toBe("0");

    previewFile.mockResolvedValue(grant(REFUSED));
    pageEvent({ paths: [REAL] });
    await waitFor(() => {
      expect(footer().dataset.consent).toBe("refused");
    });
    expect(previewFile).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("file-html-consent").textContent).toBe("Allow Code Foundry");
    // The document that had the bridge is stopped and loaded again under the refusal.
    await waitFor(() => {
      expect(screen.getByTestId("file-html-frame").dataset.load).toBe("1");
    });
  });

  it("an event for another page, or another thread's removal, reads nothing", async () => {
    previewFile.mockResolvedValue(grant(OWNED));
    render(<HtmlPreview path={REAL} text="x" name="board.html" />, { wrapper: inTab("thread:s-2") });
    await screen.findByTestId("file-html-frame");
    pageEvent({ paths: ["/Users/me/real/other.html"] });
    pageEvent({ removedThread: "s-2" });
    await act(() => Promise.resolve());
    expect(previewFile).toHaveBeenCalledTimes(1);
  });

  it("its owner removed: the tab reads the grant again and is the page no thread owns, asked about, not a dead thread's", async () => {
    previewFile.mockResolvedValue(grant(OWNED));
    render(<HtmlPreview path={REAL} text="x" name="board.html" />, { wrapper: inTab("thread:s-2") });
    await screen.findByTestId("file-html-frame");
    expect(screen.getByTestId("file-html-footer-owner").textContent).toBe("Board");
    expect(screen.getByTestId("file-html-frame").getAttribute("sandbox")).toBe(THREAD_PAGE_SANDBOX);

    previewFile.mockResolvedValue(grant(access()));
    useThreadsStore.setState({ byId: { "s-2": { id: "s-2", name: "Fix login" } as ThreadView }, order: ["s-2"] });
    pageEvent({ removedThread: "s-9" });
    await waitFor(() => {
      expect(screen.getByTestId("file-html-frame").getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    });
    expect(screen.queryByTestId("file-html-footer-owner")).toBeNull();
    expect(footer().dataset.consent).toBe("not-asked");
    hello();
    expect(await screen.findByTestId("page-consent")).toBeTruthy();
  });

  it("Refresh reads the grant again: a tab opened while a thread owned the page comes back under what the daemon says now", async () => {
    previewFile.mockResolvedValue(grant(OWNED));
    const { rerender } = render(<HtmlPreview path={REAL} text="x" name="board.html" reloads={0} />, { wrapper: inTab("thread:s-2") });
    await screen.findByTestId("file-html-frame");
    previewFile.mockResolvedValue(grant(ALLOWED));
    rerender(<HtmlPreview path={REAL} text="x" name="board.html" reloads={1} />);
    await waitFor(() => {
      expect(footer().dataset.consent).toBe("allowed");
    });
    expect(screen.queryByTestId("file-html-footer-owner")).toBeNull();
  });

  it("every page again when the event stream connects", async () => {
    previewFile.mockResolvedValue(grant(ALLOWED));
    render(<HtmlPreview path={REAL} text="x" name="board.html" />);
    await screen.findByTestId("file-html-frame");
    previewFile.mockResolvedValue(grant(REFUSED));
    pageEvent({ all: true });
    await waitFor(() => {
      expect(footer().dataset.consent).toBe("refused");
    });
  });
});
