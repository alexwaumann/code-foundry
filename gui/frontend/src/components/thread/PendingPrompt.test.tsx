import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Code } from "@connectrpc/connect";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView, ThreadPendingView, ThreadRequestView } from "@/api/thread";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { daemon, invocationsOf, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { CF, thread } = await import("@/test/projectsWorld");
const { Toaster } = await import("@/components/ui/sonner");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadStore, useOpenRequests } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { ThreadContext } = await import("./context");
const { PendingPrompts } = await import("./PendingPrompt");
type PromptKeys = import("./PendingPrompt").PromptKeys;

/**
 * The docked prompts (PendingPrompts) over the mock's scripted s-r1 requests (mock/thread.ts:
 * the "permission", "question", "multi", "parallel" and "subagent" states), answering through
 * the faked daemon's thread.respond. What the thread does after an answer (Claude's reply, the
 * denied row) is the daemon's script and stays out of here.
 */

const PUSH = "git push --force-with-lease origin cf/pr-badge-stale";
const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

const QUESTIONS = {
  questions: [
    {
      question: "The branch was rebased onto main, so a plain push will be rejected. How should I push?",
      header: "Push",
      multiSelect: false,
      options: [
        { label: "Force with lease (Recommended)", description: "Overwrites the remote branch only if nobody else pushed to it" },
        { label: "Push to a new branch", description: "cf/pr-badge-stale-2, then retarget PR #63" },
        { label: "Don't push", description: "Leave the commits local" },
      ],
    },
    {
      question: "Should I also update the PR description?",
      header: "PR text",
      multiSelect: false,
      options: [
        { label: "Yes", description: "Mention the fingerprint change" },
        { label: "No", description: "" },
      ],
    },
  ],
};

const MULTI = {
  questions: [
    {
      question: "Which checks should I run before pushing?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "go test ./...", description: "The whole suite (about 40 s)" },
        { label: "go vet ./...", description: "" },
        { label: "staticcheck", description: "Lint, as CI does" },
      ],
    },
  ],
};

const PUSH_RULES = JSON.stringify([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git push:*" }], behavior: "allow", destination: "session" }]);
const ACCEPT_EDITS = JSON.stringify([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);

function request(over: Partial<ThreadRequestView>): ThreadRequestView {
  return {
    requestId: "",
    toolName: "",
    displayName: "",
    title: "",
    description: "",
    toolUseId: "",
    agentId: "",
    blockedPath: "",
    decisionReason: "",
    inputJson: "",
    suggestionsJson: "",
    state: "pending",
    decision: "",
    message: "",
    answers: {},
    ...over,
  };
}

let ord = 0;
function tool(id: string, name: string, input: object, parentToolUseId = ""): ThreadItemView {
  return { ...base, id, ordinal: ++ord, parentToolUseId, kind: "tool", toolUseId: id, name, inputJson: JSON.stringify(input), status: "running", output: "", isError: false, resultJson: "" };
}
function perm(id: string, r: Partial<ThreadRequestView>): ThreadItemView {
  return { ...base, id, ordinal: ++ord, kind: "permission", request: request(r) };
}
function question(id: string, r: Partial<ThreadRequestView>): ThreadItemView {
  return { ...base, id, ordinal: ++ord, kind: "question", request: request({ toolName: "AskUserQuestion", ...r }) };
}
const text = (id: string, t: string): ThreadItemView => ({ ...base, id, ordinal: ++ord, kind: "text", text: t });

interface World {
  items: ThreadItemView[];
  pending: ThreadPendingView[];
}

/** The mock's states, as the Watch's snapshot brings them. */
function world(state: "permission" | "question" | "multi" | "parallel" | "subagent"): World {
  ord = 0;
  const intro = text("t0", "All 412 tests pass.");
  switch (state) {
    case "permission": {
      const call = tool("tu-push", "Bash", { command: PUSH, description: "Force-push the rebased branch so PR #63 picks up the fix." });
      const p = perm("perm-push", {
        requestId: "req-push",
        toolName: "Bash",
        displayName: "Bash",
        toolUseId: "tu-push",
        inputJson: call.kind === "tool" ? call.inputJson : "",
        description: "Force-push the rebased branch so PR #63 picks up the fix.",
        decisionReason: "Accept edits asks before commands",
        suggestionsJson: PUSH_RULES,
      });
      return { items: [intro, call, p], pending: [{ requestId: "req-push", itemId: p.id, question: false, toolName: "Bash", summary: `Bash ${PUSH}` }] };
    }
    case "question":
    case "multi": {
      const input = state === "question" ? QUESTIONS : MULTI;
      const call = tool("tu-q", "AskUserQuestion", input);
      const requestId = state === "question" ? "req-push-q" : "req-checks";
      const q = question("q", { requestId, toolUseId: "tu-q", inputJson: JSON.stringify(input) });
      return { items: [intro, call, q], pending: [{ requestId, itemId: q.id, question: true, toolName: "AskUserQuestion", summary: input.questions[0]?.question ?? "" }] };
    }
    case "parallel": {
      const edit = tool("tu-edit", "Edit", { file_path: `${CF}/internal/store/pr/poller.go`, old_string: "\tif fp == prev {\n\t\treturn\n\t}", new_string: "\tif fp == prev && !force {\n\t\treturn\n\t}" });
      const editPerm = perm("perm-edit", { requestId: "req-edit", toolName: "Edit", displayName: "Edit", toolUseId: "tu-edit", inputJson: edit.kind === "tool" ? edit.inputJson : "", description: "poller.go", suggestionsJson: ACCEPT_EDITS });
      const push = tool("tu-push", "Bash", { command: PUSH, description: "Force-push the rebased branch so PR #63 picks up the fix." });
      const pushPerm = perm("perm-push", {
        requestId: "req-push",
        toolName: "Bash",
        displayName: "Bash",
        toolUseId: "tu-push",
        inputJson: push.kind === "tool" ? push.inputJson : "",
        description: "Force-push the rebased branch so PR #63 picks up the fix.",
        suggestionsJson: PUSH_RULES,
      });
      return {
        items: [intro, edit, editPerm, push, pushPerm],
        pending: [
          { requestId: "req-edit", itemId: editPerm.id, question: false, toolName: "Edit", summary: "Edit poller.go" },
          { requestId: "req-push", itemId: pushPerm.id, question: false, toolName: "Bash", summary: `Bash ${PUSH}` },
        ],
      };
    }
    case "subagent": {
      const agent = tool("tu-agent", "Agent", { description: "Write the changelog entry", subagent_type: "general-purpose", prompt: "Add a CHANGELOG.md entry for the force-push fix." });
      const write = tool("tu-write", "Write", { file_path: `${CF}/CHANGELOG.md`, content: "## Unreleased\n" }, "tu-agent");
      const p = perm("perm-sub", {
        requestId: "req-sub",
        toolName: "Write",
        displayName: "Write",
        toolUseId: "tu-write",
        agentId: "a69def54e0124efca",
        inputJson: write.kind === "tool" ? write.inputJson : "",
        description: "CHANGELOG.md",
        suggestionsJson: ACCEPT_EDITS,
      });
      return { items: [intro, agent, write, p], pending: [{ requestId: "req-sub", itemId: p.id, question: false, toolName: "Write", summary: "Write CHANGELOG.md" }] };
    }
  }
}

function publish(w: World): void {
  useThreadStore.setState((s) => ({
    logs: { ...s.logs, "s-r1": { seq: w.items.length, byId: Object.fromEntries(w.items.map((it) => [it.id, it])), order: w.items.map((it) => it.id), pending: w.pending, mcp: null, commands: [], agents: [] } },
  }));
}

const refocus = vi.fn();
/** The composer's ref the oldest prompt registers its key handler on. */
const keys: { current: PromptKeys | null } = { current: null };

/** The composer's dock: the open requests (answered ones leave at once), the oldest taking the editor's keys. */
function Dock() {
  const open = useOpenRequests("s-r1");
  return open.length > 0 ? <PendingPrompts pending={open} keysRef={keys} refocus={refocus} /> : null;
}

function mount(w: World) {
  publish(w);
  return render(
    <ThreadContext.Provider value={{ threadId: "s-r1", cwd: CF }}>
      <Dock />
      <Toaster theme="dark" />
    </ThreadContext.Provider>,
  );
}

/** A key the composer's empty editor hands to the oldest prompt (ThreadComposer's keysRef). */
function editorKey(key: string): boolean {
  let took = false;
  act(() => {
    took = keys.current?.({ key, plain: true, from: "editor", editorEmpty: true }) ?? false;
  });
  return took;
}

const frames: FrameRequestCallback[] = [];
function flushFrames(): void {
  act(() => {
    for (const cb of frames.splice(0)) cb(0);
  });
}

const responds = () => invocationsOf("thread.respond").map((i) => i.args);

beforeEach(() => {
  resetDaemon();
  refocus.mockClear();
  useCommandsStore.setState({ commands: [{ name: "thread.respond", title: "Answer Thread Request" } as never] });
  useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { permissionMode: "accept-edits" }) }, order: ["s-r1"] });
  // requestAnimationFrame focuses the deny reason and the Other field: flushFrames runs them.
  frames.length = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
  vi.restoreAllMocks();
  useThreadStore.setState({ logs: {}, answering: {} });
});

const prompt = () => screen.getByTestId("thread-permission");
const q = () => screen.getByTestId("thread-question");
const radios = () => within(q()).getAllByRole("radio");

describe("the permission prompt", () => {
  it("asks to run the command, gives the mode hint once (the CLI's reason says the same), adds the session rule and numbers its three buttons", () => {
    mount(world("permission"));
    expect(prompt().textContent).toContain("Allow Claude to run this command?");
    expect(prompt().textContent).toContain(PUSH);
    expect(prompt().textContent).toContain("Allow for session adds Bash(git push:*)");
    expect(screen.getByTestId("thread-permission-hint").textContent).toBe("Accept edits asks before commands");
    expect(screen.queryByTestId("thread-permission-why")).toBeNull();
    expect([...prompt().querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["1", "2", "3"]);
    expect(screen.getByTestId("thread-permission-allow")).toBeTruthy();
    expect(screen.getByTestId("thread-permission-allow-session")).toBeTruthy();
    expect(screen.getByTestId("thread-permission-deny")).toBeTruthy();
  });

  it("Deny opens the reason, focused; Enter denies with it and the prompt leaves", async () => {
    mount(world("permission"));
    fireEvent.click(screen.getByTestId("thread-permission-deny"));
    flushFrames();
    const reason = screen.getByTestId("thread-deny-reason");
    expect(document.activeElement).toBe(reason);
    fireEvent.change(reason, { target: { value: "Use the staging branch instead" } });
    fireEvent.submit(reason.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(responds()).toEqual([{ id: "s-r1", request: "req-push", decision: "deny", message: "Use the staging branch instead" }]);
    });
    expect(screen.queryByTestId("thread-permission")).toBeNull();
  });

  it("Allow answers at once: one thread.respond, the prompt gone before the daemon replies", async () => {
    let release: () => void = () => undefined;
    daemon.handlers.set("thread.respond", () => new Promise((r) => (release = () => { r({ message: "", resultJson: "" }); })));
    mount(world("permission"));
    fireEvent.click(screen.getByTestId("thread-permission-allow"));
    expect(screen.queryByTestId("thread-permission")).toBeNull();
    expect(responds()).toEqual([{ id: "s-r1", request: "req-push", decision: "allow" }]);
    expect(refocus).toHaveBeenCalled();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(screen.queryByTestId("thread-permission")).toBeNull();
  });

  it("an answer to a request Claude withdrew meanwhile: a plain notice, no error, the prompt stays gone", async () => {
    daemon.handlers.set("thread.respond", () => {
      throw refuse("no pending request req-push", Code.NotFound);
    });
    mount(world("permission"));
    fireEvent.click(screen.getByTestId("thread-permission-allow"));
    expect(await screen.findByText("Claude no longer needs that answer")).toBeTruthy();
    expect(screen.queryByText("Answer Thread Request failed")).toBeNull();
    expect(screen.queryByTestId("thread-permission")).toBeNull();
  });
});

describe("parallel requests", () => {
  it("stack oldest first; an Edit says what it changes and shows the change; each is answerable, the older by key from the editor", async () => {
    mount(world("parallel"));
    const stack = screen.getByTestId("thread-prompts");
    expect(stack.getAttribute("data-count")).toBe("2");
    const [edit, push] = within(stack).getAllByTestId("thread-permission");
    if (!edit || !push) throw new Error("two prompts");
    expect(edit.textContent).toContain("Allow Claude to edit internal/store/pr/poller.go?");
    expect(edit.textContent).toContain("Allow for session switches the thread to Accept edits.");
    expect(within(edit).getByTestId("thread-permission-hint").textContent).toBe("Accept edits asks for files outside the project");
    expect(push.textContent).toContain(PUSH);

    const diff = within(edit).getByTestId("thread-permission-diff");
    expect(diff.textContent).toContain("+1");
    fireEvent.click(within(diff).getByRole("button", { name: /Show the change/ }));
    // The diff itself renders in @pierre/diffs' shadow root (e2e reads its lines).
    expect(within(diff).getByTestId("thread-diff").querySelector("diffs-container")).not.toBeNull();
    expect(within(diff).getByRole("button", { name: /Hide the change/ })).toBeTruthy();

    // The newer one first, by click: the older stays.
    fireEvent.click(within(push).getByTestId("thread-permission-allow"));
    expect(screen.getByTestId("thread-prompts").getAttribute("data-count")).toBe("1");
    expect(responds()).toEqual([{ id: "s-r1", request: "req-push", decision: "allow" }]);
    // Then the older by its key from the editor.
    expect(editorKey("1")).toBe(true);
    await waitFor(() => {
      expect(responds()).toEqual([
        { id: "s-r1", request: "req-push", decision: "allow" },
        { id: "s-r1", request: "req-edit", decision: "allow" },
      ]);
    });
    expect(screen.queryByTestId("thread-prompts")).toBeNull();
  });
});

describe("a subagent's request", () => {
  it("names the agent that asked: its Agent call's type and description, not a bare subagent", async () => {
    mount(world("subagent"));
    expect(prompt().textContent).toContain("CHANGELOG.md");
    expect(screen.getByTestId("thread-asking-agent").textContent).toBe("general-purpose · Write the changelog entry");
    fireEvent.click(screen.getByTestId("thread-permission-allow"));
    expect(screen.queryByTestId("thread-permission")).toBeNull();
    await waitFor(() => {
      expect(responds()).toEqual([{ id: "s-r1", request: "req-sub", decision: "allow" }]);
    });
  });
});

describe("the question prompt", () => {
  it("docks with its pager: 2 questions, 1 of 2, three options and Other; Next goes to the second", () => {
    mount(world("question"));
    expect(q().textContent).toContain("Claude has 2 questions");
    expect(q().textContent).toContain("1 of 2");
    expect(radios()).toHaveLength(4);
    fireEvent.click(radios()[1] as HTMLElement);
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("thread-question-next"));
    expect(q().textContent).toContain("2 of 2");
    expect(q().textContent).toContain("Should I also update the PR description?");
  });

  it("single-select, then Other typed on the second page: Enter submits both answers", async () => {
    mount(world("question"));
    fireEvent.click(radios()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("thread-question-next"));
    expect(q().textContent).toContain("2 of 2");
    const other = within(q()).getByLabelText("Other answer");
    fireEvent.focus(other);
    fireEvent.change(other, { target: { value: "Only the title" } });
    expect(screen.getByTestId("thread-question-other").getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(other, { key: "Enter" });
    await waitFor(() => {
      expect(responds()).toHaveLength(1);
    });
    const sent = responds()[0];
    expect(sent).toMatchObject({ id: "s-r1", decision: "allow", request: "req-push-q" });
    expect(JSON.parse(sent?.answer ?? "{}")).toEqual({
      "The branch was rebased onto main, so a plain push will be rejected. How should I push?": "Force with lease (Recommended)",
      "Should I also update the PR description?": "Only the title",
    });
    expect(screen.queryByTestId("thread-question")).toBeNull();
  });

  it("a multi-select: checkboxes, two picks, Submit joins them", async () => {
    mount(world("multi"));
    const boxes = within(q()).getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[2] as HTMLElement);
    expect(within(q()).getAllByRole("checkbox")[0]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("thread-question-next"));
    await waitFor(() => {
      expect(responds()).toHaveLength(1);
    });
    expect(JSON.parse(responds()[0]?.answer ?? "{}")).toEqual({ "Which checks should I run before pushing?": "go test ./..., staticcheck" });
  });

  it("the editor's keys: Enter with nothing picked stays, a digit picks, Enter moves on, then submits", async () => {
    mount(world("question"));
    editorKey("Enter");
    expect(q().textContent).toContain("1 of 2");
    editorKey("2");
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
    editorKey("Enter");
    expect(q().textContent).toContain("2 of 2");
    editorKey("1");
    editorKey("Enter");
    await waitFor(() => {
      expect(responds()).toHaveLength(1);
    });
    expect(Object.values(JSON.parse(responds()[0]?.answer ?? "{}") as Record<string, string>)).toEqual(["Push to a new branch", "Yes"]);
  });

  it("Escape on the focused prompt skips it (a deny)", async () => {
    mount(world("question"));
    q().focus();
    expect(document.activeElement).toBe(q());
    fireEvent.keyDown(q(), { key: "Escape" });
    await waitFor(() => {
      expect(responds()).toEqual([{ id: "s-r1", request: "req-push-q", decision: "deny" }]);
    });
  });

  it("its page and picks survive the timeline streaming meanwhile", async () => {
    const w = world("question");
    mount(w);
    fireEvent.click(radios()[1] as HTMLElement);
    fireEvent.click(screen.getByTestId("thread-question-next"));
    expect(q().textContent).toContain("2 of 2");
    fireEvent.click(radios()[0] as HTMLElement);
    // A streamed reply grows item by item meanwhile (new log objects each time).
    const stream = { ...base, id: "s1", ordinal: 99, kind: "text" as const, streaming: true, text: "Meanwhile, the subagent " };
    for (const part of ["found ", "two ", "more ", "call sites."]) {
      stream.text += part;
      act(() => {
        publish({ items: [...w.items, { ...stream }], pending: w.pending });
      });
    }
    expect(useThreadStore.getState().logs["s-r1"]?.byId.s1).toMatchObject({ text: "Meanwhile, the subagent found two more call sites." });
    expect(q().textContent).toContain("2 of 2");
    expect(radios()[0]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("thread-question-back"));
    expect(radios()[1]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("thread-question-next"));
    fireEvent.click(screen.getByTestId("thread-question-next"));
    await waitFor(() => {
      expect(responds()).toHaveLength(1);
    });
    expect(Object.values(JSON.parse(responds()[0]?.answer ?? "{}") as Record<string, string>)).toEqual(["Push to a new branch", "Yes"]);
  });
});
