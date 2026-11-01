import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { useThreadsStore } from "@/stores/threads";
import { FIX, seedWorld } from "@/test/projectsWorld";
import { HeaderActions } from "./HeaderActions";
import { ThreadTitle } from "./ThreadParts";

// A stopped thread's header (e2e threads.spec.ts used to check it in the app): the crumb says
// where it runs, the project, and nothing of its path, model or state. ThreadPane renders the
// composer for every thread, stopped or not (no branch on the thread's state).

const cmd = (name: string) => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });

beforeEach(() => {
  seedWorld();
  useCommandsStore.setState({ commands: ["view.thread-info", "view.bottom.toggle", "view.panel.toggle"].map(cmd) });
});
afterEach(cleanup);

function header(id: string, o: Partial<ThreadView> = {}): HTMLElement {
  useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), flags: [], checkoutPaths: [], ...o } } }));
  render(
    <header data-testid="thread-header">
      <ThreadTitle id={id} />
      <HeaderActions />
    </header>,
  );
  return screen.getByTestId("thread-header");
}

describe("a stopped thread's header", () => {
  it.each<[string, string, Partial<ThreadView>, string]>([
    ["crashed mid-turn (interrupted)", "s-1", { state: "disconnected", status: "error", statusReason: "interrupted", model: "claude-opus-4-8[1m]" }, "Refactor sidebar tree"],
    ["stopped in a linked worktree", "s-3", { state: "disconnected", worktreePath: FIX, model: "claude-opus-4-8[1m]", effort: "medium" }, "Fix resize race"],
  ])("%s: the title and the project, no path, model or state", (_n, id, o, title) => {
    const h = header(id, o);
    expect(screen.getByTestId("thread-title-name").textContent).toBe(title);
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe("code-foundry");
    expect(h.textContent).not.toContain("Opus");
    expect(h.textContent).not.toContain("fix-resize");
    expect(h.textContent).not.toMatch(/disconnected|stopped|Close|Not connected|Reconnect/);
  });
});
