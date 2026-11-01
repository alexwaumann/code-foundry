import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { forgetTurnView, useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { thread } from "@/test/projectsWorld";
import { ANSWER, ANSWER_STREAMING, CF, fixStalePrBadge, publishThread, rowsOf, type TurnEnd } from "@/test/threadWorld";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

vi.mock("@/stores/filePanel", () => ({ openFileInPanel: () => true }));
// The first message's image, as the daemon serves it.
vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), readAttachment: () => Promise.resolve({ data: new Uint8Array([1]), mimeType: "image/png" }) }));

/**
 * The timeline's rows over the mock's scripted s-r1 "Fix stale PR badge" (src/test/threadWorld.ts,
 * a copy of mock/thread.ts), every row mounted: the virtual list's scroll, wheel and pinning,
 * @pierre/diffs' shadow root, the caret and computed colours are e2e/thread.spec.ts's.
 */

/** The rows as Timeline builds them, folds read from the store (the header's button sets them). */
function Rows({ items, working }: { items: readonly ThreadItemView[]; working: boolean }) {
  const folds = useThreadStore((s) => s.folds["s-r1"]);
  const rows = rowsOf(items, { working, fold: (k) => folds?.[k] });
  return (
    <ThreadContext.Provider value={{ threadId: "s-r1", cwd: CF }}>
      <div data-testid="thread-pane">
        {rows.map((r) => (
          <div key={r.key} data-row-type={r.type}>
            <TimelineRowView row={r} />
          </div>
        ))}
      </div>
    </ThreadContext.Provider>
  );
}

function mount(items: ThreadItemView[], working: boolean, pending: Parameters<typeof publishThread>[1]["pending"] = []) {
  publishThread("s-r1", { items, pending });
  const view = render(<Rows items={items} working={working} />);
  return {
    ...view,
    update: (next: ThreadItemView[], nextWorking: boolean) => {
      act(() => {
        publishThread("s-r1", { items: next, pending: [] });
      });
      view.rerender(<Rows items={next} working={nextWorking} />);
    },
  };
}

const pane = () => screen.getByTestId("thread-pane");
const headers = () => [...pane().querySelectorAll<HTMLElement>('[data-testid="thread-turn-header"]:not([data-live])')];
const tools = (name: string) => [...pane().querySelectorAll<HTMLElement>(`[data-tool="${name}"]`)];
const finals = () => [...pane().querySelectorAll<HTMLElement>('[data-testid="thread-text"][data-final]')];

let clipboard: string[] = [];
beforeEach(() => {
  clipboard = [];
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => (clipboard.push(t), Promise.resolve()) }, configurable: true });
  useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { state: "connected", status: "attention", model: "claude-opus-4-8" }) }, order: ["s-r1"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadStore.setState({ logs: {}, folds: {}, expanded: {} });
});

describe("a thread waiting on a permission (s-r1, permission)", () => {
  it("the first message's tags from its composer text; a lone /tmp in the prose stays text", async () => {
    URL.createObjectURL = () => "blob:x";
    mount(fixStalePrBadge("permission").items, false);
    const bubble = screen.getAllByTestId("thread-user")[0] as HTMLElement;
    expect(bubble.querySelector('[data-tag-kind="image"]')?.textContent).toContain("pr-badge-stale.png");
    await vi.waitFor(() => {
      expect(bubble.querySelector('[data-tag-kind="image"] img')?.getAttribute("src")).toBe("blob:x");
    });
    expect(bubble.querySelector('[data-tag-kind="file"]')?.textContent).toBe("poller.go");
    expect(bubble.querySelector('[data-tag-kind="skill"]')?.textContent).toBe("/tdd");
    expect(bubble.textContent).toContain("with /tdd. Keep the fingerprint check-count based in /tmp.");
  });

  it("turn 1 is folded to its message, header and texts; the latest is open, its tool waiting for you", () => {
    mount(fixStalePrBadge("permission").items, false);
    expect(headers()).toHaveLength(1);
    const first = headers()[0] as HTMLElement;
    expect(first.getAttribute("data-folded")).toBe("true");
    expect(first.textContent).toContain("Worked for 4m 08s");
    expect(first.textContent).toContain("9 steps");
    expect(screen.queryAllByTestId("thread-group")).toHaveLength(0);
    expect(finals()[0]?.textContent).toContain("Fixed: stale badge after a force-push");
    expect(tools("Bash")[0]?.textContent).toContain("go test ./...");
    const waiting = pane().querySelector<HTMLElement>('[data-waiting="true"]');
    expect(waiting?.textContent).toContain(`Run git push --force-with-lease origin cf/pr-badge-stale`);
    expect(waiting?.querySelector('[data-testid="thread-waiting"]')?.textContent).toBe("waiting for you");
  });

  it("unfolded, turn 1's work: explore groups, thinking, the question asked, the Write and the failing run; a group opens to its members, a Grep to its matches, the run to its failure", () => {
    mount(fixStalePrBadge("permission").items, false);
    const first = headers()[0] as HTMLElement;
    fireEvent.click(first.querySelector("button.fold") as HTMLElement);
    expect(headers()[0]?.hasAttribute("data-folded")).toBe(false);
    const groups = () => screen.getAllByTestId("thread-group");
    expect(groups()[0]?.textContent).toContain("Read 3 files, searched code 2 times");
    expect(groups()[1]?.textContent).toContain("Read 2 files, searched code once");
    expect(screen.getAllByTestId("thread-thinking")[0]?.textContent).toContain("Thought for 9s");
    expect(screen.getByTestId("thread-question-row").textContent).toContain("Head SHA in the fingerprint");
    expect(tools("Write")[0]?.textContent).toContain("Created fingerprint_test.go");
    expect(tools("Bash")[0]?.textContent).toContain("exit 1");

    fireEvent.click(groups()[1] as HTMLElement);
    fireEvent.click(within(tools("Grep")[0] as HTMLElement).getByTestId("thread-tool"));
    const matches = screen.getByTestId("thread-matches");
    expect(matches.textContent).toContain("internal/store/pr/model.go");
    expect(matches.querySelector("mark")?.textContent).toMatch(/HeadRefOid/i);

    fireEvent.click(within(tools("Bash")[0] as HTMLElement).getByTestId("thread-tool"));
    expect(screen.getAllByTestId("thread-bash")[0]?.textContent).toContain("--- FAIL: TestFingerprintChangesOnForcePush");
  });

  it("the Edit: +6, an inline diff; Copy diff copies it and says Copied for a moment", async () => {
    mount(fixStalePrBadge("permission").items, false);
    fireEvent.click(headers()[0]?.querySelector("button.fold") as HTMLElement);
    const edit = tools("Edit")[0] as HTMLElement;
    expect(edit.textContent).toContain("+6");
    fireEvent.click(within(edit).getByTestId("thread-tool"));
    const diff = within(edit).getByTestId("thread-diff");
    // Its lines render in @pierre/diffs' shadow root (e2e/thread.spec.ts counts them).
    expect(diff.querySelector("diffs-container")).not.toBeNull();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const copy = within(diff).getByTestId("thread-diff-copy");
    expect(copy.getAttribute("aria-label")).toBe("Copy diff");
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(copy.getAttribute("aria-label")).toBe("Copied");
    expect(clipboard.at(-1)).toContain("HeadRefOid");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copy.getAttribute("aria-label")).toBe("Copy diff");
  });

  it("the subagent is one line; open, only its report: its own rows stay out of the thread", () => {
    mount(fixStalePrBadge("permission").items, false);
    fireEvent.click(headers()[0]?.querySelector("button.fold") as HTMLElement);
    const agent = tools("Agent")[0] as HTMLElement;
    expect(agent.textContent).toContain("Review the fingerprint change");
    expect(agent.textContent).toContain("4 tools · 41s");
    const row = within(agent).getAllByTestId("thread-tool")[0] as HTMLElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(within(agent).getByTestId("thread-agent-report").textContent).toContain("Looks right.");
    expect(agent.querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(agent.textContent).not.toContain("Read 2 files, searched code once");
    expect(pane().textContent).not.toContain("go vet ./internal/store/pr/...");
  });

  it("the answer's markdown: a GFM table, Go highlighted; the header folds the turn again", () => {
    mount(fixStalePrBadge("permission").items, false);
    const header = () => headers()[0] as HTMLElement;
    fireEvent.click(header().querySelector("button.fold") as HTMLElement);
    const answer = finals()[0] as HTMLElement;
    expect(answer.querySelectorAll("table tr")).toHaveLength(4);
    expect(answer.querySelector(".cf-table th")).not.toBeNull();
    expect(answer.querySelector('pre[data-lang="go"] .hljs-keyword')?.textContent).toBe("func");
    fireEvent.click(header().querySelector("button.fold") as HTMLElement);
    expect(header().getAttribute("data-folded")).toBe("true");
    expect(tools("Edit")).toHaveLength(0);
  });
});

describe("a pending question (s-r1, question)", () => {
  it("the timeline's row says Claude asks two questions", () => {
    const w = fixStalePrBadge("question");
    mount(w.items, false, w.pending);
    const rows = screen.getAllByTestId("thread-question-row");
    expect(rows.at(-1)?.textContent).toContain("Asking 2 questions");
  });
});

describe("headers (s-r1, idle)", () => {
  it("the daemon's turn cost and model; a turn without them shows neither", () => {
    mount(fixStalePrBadge("idle").items, false);
    // Turn 2's own cost ($1.50, not the totals' $0.38 difference) and the model that answered.
    expect(headers().at(-1)?.textContent).toMatch(/·\$1\.50·Sonnet 5$/);
    // Turn 1 has neither: no guess from the running total, no model from the thread's current one.
    const first = headers()[0] as HTMLElement;
    expect(first.textContent).toMatch(/steps$/);
    expect(first.textContent).not.toContain("$");
    expect(first.textContent).not.toContain("Opus");
  });
});

describe("streaming (s-r1, streaming)", () => {
  const finish = (items: ThreadItemView[]): ThreadItemView[] => {
    const at = items.length;
    const last = items[at - 1];
    if (last?.kind !== "text") throw new Error("not streaming");
    const end: TurnEnd = { ...(last as object), id: "end", ordinal: last.ordinal + 1, kind: "turnEnd", subtype: "success", isError: false, interrupted: false, stopReason: "end_turn", terminalReason: "", durationMs: 30_000, numTurns: 9, costUsd: 1.16, turnCostUsd: 0.04, model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, errors: [] } as TurnEnd;
    return [...items.slice(0, -1), { ...last, text: ANSWER, streaming: false }, end];
  };

  it("the answer grows under the live header, which heads the turn's work; the turn's end turns it into the folded finished one in place, the answer copyable", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const items = fixStalePrBadge("streaming").items;
    const view = mount(items, true);
    const streaming = pane().querySelector('[data-testid="thread-text"][data-streaming]');
    expect(streaming?.textContent).toContain("ReviewState: pr.Revi");
    expect(ANSWER_STREAMING.endsWith("pr.Revi")).toBe(true);
    const live = pane().querySelector<HTMLElement>('[data-testid="thread-turn-header"][data-live]');
    expect(live?.querySelector('[data-testid="thread-working"]')?.textContent).toMatch(/^Working·\d+ steps·\d/);
    expect(headers()).toHaveLength(0);
    // Under its message, above the rows.
    expect(live?.closest("[data-row-type]")?.previousElementSibling?.getAttribute("data-row-type")).toBe("user");

    view.update(finish(items), false);
    expect(pane().querySelector('[data-testid="thread-text"][data-streaming]')).toBeNull();
    expect(screen.queryByTestId("thread-working")).toBeNull();
    expect(headers()).toHaveLength(1);
    // The same element: the line changed in place, nothing remounted.
    expect(headers()[0]).toBe(live);
    expect(live?.getAttribute("data-folded")).toBe("true");
    expect(live?.textContent).toMatch(/·9 steps·\$0\.04·Opus 4\.8$/);
    const answer = finals().at(-1) as HTMLElement;
    expect(answer.textContent).toContain("I have not pushed.");
    expect(within(live as HTMLElement).queryByRole("button", { name: "Copy answer" })).toBeNull();
    expect(within(answer).getByRole("button", { name: "Copy answer" })).toBeTruthy();
  });
});

describe("leaving a thread", () => {
  it("forgets how it was folded: back on it, every finished turn is folded and the rows the reader opened are closed", () => {
    const items = fixStalePrBadge("idle").items;
    const view = mount(items, false);
    fireEvent.click(headers()[0]?.querySelector("button.fold") as HTMLElement);
    const editRow = () => within(tools("Edit")[0] as HTMLElement).getByTestId("thread-tool");
    fireEvent.click(editRow());
    expect(editRow().getAttribute("aria-expanded")).toBe("true");
    // Another thread shown (ThreadPane's WatchedThread forgets the view), then this one again.
    view.unmount();
    act(() => {
      forgetTurnView("s-r1");
    });
    mount(items, false);
    expect(headers().every((h) => h.getAttribute("data-folded") === "true")).toBe(true);
    expect(tools("Edit")).toHaveLength(0);
    fireEvent.click(headers()[0]?.querySelector("button.fold") as HTMLElement);
    expect(editRow().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a claude that did not start (s-r1, crashed)", () => {
  const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
  const crashed: ThreadItemView[] = [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "The PR badge in the sidebar stays green after a force-push", attachments: [], composerText: "" },
    { ...base, id: "x", ordinal: 2, kind: "error", text: "Claude did not start: exit code 1: error: unknown option '--bogus'" },
    { ...base, id: "turn-synth-u", ordinal: 3, kind: "turnEnd", subtype: "process_ended", isError: false, interrupted: true, stopReason: "", terminalReason: "", durationMs: 1000, numTurns: 0, costUsd: 0, turnCostUsd: null, model: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, errors: [] },
  ];

  it("its error is a row in the timeline; the next message's turn shows the live header while Claude starts, no starting word, the error kept above", () => {
    const view = mount(crashed, false);
    expect(screen.getByTestId("thread-error").textContent).toBe("Claude did not start: exit code 1: error: unknown option '--bogus'");
    view.update([...crashed, { ...base, id: "u2", ordinal: 4, kind: "user", text: "Try again", attachments: [], composerText: "" }], true);
    expect(screen.getByTestId("thread-working").textContent).toContain("Working");
    expect(pane().textContent).not.toMatch(/Starting Claude|starting…/);
    expect(screen.getByTestId("thread-error")).toBeTruthy();
  });
});
