import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRunFinishedView, ActionRunOutputView } from "@/api/actions";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const runs = vi.hoisted(() => new Map<string, ActionRunOutputView>());
vi.mock("@/api/actions", async (orig) => ({ ...(await orig<typeof import("@/api/actions")>()), getActionRun: (runId: string) => Promise.resolve(runs.get(runId) ?? null) }));
vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const { ActionRunDialog } = await import("./ActionRunDialog");
const { BottomPanel } = await import("@/components/bottom/BottomPanel");
const { Toaster } = await import("@/components/ui/sonner");
const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { attach } = await import("@/test/terminalHost");
const { ACTION_IDS, actionRun, fakeActionCommands, seedActions } = await import("@/test/actionsWorld");
const { CF, GP, seedWorld } = await import("@/test/projectsWorld");
const { dispatchEvent } = await import("@/stores/events");
const { useActionDialogStore } = await import("@/stores/actionDialog");
const { useActionsStore } = await import("@/stores/actions");
const { useBottomStore } = await import("@/stores/bottomPanel");
const { useUiStore } = await import("@/stores/ui");

/**
 * A failed worktree-create run (docs/notes/actions-2-gui.md): its toast from the action
 * source's run_finished (stores/events.ts), Open selecting the thread and showing the run's
 * captured output (ActionRunDialog), and Run in terminal running it again as a tab.
 * e2e/actions.spec.ts keeps the dialog's meta line at a 360px window (one line, the path
 * giving way in the middle).
 */

const toasts = () => [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
const toastOf = (text: string) => toasts().find((t) => t.textContent.includes(text));

function finished(o: Partial<ActionRunFinishedView>): ActionRunFinishedView {
  return { runId: "r-setup", actionId: ACTION_IDS.install, actionName: "Install deps", projectId: "repo-cf", threadId: "s-1", exitCode: 1, mode: "background", trigger: "worktree-create", terminalId: "", ...o };
}

function runFinished(f: ActionRunFinishedView) {
  act(() => {
    dispatchEvent({ source: "action", event: { kind: "runFinished", finished: f } });
  });
}

async function settle(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  resetDaemon();
  attach.reset();
  runs.clear();
  seedWorld();
  seedActions();
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
  useActionDialogStore.setState({ editor: null, runId: null, seq: 0 });
  const install = useActionsStore.getState().byId[ACTION_IDS.install];
  if (!install) throw new Error("no Install deps");
  const owner = { threadId: "s-1", projectId: "repo-cf", worktree: CF };
  runs.set("r-setup", {
    run: actionRun("r-setup", install, owner, "", { mode: "background", trigger: "worktree-create", running: false, exitCode: 1, startedAtMs: 1_000, finishedAtMs: 2_200 }),
    output: "npm ERR! missing script: install\n",
    truncated: false,
  });
  act(() => {
    useUiStore.getState().select({ kind: "thread", id: "s-2" });
  });
  render(
    <>
      <ActionRunDialog />
      <BottomPanel columnHeight={800} />
      <Toaster />
    </>,
  );
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
});

describe("a failed worktree-create run", () => {
  it("toasts; Open selects its thread and shows the run's output; Run in terminal runs it again as the thread's tab", async () => {
    fakeActionCommands((threadId) => (threadId === "s-2" ? { projectId: "repo-gp", worktree: GP } : { projectId: "repo-cf", worktree: CF }));
    runFinished(finished({}));
    await waitFor(() => {
      expect(toastOf("Setup action Install deps failed (exit 1)")).toBeDefined();
    });
    fireEvent.click(within(toastOf("Setup action Install deps failed (exit 1)") as HTMLElement).getByRole("button", { name: "Open" }));
    await settle();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    const out = screen.getByTestId("action-run-dialog");
    expect(within(out).getByRole("heading").textContent).toBe("Setup action Install deps failed");
    const meta = within(out).getByTestId("action-run-meta");
    expect(meta.textContent).toContain("Exited with code 1");
    expect(meta.textContent).toContain("1.2s");
    // The path's last folder (the worktree's) is its own span, so it stays whole when the line narrows.
    const parts = [...within(out).getByTestId("action-run-path").querySelectorAll("span")].map((s) => s.textContent);
    expect(parts).toEqual(["~/src/", "code-foundry"]);
    expect(within(out).getByTestId("action-run-output").textContent).toBe("npm ERR! missing script: install\n");

    fireEvent.click(within(out).getByTestId("action-run-again"));
    await settle();
    expect(screen.queryByTestId("action-run-dialog")).toBeNull();
    expect(invocationsOf("action.run").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ action: ACTION_IDS.install, terminal: "true" }, "s-1"]]);
    expect([...screen.getByTestId("bottom-panel").querySelectorAll('[data-kind="action"]')].map((e) => e.textContent)).toEqual(["Install deps"]);
  });

  it("a passing setup run stays quiet; a failure's toast stays until its × closes it", async () => {
    runFinished(finished({ runId: "r-ok", exitCode: 0 }));
    runFinished(finished({ runId: "r-build", actionId: ACTION_IDS.build, actionName: "Build", exitCode: 2 }));
    await waitFor(() => {
      expect(toastOf("Setup action Build failed (exit 2)")).toBeDefined();
    });
    expect(toasts().filter((t) => t.textContent.includes("(exit 0)"))).toHaveLength(0);
    expect(toasts()).toHaveLength(1);
    fireEvent.click(within(toastOf("Setup action Build failed (exit 2)") as HTMLElement).getByRole("button", { name: "Close toast" }));
    await waitFor(() => {
      expect(toastOf("Setup action Build failed (exit 2)")).toBeUndefined();
    });
  });

  it("a user's failed run (its tab shows it) does not toast", async () => {
    runFinished(finished({ runId: "r-user", actionId: ACTION_IDS.test, actionName: "Test", trigger: "user", mode: "terminal", terminalId: "t-run" }));
    runFinished(finished({ runId: "r-build", actionId: ACTION_IDS.build, actionName: "Build", exitCode: 2 }));
    await waitFor(() => {
      expect(toastOf("Setup action Build failed (exit 2)")).toBeDefined();
    });
    expect(toasts()).toHaveLength(1);
  });
});
