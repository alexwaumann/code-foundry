import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useThreadsStore } from "@/stores/threads";
import { TipWaiting } from "./TipWaiting";

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: id, state: "connected", status: "idle", statusReason: "at prompt", createdBy: "", archivedAtMs: null, ...o }) as ThreadView;

function setThreads(threads: ThreadView[]) {
  useThreadsStore.setState({ byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id) });
}

afterEach(cleanup);

describe("TipWaiting", () => {
  it("says how many child threads it waits on and names the ones working", () => {
    setThreads([
      thread("lead", { statusReason: "waiting on 2 child threads" }),
      thread("Store tag filtering", { createdBy: "lead", status: "busy" }),
      thread("CLI JSON output", { createdBy: "lead", status: "busy" }),
      thread("Docs", { createdBy: "lead", status: "attention", statusReason: "finished" }),
    ]);
    render(<TipWaiting id="lead" />);
    expect(screen.getByTestId("tip-waiting").textContent).toBe("Waiting on 2 child threadsStore tag filteringCLI JSON output");
    expect(screen.getAllByTestId("tip-waiting-name").map((e) => e.textContent)).toEqual(["Store tag filtering", "CLI JSON output"]);
  });

  it.each([
    ["waiting on 2 child threads and 1 subagent", "Waiting on 2 child threads and 1 subagent"],
    ["waiting on 1 child thread and 2 subagents and 1 shell", "Waiting on 1 child thread and 2 subagents and 1 shell"],
    ["waiting on 3 shells", "Waiting on 3 shells"],
    ["waiting", "Waiting on a wake"],
  ])("says the whole reason: %s", (reason, text) => {
    setThreads([thread("lead", { statusReason: reason })]);
    render(<TipWaiting id="lead" />);
    expect(screen.getByTestId("tip-waiting").textContent).toBe(text);
  });

  it("is nothing for a thread that is not waiting", () => {
    setThreads([thread("lead", { status: "attention", statusReason: "finished" }), thread("kid", { createdBy: "lead", status: "busy" })]);
    render(<TipWaiting id="lead" />);
    expect(screen.queryByTestId("tip-waiting")).toBeNull();
  });
});
