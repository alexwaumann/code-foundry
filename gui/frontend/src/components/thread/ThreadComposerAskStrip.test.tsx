import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView, ThreadPendingView } from "@/api/thread";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { resetDaemon } = await import("@/test/daemonFakes");
const { thread } = await import("@/test/projectsWorld");
const { useThreadsStore } = await import("@/stores/threads");
const { useThreadStore } = await import("@/stores/thread");
const { resetNeeds, useNeedsStore } = await import("@/stores/needs");
const { ThreadContext } = await import("./context");
const { ThreadComposer } = await import("./ThreadComposer");

/**
 * A shell pane too short for the full ask (docs/notes/shell-17-needs-you.md): the composer docks
 * the one-line strip in place of today's card, never both. When a pane is too short is
 * lib/needsAsk askAsStrip's (needsAsk.test.ts) and the browser's (shell-needs.spec.ts).
 */

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const CMD = "git push --force-with-lease origin cf/pr-badge-stale";
const perm: ThreadItemView = {
  ...base,
  id: "perm-1",
  ordinal: 3,
  kind: "permission",
  request: { requestId: "req-1", toolName: "Bash", displayName: "Bash", title: "", description: "", toolUseId: "tu-1", agentId: "", blockedPath: "", decisionReason: "", inputJson: JSON.stringify({ command: CMD }), suggestionsJson: "", state: "pending", decision: "", message: "", answers: {} },
};
const PENDING: ThreadPendingView[] = [
  { requestId: "req-1", itemId: "perm-1", question: false, toolName: "Bash", summary: `Bash ${CMD}` },
  { requestId: "req-2", itemId: "perm-2", question: false, toolName: "Bash", summary: "Bash ls" },
];

beforeEach(() => {
  resetDaemon();
  resetNeeds();
  Element.prototype.scrollIntoView = () => undefined;
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", { state: "connected", status: "attention", statusReason: `permission: Bash ${CMD}` }) }, order: ["s-1"], loaded: true });
  useThreadStore.setState({ logs: { "s-1": { seq: 1, byId: { [perm.id]: perm }, order: [perm.id], pending: PENDING, mcp: null, commands: [], agents: [] } }, synced: { "s-1": true } });
});

afterEach(() => {
  cleanup();
});

const composer = (askStrip: string | null) => (
  <ThreadContext.Provider value={{ threadId: "s-1", cwd: "/w" }}>
    <ThreadComposer threadId="s-1" pending={PENDING} busy askStrip={askStrip} />
  </ThreadContext.Provider>
);

describe("the ask in a short pane", () => {
  it("a pane with room: today's full card, no strip", () => {
    render(composer(null));
    expect(screen.getByTestId("thread-permission")).toBeTruthy();
    expect(screen.queryByTestId("ask-strip")).toBeNull();
  });

  it("too short: the strip (icon, kind, the start of the command, how many more), never the card", () => {
    render(composer("p-1"));
    expect(screen.queryByTestId("thread-prompts")).toBeNull();
    const strip = screen.getByTestId("ask-strip");
    expect(strip.getAttribute("data-ask")).toBe("permission");
    expect(strip.textContent).toBe(`Permission${CMD}+1`);
    expect(screen.getByTestId("ask-strip-text").textContent).toBe(CMD);
  });

  it("a click on the strip opens the popup, which shuts the strip's card until it is hovered again", () => {
    render(composer("p-1"));
    fireEvent.click(screen.getByTestId("ask-strip"));
    expect(useNeedsStore.getState().popup).toBe("s-1");
    expect(useNeedsStore.getState().dismissed).toBe("strip:p-1");
  });
});
