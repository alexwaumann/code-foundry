import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { tooltipText } from "@/test/tooltip";

const runCommand = vi.hoisted(() => vi.fn<(...a: unknown[]) => Promise<boolean>>(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));
const { buildRows, buildTurns, decodeTimelineKey, timelineKey } = await import("@/lib/threadTimeline");
const { structOf, useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { ThreadContext } = await import("./context");
const { TimelineRowView } = await import("./rows");
const { createTurnActivity, TurnActivityContext } = await import("./turnActivity");

afterEach(() => {
  cleanup();
  runCommand.mockReset();
  runCommand.mockImplementation(() => Promise.resolve(true));
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const msg = (id: string, ordinal: number): ThreadItemView => ({ ...base, id, ordinal, kind: "user", text: "go", attachments: [], composerText: "" });
const say = (id: string, ordinal: number, text: string): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text });
function ended(id: string, ordinal: number, over: Partial<Extract<ThreadItemView, { kind: "turnEnd" }>> = {}): ThreadItemView {
  return {
    ...base,
    id,
    ordinal,
    kind: "turnEnd",
    subtype: "success",
    isError: false,
    interrupted: false,
    stopReason: "",
    terminalReason: "",
    durationMs: 2100,
    numTurns: 1,
    costUsd: 0.001,
    turnCostUsd: 0.001,
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: [],
    ...over,
  };
}

/** Two finished turns: e1 (older), e2 (latest). */
const twoTurns = [msg("u1", 1), say("a1", 2, "first"), ended("e1", 3), msg("u2", 4), say("a2", 5, "second"), ended("e2", 6)];

function setThread(o: Partial<ThreadView> = {}): void {
  useThreadsStore.setState({ byId: { s: { id: "s", name: "T", projectId: "", worktreePath: "/w", workspaceId: "", projectIds: [], checkoutPaths: [], ...o } as ThreadView }, order: ["s"] });
}

function show(items: ThreadItemView[], opts: { working?: boolean; activity?: ReturnType<typeof createTurnActivity> } = {}) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: opts.working ?? false });
  return render(
    <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
      <TurnActivityContext.Provider value={opts.activity ?? null}>
        {rows.map((r) => (
          <TimelineRowView key={r.key} row={r} />
        ))}
      </TurnActivityContext.Provider>
    </ThreadContext.Provider>,
  ).container;
}

const gutters = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-testid="thread-turn-gutter"]')];
const forkIn = (g: HTMLElement | undefined) => g?.querySelector<HTMLButtonElement>('[data-testid="thread-fork-here"]') ?? null;

describe("Fork from here in a turn's gutter", () => {
  it("sits right after Copy, before the info, on every finished turn", () => {
    setThread();
    const c = show(twoTurns);
    for (const g of gutters(c)) {
      const kids = [...(g.querySelector(".in")?.children ?? [])];
      expect(kids.map((k) => k.getAttribute("data-testid") ?? k.className)).toEqual(["thread-copy-reply", "thread-fork-here", "info"]);
      expect(forkIn(g)?.getAttribute("aria-label")).toBe("Fork from here");
      expect(forkIn(g)?.querySelector("svg")).not.toBeNull();
    }
  });

  it.each([
    ["interrupted", { subtype: "error_during_execution", isError: true, interrupted: true }],
    ["failed", { subtype: "error_max_turns", isError: true }],
  ])("shows on an %s turn too, even one with no reply to copy", (_, over) => {
    setThread();
    const c = show([msg("u1", 1), ended("e1", 2, over)]);
    const g = gutters(c)[0];
    expect(g?.querySelector('[data-testid="thread-copy-reply"]')).toBeNull();
    expect(forkIn(g)).not.toBeNull();
  });

  it("not on a running turn: it has no gutter", () => {
    setThread();
    const c = show([...twoTurns, msg("u3", 7), say("a3", 8, "working")], { working: true });
    expect(gutters(c)).toHaveLength(2);
    expect(c.querySelectorAll('[data-testid="thread-fork-here"]')).toHaveLength(2);
  });

  it("names itself in a tooltip (icon only)", () => {
    setThread();
    const c = show(twoTurns);
    const btn = forkIn(gutters(c)[1]);
    if (!btn) throw new Error("no button");
    expect(tooltipText(btn)).toBe("Fork from here");
  });

  it("runs thread.fork with at set to that turn's turn end, in the thread's context, like the menu's Fork", () => {
    setThread();
    const c = show(twoTurns);
    fireEvent.click(forkIn(gutters(c)[0]) as HTMLButtonElement);
    expect(runCommand).toHaveBeenLastCalledWith("thread.fork", { at: "e1" }, expect.objectContaining({ activeThreadId: "s" }), { inView: true });
    fireEvent.click(forkIn(gutters(c)[1]) as HTMLButtonElement);
    expect(runCommand).toHaveBeenLastCalledWith("thread.fork", { at: "e2" }, expect.objectContaining({ activeThreadId: "s" }), { inView: true });
  });

  it("is held while the fork runs: no second fork, and an older turn's gutter keeps showing", async () => {
    setThread();
    let finish: (ok: boolean) => void = () => undefined;
    runCommand.mockImplementation(() => new Promise<boolean>((r) => (finish = r)));
    const activity = createTurnActivity();
    const c = show(twoTurns, { activity });
    act(() => {
      activity.setHovered("u1");
    });
    const btn = forkIn(gutters(c)[0]) as HTMLButtonElement;
    fireEvent.click(btn);
    act(() => {
      activity.setHovered("");
    });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(btn.hasAttribute("data-held")).toBe(true);
    expect(gutters(c)[0]?.hasAttribute("data-shown")).toBe(true);
    fireEvent.click(btn);
    expect(runCommand).toHaveBeenCalledTimes(1);
    // A refusal (runCommand toasts it and answers false) lets go the same way.
    await act(async () => {
      finish(false);
      await Promise.resolve();
    });
    expect(btn.hasAttribute("aria-disabled")).toBe(false);
    expect(gutters(c)[0]?.hasAttribute("data-shown")).toBe(false);
    fireEvent.click(btn);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("disabled, saying why, once Claude Code deleted the transcript (as the menu's Fork)", () => {
    setThread({ transcriptMissing: true });
    const c = show(twoTurns);
    const btn = forkIn(gutters(c)[1]) as HTMLButtonElement;
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(btn);
    expect(runCommand).not.toHaveBeenCalled();
    expect(tooltipText(btn)).toBe("Fork from here: the transcript was deleted");
  });

  it("none for a thread whose setup did not finish (the menu leaves Fork out)", () => {
    setThread({ setup: { phase: "failed" } as ThreadView["setup"] });
    const c = show(twoTurns);
    expect(gutters(c)).toHaveLength(2);
    expect(c.querySelector('[data-testid="thread-fork-here"]')).toBeNull();
  });
});
