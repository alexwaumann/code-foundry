import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";

// The daemon refuses a destructive command with a ConfirmationRequired detail; runCommand
// shows this dialog and invokes again, confirmed, on a yes.
const invokeCommand = vi.hoisted(() => vi.fn());
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { CONFIRM_ARM_MS, ConfirmDialog } = await import("./ConfirmDialog");
const { runCommand } = await import("@/stores/commands");
const { answerConfirm, requestChoice, requestConfirm, useConfirmStore } = await import("@/stores/confirm");

const ctx = { activeTerminalId: "", activeThreadId: "", activeProjectId: "", activeWorktreePath: "", activeView: "settings", activeWorkspaceId: "" };
const clear = new NeedsConfirm({ command: "memory.clear", title: "Memory: Forget All Preferences", message: "Forget every remembered preference? New threads get none.", confirmLabel: "Forget all" });
const remove = new NeedsConfirm({ command: "thread.remove", title: "Thread: Remove", message: "Remove thread s-3?" });
const confirmedFlags = () => invokeCommand.mock.calls.map((c) => (c[4] as { confirmed?: boolean } | undefined)?.confirmed ?? false);

beforeEach(() => {
  invokeCommand.mockReset();
  useConfirmStore.setState({ pending: null });
});
afterEach(cleanup);

describe("ConfirmDialog", () => {
  describe("a guarded request", () => {
    const question = { title: "Change Setting", message: "Change it?", confirmLabel: "Change", guarded: true };
    const ok = () => screen.getByTestId<HTMLButtonElement>("confirm-ok");
    const wait = (ms: number) => {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
    };
    const ask = (req: Parameters<typeof requestConfirm>[0] = question) => {
      let done!: Promise<boolean>;
      act(() => {
        done = requestConfirm(req);
      });
      return done;
    };
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      act(() => {
        answerConfirm(false);
      });
      vi.useRealTimers();
    });

    it("has Cancel focused and Change off for a moment, then on", () => {
      render(<ConfirmDialog />);
      void ask();
      expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel"));
      expect(ok().disabled).toBe(true);
      wait(CONFIRM_ARM_MS - 1);
      expect(ok().disabled).toBe(true);
      wait(60);
      expect(ok().disabled).toBe(false);
      expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel"));
    });

    it("a press on Change while it is off answers nothing", () => {
      render(<ConfirmDialog />);
      const heard = vi.fn();
      void ask().then(heard);
      fireEvent.click(ok());
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });

    it.each([
      ["a key", () => fireEvent.keyDown(window, { code: "Space" }), () => fireEvent.keyUp(window, { code: "Space" })],
      ["a pointer", () => fireEvent.pointerDown(window), () => fireEvent.pointerUp(window)],
      ["a press begun in a page, seen only as it moves", () => fireEvent.pointerMove(window, { buttons: 1 }), () => fireEvent.pointerMove(window, { buttons: 0 })],
    ])("waits for %s held past the wait to be let go, then the wait again", (_name, press, release) => {
      render(<ConfirmDialog />);
      void ask();
      press();
      wait(CONFIRM_ARM_MS * 3);
      expect(ok().disabled).toBe(true);
      release();
      wait(CONFIRM_ARM_MS - 1);
      expect(ok().disabled).toBe(true);
      wait(1);
      expect(ok().disabled).toBe(false);
    });

    it.each([
      ["a key", () => fireEvent.keyDown(window, { code: "Space" }), () => fireEvent.keyUp(window, { code: "Space" })],
      ["a pointer", () => fireEvent.pointerDown(window), () => fireEvent.pointerUp(window)],
    ])("each press of %s starts the wait again", (_name, press, release) => {
      render(<ConfirmDialog />);
      void ask();
      for (let i = 0; i < 5; i++) {
        wait(CONFIRM_ARM_MS - 100);
        press();
        release();
      }
      wait(CONFIRM_ARM_MS - 1);
      expect(ok().disabled).toBe(true);
      wait(1);
      expect(ok().disabled).toBe(false);
    });

    it("once on, a press elsewhere starts the wait again, and a press on Change does not", () => {
      render(<ConfirmDialog />);
      void ask();
      wait(CONFIRM_ARM_MS);
      fireEvent.pointerDown(ok());
      fireEvent.pointerUp(ok());
      expect(ok().disabled).toBe(false);
      fireEvent.pointerDown(screen.getByTestId("confirm-dialog"));
      expect(ok().disabled).toBe(true);
    });

    it("once on, a key leaves it on, so Tab can reach Change", () => {
      render(<ConfirmDialog />);
      void ask();
      wait(CONFIRM_ARM_MS);
      fireEvent.keyDown(window, { code: "Tab" });
      fireEvent.keyUp(window, { code: "Tab" });
      expect(ok().disabled).toBe(false);
    });

    it("a key that lost its keyup under Command does not keep Change off", () => {
      render(<ConfirmDialog />);
      void ask();
      fireEvent.keyDown(window, { code: "KeyA" });
      fireEvent.keyDown(window, { code: "MetaLeft", key: "Meta" });
      fireEvent.keyUp(window, { code: "MetaLeft", key: "Meta" });
      wait(CONFIRM_ARM_MS + 60);
      expect(ok().disabled).toBe(false);
    });

    it("starts over on the next request, whatever was on screen", () => {
      render(<ConfirmDialog />);
      void ask();
      void ask({ ...question, message: "The next one" });
      wait(CONFIRM_ARM_MS + 60);
      expect(ok().disabled).toBe(false);
      act(() => {
        answerConfirm(false);
      });
      expect(screen.getByTestId("confirm-dialog").textContent).toContain("The next one");
      expect(ok().disabled).toBe(true);
      expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel"));
    });

    it("shows a page's names on their own line, and spaces as they are", () => {
      render(<ConfirmDialog />);
      void ask({ ...question, message: `Change it to "${" ".repeat(9)}"?`, caller: "a page", callerDetail: 'Page "a.html" in thread "b"' });
      expect(screen.getByTestId("confirm-caller").textContent).toBe("Asked by a page");
      expect(screen.getByTestId("confirm-caller-detail").textContent).toBe('Page "a.html" in thread "b"');
      expect(screen.getByText(/Change it to/).className).toContain("whitespace-pre-wrap");
    });
  });

  it("the app's own request has Confirm focused and on at once", () => {
    render(<ConfirmDialog />);
    act(() => {
      void requestConfirm({ title: "Remove", message: "Remove it?", confirmLabel: "Remove" });
    });
    const ok = screen.getByTestId<HTMLButtonElement>("confirm-ok");
    expect(ok.disabled).toBe(false);
    expect(document.activeElement).toBe(ok);
  });

  describe("a three-way prompt", () => {
    const ask = () => {
      let done!: Promise<string>;
      act(() => {
        done = requestChoice({ title: "Save changes to .env?", message: "Unsaved edits are lost if you discard them.", confirmLabel: "Save", alternateLabel: "Discard", cancelLabel: "Keep editing" });
      });
      return { done };
    };

    it("Enter's answer is the safe one, and the destructive one is the alternate", () => {
      render(<ConfirmDialog />);
      ask();
      expect(screen.getByTestId("confirm-ok").textContent).toBe("Save");
      expect(document.activeElement).toBe(screen.getByTestId("confirm-ok"));
      expect(screen.getByTestId("confirm-ok").getAttribute("data-variant")).toBe("default");
      expect(screen.getByTestId("confirm-alternate").textContent).toBe("Discard");
      expect(screen.getByTestId("confirm-cancel").textContent).toBe("Keep editing");
    });

    it.each([
      ["confirm-ok", "confirm"],
      ["confirm-alternate", "alternate"],
      ["confirm-cancel", "cancel"],
    ])("%s answers %s", async (button, want) => {
      render(<ConfirmDialog />);
      const { done } = ask();
      fireEvent.click(screen.getByTestId(button));
      await expect(done).resolves.toBe(want);
    });
  });

  it("a plain prompt has no third button and stays destructive", () => {
    render(<ConfirmDialog />);
    act(() => {
      void requestConfirm({ title: "t", message: "m", confirmLabel: "Remove" });
    });
    expect(screen.queryByTestId("confirm-alternate")).toBeNull();
    expect(screen.getByTestId("confirm-cancel").textContent).toBe("Cancel");
    expect(screen.getByTestId("confirm-ok").getAttribute("data-variant")).toBe("destructive");
  });

  it("names who asked when it was not the user (a page's or a plugin's call)", async () => {
    render(<ConfirmDialog />);
    let done!: Promise<boolean>;
    act(() => {
      done = requestConfirm({ title: "Thread: Archive", message: "Archive thread s-3?", confirmLabel: "Archive", caller: "Hello" });
    });
    expect((await screen.findByTestId("confirm-caller")).textContent).toBe("Asked by Hello");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(await done).toBe(false);
  });

  it("shows the daemon's question with the command's button words; Cancel runs nothing", async () => {
    invokeCommand.mockRejectedValueOnce(clear);
    render(<ConfirmDialog />);
    let done!: Promise<boolean>;
    act(() => {
      done = runCommand("memory.clear", {}, ctx);
    });
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Forget every remembered preference? New threads get none.");
    expect(screen.getByTestId("confirm-ok").textContent).toBe("Forget all");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(await done).toBe(false);
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    });
    expect(confirmedFlags()).toEqual([false]);
  });

  it("cancel keeps, then confirm runs once more, confirmed", async () => {
    invokeCommand.mockRejectedValueOnce(remove).mockRejectedValueOnce(remove).mockResolvedValue({ message: "", resultJson: "" });
    render(<ConfirmDialog />);
    let first!: Promise<boolean>;
    act(() => {
      first = runCommand("thread.remove", { id: "s-3" }, ctx);
    });
    expect((await screen.findByTestId("confirm-dialog")).textContent).toContain("Remove thread s-3?");
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(await first).toBe(false);
    expect(confirmedFlags()).toEqual([false]);

    let second!: Promise<boolean>;
    act(() => {
      second = runCommand("thread.remove", { id: "s-3" }, ctx);
    });
    await screen.findByTestId("confirm-dialog");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(await second).toBe(true);
    expect(confirmedFlags()).toEqual([false, false, true]);
    expect(invokeCommand).toHaveBeenLastCalledWith("thread.remove", ctx, { id: "s-3" }, undefined, { confirmed: true });
  });
});
