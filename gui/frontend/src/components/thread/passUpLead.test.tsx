import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadPendingView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { thread } = await import("@/test/projectsWorld");
const { useThreadsStore } = await import("@/stores/threads");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadActivity } = await import("./activity");
const { ComposerRow } = await import("./ComposerRow");
const { ThreadComposer } = await import("./ThreadComposer");
const { TimelineBridge } = await import("./timelineBridge");

/**
 * A lead's composer and the row above it with a question open, wired as ThreadPane wires them
 * (useThreadActivity into ComposerRow's working and ThreadComposer's busy), in the three cases
 * of docs/notes/pass-up-question.md: its own blocking question; a worker's question it passed
 * up while it works; the same while it is idle.
 */

const ID = "s-lead";
const passedUp: ThreadPendingView = { requestId: "pu-1", itemId: "q1", question: true, toolName: "AskUserQuestion", summary: "From Resize: Drag the body too?", fromThreadId: "s-w" };
const own: ThreadPendingView = { requestId: "r1", itemId: "q2", question: true, toolName: "AskUserQuestion", summary: "Which shortcut?" };

function Lead() {
  const a = useThreadActivity(ID);
  return (
    <TooltipProvider>
      <ComposerRow threadId={ID} working={a.working} bridge={new TimelineBridge()} />
      <ThreadComposer threadId={ID} pending={a.open} busy={a.busy} />
    </TooltipProvider>
  );
}

function setUp(pending: ThreadPendingView[], o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState({ byId: { [ID]: thread(ID, { state: "connected", status: "attention", backgroundShells: [], ...o }) }, order: [ID] });
    useThreadStore.setState({ pending: { [ID]: { threadId: ID, seq: 1, pending } }, logs: {}, synced: {}, watches: {} });
  });
}

beforeEach(() => {
  resetDaemon();
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
});

describe("a lead with a question open", () => {
  it("its own question blocks it: Interrupt, no Working", () => {
    setUp([own], { statusReason: "question: Which shortcut?" });
    render(<Lead />);
    expect(screen.getByTestId("thread-interrupt")).toBeTruthy();
    expect(screen.queryByTestId("pill-working")).toBeNull();
  });

  it("a passed-up question while it works: Interrupt and Working; Interrupt stops the lead", () => {
    setUp([passedUp], { statusReason: "question: From Resize: Drag the body too?", busyUnderPassUp: true });
    render(<Lead />);
    expect(screen.getByTestId("pill-working").textContent).toContain("Working");
    fireEvent.click(screen.getByTestId("thread-interrupt"));
    expect(invocationsOf("thread.interrupt").map((i) => i.args)).toEqual([{ id: ID }]);
  });

  it("a passed-up question while it is idle: neither", () => {
    setUp([passedUp], { statusReason: "question: From Resize: Drag the body too?" });
    render(<Lead />);
    expect(screen.queryByTestId("thread-interrupt")).toBeNull();
    expect(screen.queryByTestId("pill-working")).toBeNull();
  });
});
