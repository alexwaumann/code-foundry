import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The thread view inside is the plugin node's (InlineThread, its own tests): a stand-in with a field.
vi.mock("@/components/thread/InlineThread", () => ({
  InlineThread: ({ threadId }: { threadId: string }) => (
    <div data-testid="inline-thread" data-thread-id={threadId}>
      <input data-testid="reason" aria-label="Reason for denying" />
    </div>
  ),
}));

const { NeedsPopup } = await import("./NeedsPopup");
const { thread } = await import("@/test/projectsWorld");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { HOME, useUiStore } = await import("@/stores/ui");
const { closeNeedsPopup, openNeedsPopup, resetNeeds, useNeedsStore } = await import("@/stores/needs");

/**
 * The Needs-you popup (docs/notes/shell-17-needs-you.md): which thread it shows, Go to thread,
 * closing once the ask is answered, and Escape. Its stream (one Watch, shared, released on close)
 * is e2e's (shell-needs.spec.ts).
 */

const PENDING = { requestId: "req-1", itemId: "perm-1", question: false, toolName: "Bash", summary: "Bash ls" };

function setPending(id: string, on: boolean): void {
  useThreadStore.setState((s) => ({ pending: { ...s.pending, [id]: { threadId: id, seq: on ? 1 : 2, pending: on ? [PENDING] : [] } } }));
}

beforeEach(() => {
  resetNeeds();
  useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", { name: "Fix stale PR badge", status: "attention", statusReason: "permission: Bash ls" }) }, order: ["s-1"], loaded: true });
  useProjectsStore.setState({ byId: { "repo-cf": { id: "repo-cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [] } } as never, order: ["repo-cf"] });
  useUiStore.setState({ selection: HOME });
  setPending("s-1", true);
});

afterEach(() => {
  cleanup();
});

describe("the Needs-you popup", () => {
  it("shows the thread named by the store: its place and name, the thread view, Go to thread", () => {
    render(<NeedsPopup />);
    expect(screen.queryByTestId("needs-popup")).toBeNull();
    act(() => {
      openNeedsPopup("s-1");
    });
    expect(screen.getByTestId("needs-popup").getAttribute("data-thread-id")).toBe("s-1");
    expect(screen.getByTestId("needs-popup-title").textContent).toBe("Fix stale PR badge");
    expect(screen.getByTestId("needs-popup").textContent).toContain("code-foundry");
    expect(screen.getByTestId("inline-thread").getAttribute("data-thread-id")).toBe("s-1");
  });

  it("opens nothing for a thread the list does not have", () => {
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-gone");
    });
    expect(screen.queryByTestId("needs-popup")).toBeNull();
  });

  it("Go to thread closes it and selects the thread (its space and tab, through the selection bridge)", () => {
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    fireEvent.click(screen.getByTestId("needs-popup-go"));
    expect(useNeedsStore.getState().popup).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
  });

  it("closes once the thread no longer waits on an answer", () => {
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    act(() => {
      setPending("s-1", false);
    });
    expect(useNeedsStore.getState().popup).toBeNull();
    expect(screen.queryByTestId("needs-popup")).toBeNull();
  });

  it("stays open for an ask without a request until it is closed", () => {
    setPending("s-1", false);
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    expect(screen.getByTestId("needs-popup")).toBeTruthy();
    fireEvent.click(screen.getByTestId("needs-popup-close"));
    expect(useNeedsStore.getState().popup).toBeNull();
  });

  it("puts the keyboard on the ask once it is drawn, unless the user put it elsewhere first", () => {
    const drawAsk = () => {
      const prompts = document.createElement("div");
      prompts.setAttribute("data-testid", "thread-prompts");
      const ask = document.createElement("div");
      ask.className = "pend";
      ask.tabIndex = -1;
      prompts.append(ask);
      screen.getByTestId("inline-thread").append(prompts);
      return ask;
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    expect(document.activeElement).toBe(screen.getByTestId("needs-popup"));
    return (async () => {
      // The user clicked into a field while the Watch drew: the ask arrives and leaves it there.
      const reason = screen.getByTestId("reason");
      reason.focus();
      drawAsk();
      await act(flush);
      expect(document.activeElement).toBe(reason);

      // Opened again, nothing touched: the ask takes the keyboard as soon as it is drawn.
      act(() => {
        closeNeedsPopup();
      });
      act(() => {
        openNeedsPopup("s-1");
      });
      const ask = drawAsk();
      await act(flush);
      expect(document.activeElement).toBe(ask);
    })();
  });

  it("Escape in a field is the field's (the deny reason cancels); elsewhere it closes the popup", () => {
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    const reason = screen.getByTestId("reason");
    reason.focus();
    fireEvent.keyDown(reason, { key: "Escape" });
    expect(useNeedsStore.getState().popup).toBe("s-1");
    const dialog = screen.getByTestId("needs-popup");
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(useNeedsStore.getState().popup).toBeNull();
  });
});
