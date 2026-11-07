import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { answerConfirm, useConfirmStore } from "./confirm";
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

/** The daemon's answer to a page's call that runs a program (command/page_ask.go). */
const question = 'Run this?\nterminal.new --argv "make test"';
const ask = new NeedsConfirm({ command: "terminal.new", title: "New Terminal", message: question, confirmLabel: "Allow" });
const args = { argv: "make test" };
const confirmedCalls = () => invokeCommand.mock.calls.filter((c) => (c[4] as { confirmed?: boolean } | undefined)?.confirmed);

beforeEach(() => {
  invokeCommand.mockReset();
  invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
    opts?.confirmed ? Promise.resolve({ message: "created terminal t-9", resultJson: "" }) : Promise.reject(ask),
  );
  useThreadsStore.setState({ byId: { "t-1": { id: "t-1", name: "Fix stale badge", projectId: "", worktreePath: "", workspaceId: "" } as ThreadView }, order: ["t-1"] });
});

afterEach(() => {
  answerConfirm(false);
  cleanup();
});

function page(callArgs: Record<string, string> = args) {
  const posts: Record<string, unknown>[] = [];
  const h = createBridgeHost({ threadId: "t-1", pageName: "board.html", userPresent: () => true, post: (m) => posts.push(m as unknown as Record<string, unknown>) });
  h.receive({ cf: 1, type: "cf:run", id: "a", verb: "terminal.new", args: callArgs });
  return posts;
}

describe("a page's call that runs a program", () => {
  it("shows the call, its button words and who asks; nothing runs before the yes", async () => {
    render(<ConfirmDialog />);
    const posts = page();
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain('terminal.new --argv "make test"');
    expect(screen.getByTestId("confirm-caller").textContent).toBe("Asked by a page");
    expect(screen.getByTestId("confirm-caller-detail").textContent).toBe('Page "board.html" in thread "Fix stale badge"');
    const ok = screen.getByTestId<HTMLButtonElement>("confirm-ok");
    expect(ok.textContent).toBe("Allow");
    expect(confirmedCalls()).toEqual([]);
    await vi.waitFor(
      () => {
        expect(ok.disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(ok);
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: true, result: { text: "created terminal t-9" } });
    });
    expect(confirmedCalls()).toHaveLength(1);
    expect(confirmedCalls()[0]?.slice(0, 3)).toEqual(["terminal.new", expect.objectContaining({ origin: "page", activeView: "" }), args]);
  });

  // The host's check is that the user is in the page, which a page's own timer also passes:
  // what stands in the way of the call is this question, so it is the guarded one every time.
  it("always reaches the guarded dialog: Cancel focused, Allow off, nothing run", async () => {
    render(<ConfirmDialog />);
    page();
    await screen.findByTestId("confirm-dialog");
    expect(useConfirmStore.getState().pending?.guarded).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId("confirm-cancel"));
    expect(screen.getByTestId<HTMLButtonElement>("confirm-ok").disabled).toBe(true);
    expect(confirmedCalls()).toEqual([]);
  });

  it("tells the page its clock stops while the user reads", async () => {
    render(<ConfirmDialog />);
    const posts = page();
    await screen.findByTestId("confirm-dialog");
    expect(posts).toContainEqual({ type: "cf:pending", id: "a", reason: "confirm" });
  });

  it("is declined on Cancel and never sent confirmed", async () => {
    render(<ConfirmDialog />);
    const posts = page();
    fireEvent.click(await screen.findByTestId("confirm-cancel"));
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: false, error: { code: "declined" } });
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it("cannot answer for the user: an arg named confirmed or yes stays an arg", async () => {
    render(<ConfirmDialog />);
    const sent = { ...args, confirmed: "true", yes: "true" };
    page(sent);
    await screen.findByTestId("confirm-dialog");
    expect(invokeCommand.mock.calls[0]?.[2]).toEqual(sent);
    expect(confirmedCalls()).toEqual([]);
  });
});
