import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { answerConfirm } from "./confirm";
import { useThreadsStore } from "./threads";

const invokeCommand = vi.hoisted(() => vi.fn());
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  listCommands: () => Promise.resolve([]),
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
const { createBridgeHost } = await import("./bridgeHost");

/** The daemon's answer to a page's settings.set (commands_settings.go): it asks until confirmed. */
const ask = new NeedsConfirm({ command: "settings.set", title: "Change Setting", message: 'Change appearance.font_size to "15"?', confirmLabel: "Change" });
const args = { key: "appearance.font_size", value: "15" };

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
    opts?.confirmed ? Promise.resolve({ message: 'appearance.font_size = "15"', resultJson: "" }) : Promise.reject(ask),
  );
  useThreadsStore.setState({ byId: { "t-1": { id: "t-1", name: "Fix stale badge", projectId: "", worktreePath: "", workspaceId: "" } as ThreadView }, order: ["t-1"] });
});

afterEach(() => {
  answerConfirm(false);
  cleanup();
});

function page() {
  const posts: Record<string, unknown>[] = [];
  const h = createBridgeHost({ threadId: "t-1", pageName: "page.html", post: (m) => posts.push(m as unknown as Record<string, unknown>) });
  h.receive({ cf: 1, type: "cf:run", id: "a", verb: "settings.set", args });
  return posts;
}

describe("a page changing a setting", () => {
  it("says it is a page, which is how the daemon tells it from the CLI in its thread", async () => {
    page();
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalled();
    });
    expect(invokeCommand.mock.calls[0]?.slice(0, 3)).toEqual(["settings.set", expect.objectContaining({ activeThreadId: "t-1", activeView: "", origin: "page" }), args]);
  });

  it("shows the key, the value and who asks; only a yes runs it", async () => {
    render(<ConfirmDialog />);
    const posts = page();
    expect((await screen.findByTestId("confirm-dialog")).textContent).toContain('Change appearance.font_size to "15"?');
    expect(screen.getByTestId("confirm-caller").textContent).toBe("Asked by page.html, a page in Fix stale badge");
    expect(invokeCommand.mock.calls.filter((c) => (c[4] as { confirmed?: boolean } | undefined)?.confirmed)).toEqual([]);
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: true, result: { text: 'appearance.font_size = "15"' } });
    });
    const confirmed = invokeCommand.mock.calls.at(-1);
    expect(confirmed?.[2]).toEqual(args);
    expect(confirmed?.[4]).toMatchObject({ confirmed: true });
  });

  it("is declined when the user says no", async () => {
    render(<ConfirmDialog />);
    const posts = page();
    fireEvent.click(await screen.findByTestId("confirm-cancel"));
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: false, error: { code: "declined" } });
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("hears a user-only refusal as it is, with no dialog", async () => {
    const refusal = "advanced.claude_path can only be changed by the user; they can change it in Settings";
    const { Code, ConnectError } = await import("@connectrpc/connect");
    invokeCommand.mockRejectedValue(new ConnectError(refusal, Code.FailedPrecondition));
    render(<ConfirmDialog />);
    const posts = page();
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: false, error: { code: "unavailable", message: expect.stringContaining(refusal) as unknown } });
    });
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });
});
