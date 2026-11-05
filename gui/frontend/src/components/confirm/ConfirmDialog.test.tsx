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

const { ConfirmDialog } = await import("./ConfirmDialog");
const { runCommand } = await import("@/stores/commands");
const { requestChoice, requestConfirm, useConfirmStore } = await import("@/stores/confirm");

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
      done = requestConfirm({ title: "Thread: Archive", message: "Archive thread s-3?", confirmLabel: "Archive", caller: "Bridge check, a page in Fix stale badge" });
    });
    expect((await screen.findByTestId("confirm-caller")).textContent).toBe("Asked by Bridge check, a page in Fix stale badge");
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
