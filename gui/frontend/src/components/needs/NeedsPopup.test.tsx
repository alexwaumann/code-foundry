import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The thread view inside is the plugin node's (InlineThread, its own tests): a stand-in with a field.
// `ask` is the one request it docks under the stepper (undefined: every one, as today).
vi.mock("@/components/thread/InlineThread", () => ({
  InlineThread: ({ threadId, ask }: { threadId: string; ask?: string }) => (
    <div data-testid="inline-thread" data-thread-id={threadId} data-ask={ask ?? "all"}>
      <input data-testid="reason" aria-label="Reason for denying" />
      <div data-testid="editor" contentEditable suppressContentEditableWarning tabIndex={0} />
      {ask !== undefined && (
        <div data-testid="thread-prompts">
          <div key={ask} className="pend" tabIndex={-1} data-testid="ask" data-request-id={ask} />
        </div>
      )}
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

describe("the stepper over several open requests (docs/notes/needs-you-line-items.md)", () => {
  const req = (n: number, question = false) => ({ requestId: `req-${String(n)}`, itemId: `item-${String(n)}`, question, toolName: question ? "AskUserQuestion" : "Bash", summary: question ? "Which base branch?" : `Bash cmd ${String(n)}` });
  const set = (...ids: number[]) => {
    act(() => {
      useThreadStore.setState((s) => ({ pending: { ...s.pending, "s-1": { threadId: "s-1", seq: (s.pending["s-1"]?.seq ?? 0) + 1, pending: ids.map((n) => req(n, n === 3)) } } }));
    });
  };
  const shown = () => screen.getByTestId("inline-thread").getAttribute("data-ask");
  const count = () => screen.getByTestId("needs-stepper-count").textContent;
  const dots = () => screen.getAllByTestId("needs-stepper-dot").map((d) => `${d.getAttribute("data-request-id") ?? ""}${d.hasAttribute("data-current") ? "*" : ""}`);

  const open = (requestId: string | null = null) => {
    render(<NeedsPopup />);
    set(1, 2, 3);
    act(() => {
      openNeedsPopup("s-1", null, requestId);
    });
  };

  it("one request: no stepper, every request docks as today", () => {
    render(<NeedsPopup />);
    act(() => {
      openNeedsPopup("s-1");
    });
    expect(screen.queryByTestId("needs-stepper")).toBeNull();
    expect(shown()).toBe("all");
  });

  it("opens on the oldest from the title: a dot per request, the current one marked, \"1 of 3\", only that ask docked", () => {
    open();
    expect(dots()).toEqual(["req-1*", "req-2", "req-3"]);
    expect(count()).toBe("1 of 3");
    expect(shown()).toBe("req-1");
    expect(screen.getByTestId("needs-stepper-prev").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("needs-stepper-next").hasAttribute("disabled")).toBe(false);
  });

  it("opens on a line's request", () => {
    open("req-3");
    expect(count()).toBe("3 of 3");
    expect(shown()).toBe("req-3");
    expect(screen.getByTestId("needs-stepper-next").hasAttribute("disabled")).toBe(true);
  });

  it("the arrows, a dot and the left and right keys switch; the thread stays the same", () => {
    open();
    fireEvent.click(screen.getByTestId("needs-stepper-next"));
    expect(shown()).toBe("req-2");
    fireEvent.click(screen.getByTestId("needs-stepper-prev"));
    expect(shown()).toBe("req-1");
    fireEvent.click(screen.getAllByTestId("needs-stepper-dot")[2] as HTMLElement);
    expect(shown()).toBe("req-3");
    const dialog = screen.getByTestId("needs-popup");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(count()).toBe("2 of 3");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(count()).toBe("3 of 3");
    // With a modifier the key is someone else's.
    fireEvent.keyDown(dialog, { key: "ArrowLeft", metaKey: true });
    expect(count()).toBe("3 of 3");
    expect(screen.getByTestId("inline-thread").getAttribute("data-thread-id")).toBe("s-1");
  });

  it("the keys are the field's in a field and in a composer with text; an empty composer hands them over", () => {
    open();
    const reason = screen.getByTestId("reason");
    fireEvent.keyDown(reason, { key: "ArrowRight" });
    expect(count()).toBe("1 of 3");
    const editor = screen.getByTestId("editor");
    editor.textContent = "draft";
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(count()).toBe("1 of 3");
    editor.textContent = "";
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(count()).toBe("2 of 3");
  });

  it("a switch puts the keyboard on the new ask, unless the user is typing in a field", () => {
    open();
    fireEvent.keyDown(screen.getByTestId("needs-popup"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("ask"));
    expect(screen.getByTestId("ask").getAttribute("data-request-id")).toBe("req-2");
    const reason = screen.getByTestId("reason");
    reason.focus();
    fireEvent.click(screen.getByTestId("needs-stepper-next"));
    expect(document.activeElement).toBe(reason);
  });

  it("answering the current one moves to the next; after the last the popup closes", () => {
    open();
    set(2, 3);
    expect(shown()).toBe("req-2");
    expect(count()).toBe("1 of 2");
    set(3);
    // One left: no stepper, the ask as today.
    expect(screen.queryByTestId("needs-stepper")).toBeNull();
    expect(shown()).toBe("all");
    set();
    expect(useNeedsStore.getState().popup).toBeNull();
  });

  it("answering the last while earlier ones wait goes back to the first of them", () => {
    open("req-3");
    set(1, 2);
    expect(shown()).toBe("req-1");
    expect(dots()).toEqual(["req-1*", "req-2"]);
  });

  it("answered elsewhere: another one leaves the dots and keeps the current; the current one moves to the next", () => {
    open("req-2");
    set(2, 3);
    expect(dots()).toEqual(["req-2*", "req-3"]);
    expect(count()).toBe("1 of 2");
    set(1, 3);
    expect(shown()).toBe("req-3");
  });

  it("a request that arrives adds a dot without moving off the current one", () => {
    open("req-2");
    act(() => {
      useThreadStore.setState((s) => ({ pending: { ...s.pending, "s-1": { threadId: "s-1", seq: 9, pending: [req(1), req(2), req(3, true), req(4)] } } }));
    });
    expect(dots()).toEqual(["req-1", "req-2*", "req-3", "req-4"]);
    expect(count()).toBe("2 of 4");
  });

  it("a dot names its request for the screen reader, and the keys are listed", () => {
    open();
    expect(screen.getAllByTestId("needs-stepper-dot").map((d) => d.getAttribute("aria-label"))).toEqual(["1 of 3: Permission: cmd 1", "2 of 3: Permission: cmd 2", "3 of 3: Question: Which base branch?"]);
    expect(within(screen.getByTestId("needs-stepper")).getByText("switch")).toBeTruthy();
  });
});
