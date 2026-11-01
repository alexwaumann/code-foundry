import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { LineageGroup } from "./LineageGroup";

/**
 * The card's "Lineage · N running" (docs/notes/sidebar-live-count.md): N is the sidebar
 * badge's live count (lib/liveCount.test.ts), background subagents plus live child threads,
 * hidden ones included; a waiting child is a live (working) row, a finished one is not.
 */

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: id, state: "connected", status: "idle", statusReason: "", createdBy: "", archivedAtMs: null, snoozedUntilMs: null, flags: [], backgroundAgentsRunning: 0, createdAtMs: null, ...o }) as unknown as ThreadView;

function put(threads: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id) });
}

function set(id: string, o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), ...o } } }));
  });
}

const label = () => screen.getByTestId("ti-lineage-label").textContent;
const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="ti-lineage-row"][data-id="${id}"]`);

beforeEach(() => {
  useThreadStore.setState({ logs: {} });
});
afterEach(cleanup);

describe("LineageGroup's label", () => {
  it("counts the subagent and the live children; a nested lead waiting on its worker is a working row; a finished child is not live", () => {
    put([
      thread("lead", { statusReason: "waiting on 2 child threads and 1 subagent", backgroundAgentsRunning: 1 }),
      thread("row", { name: "Inbox row layout", createdBy: "lead", status: "busy" }),
      thread("nested", { name: "Rewrite the row tests", createdBy: "lead", statusReason: "waiting on 1 child thread" }),
      thread("done", { createdBy: "lead", status: "attention", statusReason: "finished" }),
      thread("snap", { createdBy: "nested", status: "busy" }),
    ]);
    render(<LineageGroup threadId="lead" />);
    expect(label()).toBe("Lineage · 3 running");
    expect(row("nested")?.dataset.state).toBe("working");
    expect(row("row")?.dataset.state).toBe("working");
    // Finished: folded under Previous agents.
    expect(row("done")).toBeNull();
    set("row", { status: "attention", statusReason: "finished" });
    expect(label()).toBe("Lineage · 2 running");
  });

  it("a thread with no subagents: the word alone once nothing is live", () => {
    put([thread("lead"), thread("nested", { createdBy: "lead", statusReason: "waiting on 1 child thread" }), thread("snap", { createdBy: "nested", status: "busy" })]);
    render(<LineageGroup threadId="nested" />);
    expect(label()).toBe("Lineage · 1 running");
    set("snap", { status: "attention", statusReason: "finished" });
    expect(label()).toBe("Lineage");
  });

  it("hidden children count: one working, one asking; a waiting one stays live", () => {
    put([
      thread("parent"),
      thread("e2e", { createdBy: "parent", status: "busy" }),
      thread("cookie", { createdBy: "parent", status: "attention", statusReason: "permission: Bash rm -rf cookies" }),
      thread("old", { createdBy: "parent", status: "attention", statusReason: "error: overloaded" }),
      thread("gone", { createdBy: "parent", status: "busy", archivedAtMs: 1 }),
    ]);
    render(<LineageGroup threadId="parent" />);
    expect(label()).toBe("Lineage · 2 running");
    set("e2e", { status: "idle", statusReason: "waiting on 1 child thread" });
    expect(row("e2e")?.dataset.state).toBe("working");
    expect(label()).toBe("Lineage · 2 running");
    set("cookie", { status: "attention", statusReason: "finished" });
    expect(label()).toBe("Lineage · 1 running");
  });
});
