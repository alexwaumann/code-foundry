import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOpView } from "@/api/gitops";
import { Toaster } from "@/components/ui/sonner";

const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", () => ({ runCommand }));
const { applyGitOpsEvent } = await import("@/stores/gitops");

/**
 * The git-op toasts (stores/gitops.tsx over GitOpToast) in a real sonner Toaster: progress
 * while an op is queued or runs, then its result in place; a failure stays up with its
 * output behind a toggle; an op the CLI started gets its toast too; a created PR offers Open.
 */

const CF = "/Users/dev/src/code-foundry";

function op(over: Partial<GitOpView>): GitOpView {
  return { id: "op-1", kind: "push", state: "running", title: "Push main", worktreePath: CF, projectId: "repo-cf", branch: "main", durationMs: 0, summary: "", output: "", url: "", ...over };
}

/** The toast whose title is `title`. */
function toastOf(title: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")].find((t) => t.querySelector("[data-title]")?.textContent === title);
  if (!el) throw new Error(`no toast "${title}"`);
  return el;
}

function toasts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
}

beforeEach(() => {
  runCommand.mockClear();
  render(<Toaster theme="dark" />);
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
});

describe("git-op toasts", () => {
  it("shows a progress toast with the worktree, then its result in place", async () => {
    act(() => {
      applyGitOpsEvent({ kind: "started", op: op({}) });
    });
    await waitFor(() => {
      expect(within(toastOf("Push main")).getByTestId("gitop-toast").dataset.state).toBe("running");
    });
    expect(toastOf("Push main").textContent).toContain("code-foundry");

    act(() => {
      applyGitOpsEvent({ kind: "finished", op: op({ state: "succeeded", summary: "pushed main to origin", durationMs: 1400 }) });
    });
    await waitFor(() => {
      expect(within(toastOf("Push main")).getByTestId("gitop-toast").dataset.state).toBe("succeeded");
    });
    const push = toastOf("Push main");
    expect(within(push).getByTestId("gitop-summary").textContent).toBe("pushed main to origin");
    expect(push.textContent).toContain("code-foundry · 1.4s");
    // One toast for the op: the result replaced the progress.
    expect(toasts().filter((t) => t.textContent.includes("pushed main to origin"))).toHaveLength(1);
    expect(toasts()).toHaveLength(1);
  });

  it("a second op waiting on the worktree says so, then runs", async () => {
    act(() => {
      applyGitOpsEvent({ kind: "queued", op: op({ id: "op-2", kind: "pull", title: "Pull main", state: "queued" }) });
    });
    await waitFor(() => {
      expect(within(toastOf("Pull main")).getByTestId("gitop-toast").dataset.state).toBe("queued");
    });
    expect(toastOf("Pull main").textContent).toContain("waiting for the previous operation");
    act(() => {
      applyGitOpsEvent({ kind: "started", op: op({ id: "op-2", kind: "pull", title: "Pull main", state: "running" }) });
    });
    await waitFor(() => {
      expect(within(toastOf("Pull main")).getByTestId("gitop-toast").dataset.state).toBe("running");
    });
    expect(toastOf("Pull main").textContent).not.toContain("waiting for the previous operation");
    act(() => {
      applyGitOpsEvent({ kind: "finished", op: op({ id: "op-2", kind: "pull", title: "Pull main", state: "succeeded", summary: "fast-forwarded main by 2 commits" }) });
    });
    await waitFor(() => {
      expect(within(toastOf("Pull main")).getByTestId("gitop-summary").textContent).toMatch(/fast-forwarded/);
    });
  });

  it("a failure stays up, expands to its output, and closes with its button", async () => {
    const output = "To github.com:alexwaumann/code-foundry.git\n ! [rejected]        main -> main (fetch first)\nhint: Updates were rejected because the remote contains work that you do not\n";
    act(() => {
      applyGitOpsEvent({ kind: "started", op: op({}) });
      applyGitOpsEvent({ kind: "finished", op: op({ state: "failed", summary: "[rejected] main -> main (fetch first)", output }) });
    });
    await waitFor(() => {
      expect(toastOf("Push main failed")).toBeTruthy();
    });
    const failed = () => toastOf("Push main failed");
    expect(within(failed()).getByTestId("gitop-summary").textContent).toBe("[rejected] main -> main (fetch first)");
    expect(within(failed()).queryByTestId("gitop-output")).toBeNull();
    fireEvent.click(within(failed()).getByTestId("gitop-output-toggle"));
    await waitFor(() => {
      expect(within(failed()).getByTestId("gitop-output").textContent).toContain("! [rejected]        main -> main (fetch first)");
    });
    expect(within(failed()).getByTestId("gitop-output").textContent).toContain("hint: Updates were rejected");
    expect(within(failed()).getByTestId("gitop-output-toggle").textContent).toBe("Hide output");
    // Only the op's own toast: no generic "Git: Push failed" (runCommand skips git-op failures: commands.test.ts).
    expect(toasts()).toHaveLength(1);
    // Failures carry a close button (success toasts time out).
    fireEvent.click(within(failed()).getByRole("button", { name: "Close toast" }));
    await waitFor(() => {
      expect(toasts().filter((t) => t.dataset.removed !== "true")).toHaveLength(0);
    });
  });

  it("an op started outside the GUI (the CLI) gets its result toast", async () => {
    act(() => {
      applyGitOpsEvent({
        kind: "finished",
        op: op({ id: "cli-1", kind: "fetch", title: "Fetch fix/resize", state: "succeeded", worktreePath: `${CF}.worktrees/fix-resize`, branch: "fix/resize", summary: "fetched 2 updated refs" }),
      });
    });
    await waitFor(() => {
      expect(within(toastOf("Fetch fix/resize")).getByTestId("gitop-summary").textContent).toBe("fetched 2 updated refs");
    });
    expect(toastOf("Fetch fix/resize").textContent).toContain("fix-resize");
  });

  it("a created PR's result offers Open, which opens its URL", async () => {
    const url = "https://github.com/alexwaumann/code-foundry/pull/128";
    act(() => {
      applyGitOpsEvent({ kind: "finished", op: op({ id: "pr-1", kind: "pr-create", title: "Create PR for feat/sidebar", state: "succeeded", summary: "created pull request #128", url }) });
    });
    await waitFor(() => {
      expect(within(toastOf("Create PR for feat/sidebar")).getByTestId("gitop-summary").textContent).toBe("created pull request #128");
    });
    fireEvent.click(within(toastOf("Create PR for feat/sidebar")).getByRole("button", { name: "Open" }));
    expect(runCommand).toHaveBeenCalledWith("view.open.url", { url });
  });

  it("other ops' results offer no Open", async () => {
    act(() => {
      applyGitOpsEvent({ kind: "finished", op: op({ id: "op-9", state: "succeeded", summary: "pushed main to origin", url: "https://example.com" }) });
    });
    await waitFor(() => {
      expect(toastOf("Push main")).toBeTruthy();
    });
    expect(within(toastOf("Push main")).queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByTestId("gitop-output-toggle")).toBeNull();
  });
});
