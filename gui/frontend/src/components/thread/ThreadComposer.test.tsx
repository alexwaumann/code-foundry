import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
// A PDF's pages (pdf.js does not run in jsdom) and the daemon's staging, which names the file with them.
vi.mock("@/lib/pdf", () => ({ pdfSummary: () => Promise.resolve({ pages: 3, thumb: "data:image/png;base64,AA==" }), loadPdf: () => Promise.reject(new Error("no pdf.js")) }));
vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), stageAttachment: (_f: unknown, pages: number | null) => Promise.resolve(`/att/0123-${String(pages)}p.pdf`) }));

const { daemon, invocationsOf, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { thread } = await import("@/test/projectsWorld");
const { updateDraft, useComposeStore } = await import("@/stores/compose");
const { useThreadsStore } = await import("@/stores/threads");
const { threadDraftKey } = await import("@/stores/threadActions");
const { ThreadComposer } = await import("./ThreadComposer");

/**
 * The thread's follow-up composer (ThreadComposer) over the mock's s-r1: its placeholder and
 * Interrupt by whether Claude works, an effort change, the API-retry line on its own clock and
 * a message the daemon refuses. The daemon's thread changes (effort, retry) are store updates
 * here, as its thread events would be.
 */

function put(o: Partial<ThreadView> = {}): void {
  useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-r1": { ...(s.byId["s-r1"] ?? thread("s-r1", { state: "connected" })), ...o } }, order: ["s-r1"] }));
}

const KEY = threadDraftKey("s-r1");
const editor = () => screen.getByTestId("composer-input");
const draftText = () => useComposeStore.getState().drafts[KEY]?.text ?? "";

beforeEach(() => {
  resetDaemon();
  put();
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useComposeStore.setState({ drafts: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("the follow-up prompt", () => {
  it("says a message while Claude works steers the turn, with the one Interrupt; once idle it asks for a reply, no Interrupt", () => {
    const { rerender } = render(<ThreadComposer threadId="s-r1" pending={[]} busy />);
    expect(editor().getAttribute("aria-placeholder")).toBe("Steer the agent mid-turn. @ files and threads, / skills and commands");
    expect(screen.getAllByRole("button", { name: /Interrupt/ })).toHaveLength(1);
    fireEvent.click(screen.getByTestId("thread-interrupt"));
    expect(invocationsOf("thread.interrupt").map((i) => i.args)).toEqual([{ id: "s-r1" }]);
    rerender(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    expect(editor().getAttribute("aria-placeholder")).toBe("Reply or ask anything. @ files and threads, / skills and commands");
    expect(screen.queryAllByRole("button", { name: /Interrupt/ })).toHaveLength(0);
  });
});

describe("the effort picker", () => {
  async function pick(label: string): Promise<void> {
    fireEvent.click(screen.getByTestId("thread-effort"));
    fireEvent.click(await screen.findByRole("option", { name: label }));
  }

  it("while busy: thread.set-effort at once, the picker shows the new effort and says it waits for the turn; the turn's end clears it", async () => {
    // The daemon takes the effort and holds it for after the turn.
    daemon.handlers.set("thread.set-effort", (inv) => {
      put({ effort: inv.args.effort ?? "", effortPending: true });
      return { message: "", resultJson: "" };
    });
    const { rerender } = render(<ThreadComposer threadId="s-r1" pending={[]} busy />);
    await pick("Max");
    await waitFor(() => {
      expect(invocationsOf("thread.set-effort").map((i) => i.args)).toEqual([{ id: "s-r1", effort: "max" }]);
    });
    expect(screen.getByTestId("thread-effort").textContent).toContain("Max");
    expect(screen.getByTestId("thread-effort-pending").textContent).toBe("Effort changes to Max after this turn");
    // The turn ends; the daemon restarts Claude with it.
    act(() => {
      put({ effortPending: false });
    });
    rerender(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    expect(screen.queryByTestId("thread-effort-pending")).toBeNull();
  });

  it("when idle it applies at once: no line about the turn", async () => {
    daemon.handlers.set("thread.set-effort", (inv) => {
      put({ effort: inv.args.effort ?? "" });
      return { message: "", resultJson: "" };
    });
    render(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    await pick("Low");
    await waitFor(() => {
      expect(invocationsOf("thread.set-effort").map((i) => i.args)).toEqual([{ id: "s-r1", effort: "low" }]);
    });
    expect(screen.getByTestId("thread-effort").textContent).toContain("Low");
    expect(screen.queryByTestId("thread-effort-pending")).toBeNull();
  });

  it("the restart under way while idle says so", () => {
    put({ effort: "high", effortPending: true });
    render(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    expect(screen.getByTestId("thread-effort-pending").textContent).toBe("Switching to High effort…");
  });
});

describe("the API-retry line", () => {
  const NOW = new Date(2026, 9, 20, 15, 0, 0).getTime();
  const retry = (inSeconds: number, o: Partial<NonNullable<ThreadView["retry"]>> = {}) => ({ attempt: 3, maxRetries: 10, retryAtMs: NOW + inSeconds * 1000, errorStatus: 429, error: "rate_limit", ...o });
  const note = () => screen.queryByTestId("thread-retry");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });

  it("a rate-limit retry shows in the card, above the prompt, while the thread works; the next frame clears it", () => {
    render(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    expect(note()).toBeNull();
    act(() => {
      put({ retry: retry(20), status: "busy" });
    });
    expect(note()?.textContent).toBe("Rate limited · retrying in 20 s (attempt 3 of 10)");
    // In the card, before the prompt.
    const card = screen.getByTestId("thread-composer");
    expect(card.contains(note())).toBe(true);
    expect((note() as HTMLElement).compareDocumentPosition(editor()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => {
      put({ retry: null });
    });
    expect(note()).toBeNull();
  });

  it("counts down on the composer's own clock and turns into retrying now", () => {
    put({ retry: retry(5, { attempt: 1, errorStatus: 529, error: "overloaded" }) });
    render(<ThreadComposer threadId="s-r1" pending={[]} busy />);
    expect(note()?.textContent).toBe("API overloaded · retrying in 5 s (attempt 1 of 10)");
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(note()?.textContent).toBe("API overloaded · retrying in 2 s (attempt 1 of 10)");
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(note()?.textContent).toBe("API overloaded · retrying now (attempt 1 of 10)");
  });
});

describe("a message the daemon refuses", () => {
  it("shows the daemon's text under the composer and keeps the message; a message it takes goes and clears it", async () => {
    daemon.handlers.set("thread.send", (inv) => {
      if (inv.args.text?.startsWith("/clear ")) throw refuse("Start a new thread instead of clearing this one.");
      return { message: "", resultJson: "" };
    });
    render(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    act(() => {
      updateDraft(KEY, { text: "/clear please" });
    });
    fireEvent.click(screen.getByTestId("thread-send"));
    expect((await screen.findByTestId("thread-composer-error")).textContent).toBe("Start a new thread instead of clearing this one.");
    expect(screen.getByTestId("thread-composer-error").getAttribute("role")).toBe("alert");
    expect(draftText()).toBe("/clear please");
    expect(invocationsOf("thread.send").map((i) => i.args.text)).toEqual(["/clear please"]);
    // (Typing clears it too: the editor's onChange, e2e/thread-slash-commands.spec.ts.)
    act(() => {
      updateDraft(KEY, { text: "/clearly fine" });
    });
    fireEvent.click(screen.getByTestId("thread-send"));
    await waitFor(() => {
      expect(invocationsOf("thread.send").map((i) => i.args.text)).toEqual(["/clear please", "/clearly fine"]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("thread-composer-error")).toBeNull();
    });
    expect(draftText()).toBe("");
  });
});

describe("sending", () => {
  it("a message while Claude works goes through thread.send like any (the timeline shows it as a steer)", async () => {
    render(<ThreadComposer threadId="s-r1" pending={[]} busy />);
    act(() => {
      updateDraft(KEY, { text: "Also say hi when you are done" });
    });
    fireEvent.click(screen.getByTestId("thread-send"));
    await waitFor(() => {
      expect(invocationsOf("thread.send").map((i) => i.args)).toEqual([{ id: "s-r1", text: "Also say hi when you are done" }]);
    });
    expect(draftText()).toBe("");
  });

  it("a follow-up takes a PDF: a tile and a chip with its pages, sent as [PDF: name; ref=staged path]", async () => {
    render(<ThreadComposer threadId="s-r1" pending={[]} busy={false} />);
    expect(screen.getByTestId("thread-attach").getAttribute("aria-label")).toBe("Attach images or PDFs");
    act(() => {
      updateDraft(KEY, { text: "Check " });
    });
    const pdf = new File([new Uint8Array(1200)], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("thread-file-input"), { target: { files: [pdf] } });
    await waitFor(() => {
      expect(screen.getByTestId("attachment").getAttribute("data-pages")).toBe("3");
    });
    expect(screen.getByTestId("prompt-chip").getAttribute("aria-label")).toBe("PDF attachment, spec.pdf, 3 pages");
    fireEvent.click(screen.getByTestId("thread-send"));
    await waitFor(() => {
      expect(invocationsOf("thread.send").map((i) => i.args.text)).toEqual(["Check [PDF: spec.pdf; ref=/att/0123-3p.pdf]"]);
    });
  });
});
