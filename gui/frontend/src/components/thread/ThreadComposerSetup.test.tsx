import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadSetupView, ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { daemon, invocationsOf, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { thread } = await import("@/test/projectsWorld");
const { useCommandsStore } = await import("@/stores/commands");
const { updateDraft, useComposeStore } = await import("@/stores/compose");
const { useThreadsStore } = await import("@/stores/threads");
const { threadDraftKey } = await import("@/stores/threadActions");
const { useUiStore } = await import("@/stores/ui");
const { startCommandNamed } = await import("@/keys/bindings");
const { ThreadComposer } = await import("./ThreadComposer");

/**
 * The thread composer around a setup (docs/notes/instant-threads-4-composer.md): Cancel in
 * Interrupt's place, the placeholder, the note and what its buttons run, the pickers, and a
 * setup someone waits for, which takes neither. stores/setupActions.test.ts has what the
 * commands do with the answer.
 */

const ID = "s-r1";
const KEY = threadDraftKey(ID);
const AWAITING = "Add to your message. It goes in once Claude starts.";
const INTERRUPT: CommandView = { name: "thread.interrupt", title: "", description: "", category: "", args: [], keybindings: ["cmd+."], available: true };

const setup = (phase: ThreadSetupView["phase"], o: Partial<ThreadSetupView> = {}): ThreadSetupView => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true, ...o });

function put(o: Partial<ThreadView>): void {
  useThreadsStore.setState((s) => ({ byId: { ...s.byId, [ID]: { ...(s.byId[ID] ?? thread(ID, { state: "connected" })), ...o } }, order: [ID] }));
}

const placeholder = () => screen.getByTestId("composer-input").getAttribute("aria-placeholder");
const interrupt = () => screen.queryByTestId("thread-interrupt");
const cancel = () => screen.queryByTestId("thread-setup-cancel");
const pressCancel = () => {
  fireEvent.click(screen.getByTestId("thread-setup-cancel"));
};
const note = () => screen.queryByTestId("thread-setup-note");
const composer = (busy = true) => render(<ThreadComposer threadId={ID} pending={[]} busy={busy} />);

beforeEach(() => {
  resetDaemon();
  put({ setup: setup("running"), state: "starting", status: "busy", statusReason: "setting up", worktreePath: "" });
  useUiStore.setState({ selection: { kind: "thread", id: ID } });
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
  useCommandsStore.setState({ commands: [] });
});

describe("during a background setup", () => {
  it("Interrupt reads Cancel and runs thread.setup.cancel", async () => {
    composer();
    expect(interrupt()).toBeNull();
    expect(cancel()?.textContent).toBe("Cancel");
    pressCancel();
    await waitFor(() => {
      expect(invocationsOf("thread.setup.cancel").map((i) => i.args)).toEqual([{ id: ID }]);
    });
    expect(invocationsOf("thread.interrupt")).toEqual([]);
  });

  it("Interrupt's key cancels too, and never reaches the daemon as an interrupt", async () => {
    useCommandsStore.setState({ commands: [INTERRUPT] });
    expect(startCommandNamed("thread.interrupt")).toBe(true);
    await waitFor(() => {
      expect(invocationsOf("thread.setup.cancel").map((i) => i.args)).toEqual([{ id: ID }]);
    });
    expect(invocationsOf("thread.interrupt")).toEqual([]);
  });

  it("too late: Interrupt returns once the daemon says Claude is starting", async () => {
    daemon.handlers.set("thread.setup.cancel", () => {
      put({ setup: setup("done"), state: "connected", status: "busy", statusReason: "working" });
      throw refuse("it was too late to cancel it, and Claude is starting");
    });
    composer();
    pressCancel();
    await waitFor(() => {
      expect(interrupt()).toBeTruthy();
    });
    expect(cancel()).toBeNull();
  });

  it("asks for more of the message, and sends it as a normal thread.send", async () => {
    composer();
    expect(placeholder()).toBe(AWAITING);
    act(() => {
      updateDraft(KEY, { text: "and this" });
    });
    fireEvent.click(screen.getByTestId("thread-send"));
    await waitFor(() => {
      expect(invocationsOf("thread.send").map((i) => i.args)).toEqual([{ id: ID, text: "and this" }]);
    });
  });

  it("disables the pickers, and gives them back when it ends", () => {
    composer();
    const pickers = ["thread-model", "thread-effort", "thread-permission-mode"];
    const disabled = () => pickers.map((id) => screen.getByTestId(id).hasAttribute("disabled"));
    expect(disabled()).toEqual([true, true, true]);
    act(() => {
      put({ setup: setup("done"), state: "connected" });
    });
    expect(disabled()).toEqual([false, false, false]);
    act(() => {
      put({ setup: setup("failed"), state: "disconnected" });
    });
    expect(disabled()).toEqual([false, false, false]);
  });

  it("shows no note", () => {
    composer();
    expect(note()).toBeNull();
  });
});

describe("a setup someone waits for", () => {
  beforeEach(() => {
    put({ setup: setup("running", { background: false }) });
  });

  it("offers neither Cancel nor Interrupt, and says why it takes no message", () => {
    composer();
    expect(cancel()).toBeNull();
    expect(interrupt()).toBeNull();
    expect(placeholder()).toBe("You can reply once Claude has started.");
  });

  it("keeps what is typed and sends nothing", () => {
    composer();
    act(() => {
      updateDraft(KEY, { text: "a thought" });
    });
    const send = screen.getByTestId("thread-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(invocationsOf("thread.send")).toEqual([]);
    expect(useComposeStore.getState().drafts[KEY]?.text).toBe("a thought");
  });

  it("Interrupt's key does nothing there", () => {
    useCommandsStore.setState({ commands: [INTERRUPT] });
    startCommandNamed("thread.interrupt");
    expect(invocationsOf("thread.setup.cancel")).toEqual([]);
    expect(invocationsOf("thread.interrupt")).toEqual([]);
  });
});

describe("the setup's note", () => {
  const failed = { setup: setup("failed", { steps: [{ kind: "worktree", projectId: "p", projectName: "p", ref: "", branch: "", status: "failed", startedAtMs: 1, endedAtMs: 2, error: "no", warning: "", refAtMs: null, existing: false }] }), state: "disconnected", status: "error", statusReason: "setup failed" } as const;

  it("failed: the step's words in the error colour, Remove, Edit, Try again, no close", () => {
    put(failed);
    composer(false);
    const n = screen.getByTestId("thread-setup-note");
    expect(within(n).getByTestId("thread-setup-reason").textContent).toBe("Could not create the worktree, so your message was not sent.");
    expect(n.querySelector("svg")?.getAttribute("class")).toContain("text-cf-error-text");
    expect(within(n).getAllByRole("button").map((b) => b.textContent)).toEqual(["Remove", "Edit", "Try again"]);
  });

  it("cancelled: the same in muted", () => {
    put({ setup: setup("cancelled"), state: "disconnected", status: "idle", statusReason: "setup cancelled" });
    composer(false);
    const n = screen.getByTestId("thread-setup-note");
    expect(within(n).getByTestId("thread-setup-reason").textContent).toBe("Setup cancelled, so your message was not sent.");
    expect(n.querySelector("svg")?.getAttribute("class")).toContain("text-cf-text-muted");
  });

  it("asks for more of the message there too", () => {
    put(failed);
    composer(false);
    expect(placeholder()).toBe(AWAITING);
  });

  it("Try again runs thread.setup.retry, and its refusal is the error line", async () => {
    put(failed);
    daemon.handlers.set("thread.setup.retry", () => {
      throw refuse("thread kept nothing to try its setup again with");
    });
    composer(false);
    fireEvent.click(screen.getByTestId("thread-setup-retry"));
    expect((await screen.findByTestId("thread-composer-error")).textContent).toContain("kept nothing");
  });

  it("Remove runs thread.remove, whose confirm is the daemon's", async () => {
    put(failed);
    composer(false);
    fireEvent.click(screen.getByTestId("thread-setup-remove"));
    await waitFor(() => {
      expect(invocationsOf("thread.remove")).toHaveLength(1);
    });
    expect(invocationsOf("thread.remove")[0]?.context.activeThreadId).toBe(ID);
  });

  it("Edit runs thread.setup.discard", async () => {
    put(failed);
    composer(false);
    fireEvent.click(screen.getByTestId("thread-setup-edit"));
    await waitFor(() => {
      expect(invocationsOf("thread.setup.discard").map((i) => i.args)).toEqual([{ id: ID }]);
    });
  });

  it("goes while the setup runs again", () => {
    put(failed);
    composer(false);
    expect(note()).toBeTruthy();
    act(() => {
      put({ setup: setup("running"), state: "starting" });
    });
    expect(note()).toBeNull();
  });
});
