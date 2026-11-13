import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView, ThreadPendingView, ThreadRequestView } from "@/api/thread";

// The verbs the card runs (thread.respond through stores/threadActions).
const runs: { name: string; args: Record<string, string> }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
// The card's one read without a Watch (two ListItems pages).
const readAskItems = vi.hoisted(() => vi.fn());
vi.mock("@/api/threadSearch", async (orig) => ({ ...(await orig<typeof import("@/api/threadSearch")>()), readAskItems }));

const { NeedsCardBody, NeedsHoverCard } = await import("./NeedsCard");
const { CF, thread } = await import("@/test/projectsWorld");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { HOME, useUiStore } = await import("@/stores/ui");
const { closeNeedsPopup, openNeedsPopup, requestOpen, resetNeeds, useNeedsStore } = await import("@/stores/needs");

/**
 * The Needs-you hover card (docs/notes/shell-17-needs-you.md): what it shows per kind of ask,
 * that a question is never answered in it, which verb each button runs, and the popup shutting
 * it until its anchor is hovered again. The pointer path into it is e2e's (shell-needs.spec.ts).
 */

const LONG = [
  "gh api graphql -f query='",
  "  query($owner: String!, $name: String!) {",
  "    repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50) { nodes { number headRefOid } } }",
  "  }' -F owner=me -F name=code-foundry | jq '.data' > /tmp/pr-heads.json",
].join("\n");

const QUESTION = {
  questions: [
    {
      question: "Which part of the renderer should I port first?",
      header: "Order",
      multiSelect: false,
      options: [
        { label: "The cell grid", description: "Everything draws on it" },
        { label: "The cursor", description: "" },
      ],
    },
  ],
};

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

function request(over: Partial<ThreadRequestView>): ThreadRequestView {
  return { requestId: "", toolName: "", displayName: "", title: "", description: "", toolUseId: "", agentId: "", blockedPath: "", decisionReason: "", inputJson: "", suggestionsJson: "", state: "pending", decision: "", message: "", answers: {}, ...over };
}

const permItem = (r: Partial<ThreadRequestView>): ThreadItemView => ({ ...base, id: "perm-1", ordinal: 9, kind: "permission", request: request(r) });
const questionItem = (r: Partial<ThreadRequestView>): ThreadItemView => ({ ...base, id: "q-1", ordinal: 9, kind: "question", request: request({ toolName: "AskUserQuestion", ...r }) });
const text = (id: string, ordinal: number, t: string): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text: t });

const PERM: ThreadPendingView = { requestId: "req-1", itemId: "perm-1", question: false, toolName: "Bash", summary: "Bash gh api graphql -f query='" };
const ASK: ThreadPendingView = { requestId: "req-q", itemId: "q-1", question: true, toolName: "AskUserQuestion", summary: QUESTION.questions[0]?.question ?? "" };

/** A thread waiting on `pending`, its items known only to the daemon (no Watch). */
function waiting(id: string, pending: ThreadPendingView, items: ThreadItemView[], o: Parameters<typeof thread>[1] = {}): void {
  useThreadsStore.setState((s) => ({
    byId: { ...s.byId, [id]: thread(id, { name: "Fix stale PR badge", status: "attention", statusReason: pending.question ? "question: x" : "permission: x", state: "connected", ...o }) },
    order: [...s.order, id],
    loaded: true,
  }));
  useThreadStore.setState((s) => ({ pending: { ...s.pending, [id]: { threadId: id, seq: 1, pending: [pending] } } }));
  readAskItems.mockImplementation((tid: string, itemId: string) =>
    Promise.resolve(tid === id ? { ask: items.find((it) => it.id === itemId) ?? null, replies: items.filter((it) => it.kind === "text") } : { ask: null, replies: [] }),
  );
}

beforeEach(() => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: "{}" });
  });
  resetNeeds();
  useThreadsStore.setState({ byId: {}, order: [], loaded: true });
  useThreadStore.setState({ logs: {}, pending: {}, synced: {}, answering: {} });
  useProjectsStore.setState({ byId: { "repo-cf": { id: "repo-cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [] } } as never, order: ["repo-cf"] });
  useUiStore.setState({ selection: HOME });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the hover card's contents", () => {
  it("a permission: the tool, the whole command, the thread and the last line Claude wrote; Allow, Deny, Go to thread", async () => {
    waiting("s-1", PERM, [text("t-1", 3, "The poller skipped PRs.\n\nThe fingerprint now includes the **head SHA**."), permItem({ requestId: "req-1", toolName: "Bash", displayName: "Bash", inputJson: JSON.stringify({ command: LONG }) })]);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    const body = screen.getByTestId("needs-card-body");
    expect(body.getAttribute("data-ask")).toBe("permission");
    await waitFor(() => {
      expect(screen.getByTestId("needs-card-target").getAttribute("data-kind")).toBe("command");
    });
    expect(body.textContent).toContain("Allow Claude to run this command?");
    expect(screen.getByTestId("needs-card-tool").textContent).toBe("Bash");
    // The whole command, every line of it.
    expect(screen.getByTestId("needs-card-target").textContent).toBe(`$ ${LONG}`);
    expect(screen.getByTestId("needs-card-thread").textContent).toContain("code-foundry");
    expect(screen.getByTestId("needs-card-thread").textContent).toContain("Fix stale PR badge");
    expect(screen.getByTestId("needs-card-context").textContent).toBe("“The fingerprint now includes the head SHA.”");
    expect(within(body).getAllByRole("button").map((b) => b.textContent)).toEqual(["Allow", "Deny", "Go to thread"]);
    expect(readAskItems).toHaveBeenCalledWith("s-1", "perm-1");
  });

  it("a file: its path relative to the thread's checkout", async () => {
    waiting("s-1", { ...PERM, toolName: "Write", summary: "Write notes.md" }, [permItem({ requestId: "req-1", toolName: "Write", displayName: "Write", inputJson: JSON.stringify({ file_path: `${CF}/docs/notes.md`, content: "x" }) })]);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("needs-card-target").textContent).toBe("docs/notes.md");
    });
    expect(screen.getByTestId("needs-card-body").textContent).toContain("Allow Claude to write docs/notes.md?");
  });

  it("an edit or a write: Allow comes only with the change on screen, its +/− summary and the diff, as the pane's card has them", async () => {
    const input = { file_path: `${CF}/src/app.ts`, old_string: "const a = 1;\n", new_string: "const a = 2;\nconst b = 3;\n" };
    waiting("s-1", { ...PERM, toolName: "Edit", summary: "Edit app.ts" }, [permItem({ requestId: "req-1", toolName: "Edit", displayName: "Edit", inputJson: JSON.stringify(input) })]);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    const diff = await screen.findByTestId("thread-permission-diff");
    expect(diff.textContent).toContain("Hide the change+2−1");
    expect(within(diff).getByTestId("thread-diff").querySelector("diffs-container")).not.toBeNull();
    expect(screen.getByTestId("needs-card-allow")).toBeTruthy();
  });

  it("a thread whose Watch is open: the ask from its log, nothing read", () => {
    waiting("s-1", PERM, []);
    const item = permItem({ requestId: "req-1", toolName: "Bash", displayName: "Bash", inputJson: JSON.stringify({ command: "make check" }) });
    useThreadStore.setState({
      logs: { "s-1": { seq: 1, byId: { [item.id]: item, "t-1": text("t-1", 2, "Running the suite now.") }, order: ["t-1", item.id], pending: [PERM], mcp: null, commands: [], agents: [] } },
      synced: { "s-1": true },
    });
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    expect(screen.getByTestId("needs-card-target").textContent).toBe("$ make check");
    expect(screen.getByTestId("needs-card-context").textContent).toBe("“Running the suite now.”");
    expect(readAskItems).not.toHaveBeenCalled();
  });

  it("a question: the question and its options as text, never an answer control; it offers the popup and the thread", async () => {
    waiting("s-2", ASK, [questionItem({ requestId: "req-q", inputJson: JSON.stringify(QUESTION) })]);
    render(<NeedsCardBody threadId="s-2" anchor="sidebar:s-2" />);
    await waitFor(() => {
      expect(screen.getByTestId("needs-card-question").textContent).toContain("The cell grid · The cursor");
    });
    const body = screen.getByTestId("needs-card-body");
    expect(body.getAttribute("data-ask")).toBe("question");
    expect(body.textContent).toContain("Claude has a question");
    expect(screen.getByTestId("needs-card-question").textContent).toContain("Which part of the renderer should I port first?");
    expect(within(body).queryAllByRole("radio")).toHaveLength(0);
    expect(within(body).queryAllByRole("checkbox")).toHaveLength(0);
    expect(body.querySelector("input, textarea")).toBeNull();
    expect(within(body).getAllByRole("button").map((b) => b.textContent)).toEqual(["Answer…", "Go to thread"]);
  });

  it("more than one open request: the oldest, and how many more", async () => {
    waiting("s-1", PERM, [permItem({ requestId: "req-1", toolName: "Bash", inputJson: JSON.stringify({ command: "ls" }) })]);
    useThreadStore.setState((s) => ({ pending: { ...s.pending, "s-1": { threadId: "s-1", seq: 2, pending: [PERM, { ...PERM, requestId: "req-2", itemId: "perm-2" }] } } }));
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    expect(await screen.findByTestId("needs-card-more")).toHaveProperty("textContent", "+1 more");
  });
});

describe("the permission's states: Allow and Deny only with the whole request on screen", () => {
  const buttons = () => within(screen.getByTestId("needs-card-body")).getAllByRole("button").map((b) => b.textContent);
  const state = () => screen.getByTestId("needs-card-body").getAttribute("data-ask-state");

  it("loading: a quiet line, no command, no Allow or Deny", () => {
    waiting("s-1", PERM, []);
    readAskItems.mockReturnValue(new Promise(() => undefined));
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    expect(state()).toBe("loading");
    expect(screen.getByTestId("needs-card-loading").textContent).toBe("Reading the request…");
    expect(screen.queryByTestId("needs-card-target")).toBeNull();
    expect(screen.queryByTestId("needs-card-allow")).toBeNull();
    expect(screen.queryByTestId("needs-card-deny")).toBeNull();
    expect(buttons()).toEqual(["Open…", "Go to thread"]);
  });

  it("failed: the summary and why, with Open… and Go to thread only; the next open reads again", async () => {
    waiting("s-1", PERM, []);
    readAskItems.mockRejectedValueOnce(new Error("unavailable"));
    const { unmount } = render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    await waitFor(() => {
      expect(state()).toBe("failed");
    });
    expect(screen.getByTestId("needs-card-target").textContent).toBe(PERM.summary);
    expect(screen.getByTestId("needs-card-target").getAttribute("data-kind")).toBe("summary");
    expect(screen.getByTestId("needs-card-unavailable").textContent).toBe("The full request could not be read. Open it to see it whole.");
    expect(buttons()).toEqual(["Open…", "Go to thread"]);
    expect(readAskItems).toHaveBeenCalledTimes(1);
    unmount();
    // The next open: read again, and this time it lands.
    const item = permItem({ requestId: "req-1", toolName: "Bash", displayName: "Bash", inputJson: JSON.stringify({ command: "make check" }) });
    readAskItems.mockResolvedValueOnce({ ask: item, replies: [] });
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    expect(readAskItems).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(state()).toBe("known");
    });
    expect(screen.getByTestId("needs-card-target").textContent).toBe("$ make check");
    expect(buttons()).toEqual(["Allow", "Deny", "Go to thread"]);
  });

  it("not found (not among the thread's last tool items, or another request's item): the summary, Open… and Go to thread only", async () => {
    waiting("s-1", PERM, []);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    await waitFor(() => {
      expect(state()).toBe("notfound");
    });
    expect(screen.getByTestId("needs-card-unavailable").textContent).toBe("The full request is not among the thread's latest items. Open it to see it whole.");
    expect(buttons()).toEqual(["Open…", "Go to thread"]);
    cleanup();
    resetNeeds();
    // The item under that id answers another request: not this one's command.
    waiting("s-1", PERM, [permItem({ requestId: "req-other", toolName: "Bash", inputJson: JSON.stringify({ command: "rm -rf build" }) })]);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    await waitFor(() => {
      expect(state()).toBe("notfound");
    });
    expect(screen.getByTestId("needs-card-body").textContent).not.toContain("rm -rf build");
    expect(screen.queryByTestId("needs-card-allow")).toBeNull();
  });

  it("known: the whole command, then Allow and Deny answer that request with thread.respond, and the card shuts", async () => {
    waiting("s-1", PERM, [permItem({ requestId: "req-1", toolName: "Bash", inputJson: JSON.stringify({ command: "ls" }) })]);
    const { unmount } = render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    const allow = await screen.findByTestId("needs-card-allow");
    expect(state()).toBe("known");
    fireEvent.click(allow);
    await waitFor(() => {
      expect(runs).toEqual([{ name: "thread.respond", args: { id: "s-1", request: "req-1", decision: "allow" } }]);
    });
    expect(useNeedsStore.getState().dismissed).toBe("sidebar:s-1");
    unmount();
    runs.length = 0;
    useThreadStore.setState({ answering: {} });
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    fireEvent.click(await screen.findByTestId("needs-card-deny"));
    await waitFor(() => {
      expect(runs).toEqual([{ name: "thread.respond", args: { id: "s-1", request: "req-1", decision: "deny" } }]);
    });
  });
});

describe("the oldest request changing while the card is open", () => {
  const A: ThreadPendingView = { requestId: "req-a", itemId: "perm-a", question: false, toolName: "Bash", summary: "Bash make check" };
  const B: ThreadPendingView = { requestId: "req-b", itemId: "perm-b", question: false, toolName: "Bash", summary: "Bash git push --force" };
  const itemA: ThreadItemView = { ...base, id: "perm-a", ordinal: 5, kind: "permission", request: request({ requestId: "req-a", toolName: "Bash", inputJson: JSON.stringify({ command: "make check" }) }) };
  const itemB: ThreadItemView = { ...base, id: "perm-b", ordinal: 7, kind: "permission", request: request({ requestId: "req-b", toolName: "Bash", inputJson: JSON.stringify({ command: "git push --force" }) }) };
  const setPending = (...ps: ThreadPendingView[]) => {
    act(() => {
      useThreadStore.setState((s) => ({ pending: { ...s.pending, "s-1": { threadId: "s-1", seq: 3, pending: ps } } }));
    });
  };

  it("the buttons act on the request whose command is shown: A until it goes, then nothing until B is read, then B", async () => {
    waiting("s-1", A, [itemA]);
    let resolveB: (v: { ask: ThreadItemView; replies: ThreadItemView[] }) => void = () => undefined;
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("needs-card-target").textContent).toBe("$ make check");
    });
    expect(screen.getByTestId("needs-card-body").getAttribute("data-request-id")).toBe("req-a");

    // A is answered elsewhere: B is the oldest now, its command not read yet. No buttons, not A's command.
    readAskItems.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));
    setPending(B);
    expect(screen.getByTestId("needs-card-body").getAttribute("data-ask-state")).toBe("loading");
    expect(screen.getByTestId("needs-card-body").textContent).not.toContain("make check");
    expect(screen.queryByTestId("needs-card-allow")).toBeNull();

    await act(async () => {
      resolveB({ ask: itemB, replies: [] });
      await Promise.resolve();
    });
    expect(screen.getByTestId("needs-card-target").textContent).toBe("$ git push --force");
    expect(screen.getByTestId("needs-card-body").getAttribute("data-request-id")).toBe("req-b");
    fireEvent.click(screen.getByTestId("needs-card-allow"));
    await waitFor(() => {
      expect(runs).toEqual([{ name: "thread.respond", args: { id: "s-1", request: "req-b", decision: "allow" } }]);
    });
  });

  it("a new request ahead of the shown one (from the log): the card shows it, and Deny answers it, not the one shown before", async () => {
    waiting("s-1", B, []);
    useThreadStore.setState({
      logs: { "s-1": { seq: 1, byId: { [itemA.id]: itemA, [itemB.id]: itemB }, order: [itemA.id, itemB.id], pending: [B], mcp: null, commands: [], agents: [] } },
      synced: { "s-1": true },
    });
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    expect(screen.getByTestId("needs-card-target").textContent).toBe("$ git push --force");
    act(() => {
      useThreadStore.setState((s) => ({ logs: { "s-1": { ...(s.logs["s-1"] as NonNullable<(typeof s.logs)[string]>), pending: [A, B] } } }));
    });
    expect(screen.getByTestId("needs-card-target").textContent).toBe("$ make check");
    expect(screen.getByTestId("needs-card-body").getAttribute("data-request-id")).toBe("req-a");
    fireEvent.click(screen.getByTestId("needs-card-deny"));
    await waitFor(() => {
      expect(runs).toEqual([{ name: "thread.respond", args: { id: "s-1", request: "req-a", decision: "deny" } }]);
    });
  });

  it("a click on a request that is no longer open sends nothing", () => {
    waiting("s-1", A, []);
    useThreadStore.setState({ logs: { "s-1": { seq: 1, byId: { [itemA.id]: itemA }, order: [itemA.id], pending: [A], mcp: null, commands: [], agents: [] } }, synced: { "s-1": true } });
    expect(requestOpen("s-1", "req-a")).toBe(true);
    useThreadStore.setState({ answering: { "s-1": { "req-a": true } } });
    expect(requestOpen("s-1", "req-a")).toBe(false);
    useThreadStore.setState({ answering: {}, logs: { "s-1": { seq: 2, byId: { [itemA.id]: itemA }, order: [itemA.id], pending: [], mcp: null, commands: [], agents: [] } } });
    expect(requestOpen("s-1", "req-a")).toBe(false);
  });
});

describe("the hover card's buttons", () => {
  it("Go to thread selects the thread (the selection bridge opens its tab in its space) and runs no answer", () => {
    waiting("s-1", PERM, []);
    render(<NeedsCardBody threadId="s-1" anchor="sidebar:s-1" />);
    fireEvent.click(screen.getByTestId("needs-card-go"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(runs).toEqual([]);
  });

  it("a question's Answer… opens its popup", () => {
    waiting("s-2", ASK, []);
    render(<NeedsCardBody threadId="s-2" anchor="sidebar:s-2" />);
    fireEvent.click(screen.getByTestId("needs-card-open"));
    expect(useNeedsStore.getState().popup).toBe("s-2");
    expect(useNeedsStore.getState().dismissed).toBe("sidebar:s-2");
    expect(runs).toEqual([]);
  });
});

describe("the card around its anchor", () => {
  const hover = async (el: HTMLElement) => {
    fireEvent.pointerEnter(el, { pointerType: "mouse" });
    await act(() => new Promise((r) => setTimeout(r, 260)));
  };
  const leave = async (el: HTMLElement) => {
    fireEvent.pointerLeave(el, { pointerType: "mouse" });
    await act(() => new Promise((r) => setTimeout(r, 260)));
  };

  it("opens on hover; the popup shuts it until the anchor is hovered again", async () => {
    waiting("s-1", PERM, []);
    render(
      <NeedsHoverCard threadId="s-1" anchor="sidebar:s-1">
        <div data-testid="anchor">row</div>
      </NeedsHoverCard>,
    );
    const anchor = screen.getByTestId("anchor");
    await hover(anchor);
    expect(screen.getByTestId("needs-card")).toBeTruthy();
    act(() => {
      openNeedsPopup("s-1", "sidebar:s-1");
    });
    expect(screen.queryByTestId("needs-card")).toBeNull();
    act(() => {
      closeNeedsPopup();
    });
    // Still under the pointer, but not hovered again: shut.
    expect(screen.queryByTestId("needs-card")).toBeNull();
    await leave(anchor);
    await hover(anchor);
    expect(screen.getByTestId("needs-card")).toBeTruthy();
  });

  it("opens without the pointer while the keyboard is on it, and stays shut while disabled", () => {
    waiting("s-1", PERM, []);
    const { rerender } = render(
      <NeedsHoverCard threadId="s-1" anchor="sidebar:s-1" keyboardOpen>
        <div>row</div>
      </NeedsHoverCard>,
    );
    expect(screen.getByTestId("needs-card")).toBeTruthy();
    rerender(
      <NeedsHoverCard threadId="s-1" anchor="sidebar:s-1" keyboardOpen enabled={false}>
        <div>row</div>
      </NeedsHoverCard>,
    );
    expect(screen.queryByTestId("needs-card")).toBeNull();
  });
});
