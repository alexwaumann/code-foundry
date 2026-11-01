import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";

// The list is the thread timeline's virtualized one (Timeline.tsx); here every row renders.
vi.mock("@/components/thread/Timeline", () => ({
  TimelineList: ({ rows, renderRow }: { rows: { key: string; type: string }[]; renderRow: (r: never) => ReactNode }) => (
    <div data-testid="ember-list">
      {rows.map((r) => (
        <div key={r.key} data-row-type={r.type}>
          {renderRow(r as never)}
        </div>
      ))}
    </div>
  ),
}));
const { openFileInPanel } = vi.hoisted(() => ({ openFileInPanel: vi.fn<(target: string, file: object) => boolean>(() => true) }));
vi.mock("@/stores/filePanel", () => ({ openFileInPanel }));
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));

const { EmberTimeline } = await import("./EmberTimeline");
const { EmberRow } = await import("./EmberRow");
const { EmberPathPlace } = await import("./EmberPane");
const { ThreadContext } = await import("@/components/thread/context");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { seedWorld } = await import("@/test/projectsWorld");
const { EMBER_THREAD, EmberWorld, putEmberThread, setEmberEnabled } = await import("@/test/emberBoard");

/**
 * Ember's chat (EmberTimeline: lib/ember buildEmberRows drawn with the thread's rows) over
 * small conversations like the mock's (mock/emberChat.ts): only a turn's last text is the
 * reply, the rest folds into its "Worked for" row; paths in a reply; the line where a
 * restart cut Ember's turn. The row rules are lib/ember.test.ts's; the virtualized list,
 * the wheel and Show work's every run on screen are e2e (ember.spec.ts).
 */

const DIR = "/Users/dev/.code-foundry/ember";
const base = { parentToolUseId: "", createdAtMs: Date.now() - 60_000, updatedAtMs: Date.now() - 60_000, streaming: false };
const user = (id: string, text: string, o: Partial<Extract<ThreadItemView, { kind: "user" }>> = {}): ThreadItemView => ({ ...base, id, ordinal: 1, kind: "user", text, attachments: [], composerText: "", ...o });
const text = (id: string, t: string): ThreadItemView => ({ ...base, id, ordinal: 1, kind: "text", text: t });
const bash = (id: string, command: string): ThreadItemView => ({ ...base, id, ordinal: 1, kind: "tool", toolUseId: id, name: "Bash", inputJson: JSON.stringify({ command }), status: "done", output: "", isError: false, resultJson: "" });
const end = (id: string, o: object = {}): ThreadItemView => ({ ...base, id, ordinal: 1, kind: "turnEnd", subtype: "success", interrupted: false, durationMs: 5_000, ...o }) as unknown as ThreadItemView;

function setLog(items: ThreadItemView[]): void {
  act(() => {
    useThreadStore.setState((s) => ({ logs: { ...s.logs, [EMBER_THREAD]: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } }));
  });
}

function show() {
  return render(
    <ThreadContext.Provider value={{ threadId: EMBER_THREAD, cwd: DIR }}>
      <EmberPathPlace>
        <EmberTimeline threadId={EMBER_THREAD} working={false} bottomInset={0} />
      </EmberPathPlace>
    </ThreadContext.Provider>,
  );
}

const replies = () => [...document.querySelectorAll<HTMLElement>('[data-testid="thread-text"][data-final]')];
const texts = () => [...document.querySelectorAll<HTMLElement>('[data-testid="thread-text"]')];

beforeEach(() => {
  seedWorld();
  setEmberEnabled(true);
  const { byId, order } = useThreadsStore.getState();
  putEmberThread({}, order.map((id) => byId[id] as ThreadView));
  useUiStore.setState({ emberShowWork: false });
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});
afterEach(() => {
  cleanup();
  openFileInPanel.mockClear();
});

describe("EmberTimeline", () => {
  it("only a turn's last text is the reply (Copy answer, task links as pointer lines); text between tool calls folds into the run and opens with it", () => {
    setLog([
      user("u1", "Validate the notes API input, and the same for thread read."),
      text("t1", "Two pieces, both can start now."),
      bash("b1", "code-foundry ember task start --title 'Validate notes API input'"),
      text("t2", "On it. Two pieces:\n\n[Validate notes API input](cf-task://t-1a2b3c4d)\n[Same for thread read](cf-task://t-00ff00ff)"),
      end("e1"),
    ]);
    show();
    expect(replies().map((r) => r.textContent.includes("On it. Two pieces"))).toEqual([true]);
    expect(texts().some((t) => t.textContent.includes("both can start now"))).toBe(false);
    const reply = replies()[0] as HTMLElement;
    expect(within(reply).getAllByTestId("ember-task-link")).toHaveLength(2);
    expect(within(reply).getByTestId("thread-copy-answer")).toBeTruthy();
    // Its run opens to it, among the tool rows, not as a reply (no Copy answer).
    const work = screen.getAllByTestId("ember-work");
    expect(work).toHaveLength(1);
    fireEvent.click(within(work[0] as HTMLElement).getByRole("button"));
    expect(screen.getByTestId("ember-work").getAttribute("data-expanded")).toBe("true");
    const note = texts().find((t) => t.textContent.includes("both can start now"));
    expect(note).toBeDefined();
    expect(note?.hasAttribute("data-final")).toBe(false);
    expect(note && within(note).queryByTestId("thread-copy-answer")).toBeNull();
  });

  it("paths in a reply: an absolute one under a project is a chip that opens the File tab; relative ones and git ranges stay code", () => {
    setLog([user("u1", "How is the notes API going?"), text("t1", "The notes API team is under way: `/Users/dev/src/code-foundry/README.md`, `README.md` and `main..cf/notes-validation`."), end("e1")]);
    show();
    const reply = replies()[0] as HTMLElement;
    const chips = within(reply).getAllByTestId("path-chip");
    expect(chips).toHaveLength(1);
    expect(within(reply).getAllByTestId("path-plain").map((e) => e.textContent)).toEqual(["README.md"]);
    expect([...reply.querySelectorAll("code")].some((c) => c.textContent === "main..cf/notes-validation")).toBe(true);
    fireEvent.click(chips[0] as HTMLElement);
    expect(openFileInPanel).toHaveBeenCalledWith("current", expect.objectContaining({ path: "/Users/dev/src/code-foundry/README.md" }));
  });

  it("a restart that cut Ember's turn: a line after the cut run, Interrupted on the row; the line stays once Ember picks up again", () => {
    const cut = [user("u1", "Add release notes for 0.20."), bash("b1", "code-foundry ember task start --title 'Release notes'"), end("e1", { subtype: "process_ended", interrupted: true, createdAtMs: Date.now() - 30_000 })];
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, [EMBER_THREAD]: { ...(s.byId[EMBER_THREAD] as ThreadView), status: "error", statusReason: "interrupted" } } }));
    });
    new EmberWorld().publish();
    setLog(cut);
    show();
    render(<EmberRow />);
    const line = () => screen.getAllByTestId("ember-restart");
    expect(line()).toHaveLength(1);
    expect(line()[0]?.textContent).toMatch(/^Code Foundry restarted at \S.* while Ember was working$/);
    const rows = [...screen.getByTestId("ember-list").children].map((r) => r.getAttribute("data-row-type"));
    expect(rows).toEqual(["user", "work", "restart"]);
    expect(screen.getByTestId("ember-row-status").textContent).toBe("Interrupted");
    expect(screen.getByTestId("ember-row-status").className).toContain("text-cf-warning-text");

    // The restart notice wakes Ember; it picks the request up; the line stays where the cut was.
    const restarted = new Date(Date.now() - 20_000).toISOString();
    const wake = { title: "The app restarted.", json: JSON.stringify({ kind: "batch", wakes: [{ kind: "restart", restarted_at: restarted, own_turn_interrupted: true }] }) };
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, [EMBER_THREAD]: { ...(s.byId[EMBER_THREAD] as ThreadView), status: "busy", statusReason: "" } } }));
    });
    setLog([...cut, user("w1", "[code-foundry wake] The app restarted.", { wake }), bash("b2", "code-foundry ember task start --title 'Release notes'"), end("e2")]);
    expect(screen.getByTestId("ember-row-status").textContent).not.toBe("Interrupted");
    expect(line()).toHaveLength(1);
    expect([...screen.getByTestId("ember-list").children].map((r) => r.getAttribute("data-row-type"))).toEqual(["user", "work", "restart", "work"]);
  });
});
