import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import { answerConfirm, useConfirmStore } from "./confirm";

const invokeCommand = vi.hoisted(() => vi.fn());
// Each rejection is an Error carrying the confirmation the daemon would send.
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
const { invokeConfirmed } = await import("./commands");

const ctx = { activeTerminalId: "", activeThreadId: "", activeProjectId: "p1", activeWorktreePath: "/w/a", activeView: "projects", activeWorkspaceId: "" };
const first = new NeedsConfirm({ command: "project.worktree.remove", title: "Remove Worktree", message: "Remove worktree /w/a? This deletes files on disk." });
const second = new NeedsConfirm({
  command: "project.worktree.remove",
  title: "Delete Uncommitted Work",
  message: "The worktree of cf/a at /w/a has uncommitted work: 2 modified, 1 untracked.",
  args: { force: "true" },
});
const ok = { message: "removed worktree /w/a", resultJson: "" };

async function answer(message: string, yes: boolean) {
  await vi.waitFor(() => {
    expect(useConfirmStore.getState().pending?.message).toBe(message);
  });
  answerConfirm(yes);
}

describe("invokeConfirmed second-stage confirmation", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("asks twice and merges the second stage's args into the confirmed re-invoke", async () => {
    invokeCommand.mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", { path: "/w/a", "delete-branch": "true" }, ctx);
    await answer(first.confirm.message, true);
    await answer(second.confirm.message, true);
    expect(await done).toEqual(ok);
    expect(invokeCommand).toHaveBeenCalledTimes(3);
    expect(invokeCommand).toHaveBeenNthCalledWith(2, "project.worktree.remove", ctx, { path: "/w/a", "delete-branch": "true" }, undefined, { confirmed: true });
    expect(invokeCommand).toHaveBeenLastCalledWith("project.worktree.remove", ctx, { path: "/w/a", "delete-branch": "true", force: "true" }, undefined, { confirmed: true });
  });

  it("shows the second stage under its own title", async () => {
    invokeCommand.mockRejectedValueOnce(second).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", { path: "/w/a" }, ctx);
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).toMatchObject({ title: "Delete Uncommitted Work", confirmLabel: "Delete Uncommitted Work" });
    });
    answerConfirm(true);
    await done;
  });

  it.each([
    ["without a declined result: null", undefined, null],
    ["with a declined result: that result", { message: "Removed 1 worktree: cf/b", resultJson: "{}" }, { message: "Removed 1 worktree: cf/b", resultJson: "{}" }],
  ])("declining the second stage resolves %s, with no further invoke", async (_, declined, want) => {
    invokeCommand.mockRejectedValueOnce(new NeedsConfirm({ ...second.confirm, ...(declined ? { declined } : {}) }));
    const done = invokeConfirmed("project.worktree.remove", { path: "/w/a" }, ctx);
    await answer(second.confirm.message, false);
    expect(await done).toEqual(want);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("rejects a second stage raised by another command (plugin.act's button)", async () => {
    invokeCommand.mockRejectedValueOnce(second);
    await expect(invokeConfirmed("plugin.act", { key: "rm" }, ctx)).rejects.toBe(second);
    expect(useConfirmStore.getState().pending).toBeNull();
  });
});

describe("invokeConfirmed bind args", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });
  const consent = new NeedsConfirm({
    command: "plugin.enable",
    title: "Enable Plugin",
    message: "Enable Hello 0.1.0? It runs bin/hello as you and asks for no permissions.",
    bind: { "consent-digest": "d1" },
  });

  it("asks through the command's own presenter and sends the bind args with the yes", async () => {
    const { useConsentStore, answerConsent } = await import("./pluginConsent");
    invokeCommand.mockRejectedValueOnce(consent).mockResolvedValue(ok);
    const done = invokeConfirmed("plugin.enable", { name: "hello" }, ctx);
    await vi.waitFor(() => {
      expect(useConsentStore.getState().pending?.text).toBe(consent.confirm.message);
    });
    answerConsent(true);
    expect(await done).toEqual(ok);
    expect(invokeCommand).toHaveBeenLastCalledWith("plugin.enable", ctx, { name: "hello", "consent-digest": "d1" }, undefined, { confirmed: true });
  });

  it("does not send another command's bind args (plugin.act's button)", async () => {
    invokeCommand.mockRejectedValueOnce(consent).mockResolvedValue(ok);
    const done = invokeConfirmed("plugin.act", { key: "on" }, ctx);
    await answer(consent.confirm.message, true);
    await done;
    expect(invokeCommand).toHaveBeenLastCalledWith("plugin.act", ctx, { key: "on" }, undefined, { confirmed: true });
  });
});
