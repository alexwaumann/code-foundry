import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { envStaleTip } from "@/lib/envStale";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

const start = vi.hoisted(() => vi.fn());
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed: start }));

const { EnvStaleNote } = await import("./EnvStaleNote");

const restart: CommandView = { name: "thread.restart", title: "Restart Claude", description: "", category: "Thread", args: [], keybindings: [], available: true };

function renderNote(t: Partial<ThreadView>): void {
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", projectId: "", worktreePath: "/Users/dev", workspaceId: "", flags: [], ...t } as unknown as ThreadView }, order: ["s-1"] });
  useCommandsStore.setState({ commands: [restart], contextKey: contextKey(getUiContext({ kind: "thread", id: "s-1" })), loading: false });
  render(<EnvStaleNote id="s-1" />);
}

beforeEach(() => {
  start.mockReset();
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

afterEach(cleanup);

describe("EnvStaleNote", () => {
  it("is nothing while the thread's environment is current", () => {
    renderNote({});
    expect(screen.queryByTestId("thread-env-stale")).toBeNull();
  });

  it("says the plugin environment changed, muted, with Restart to apply", () => {
    renderNote({ pluginEnvStale: true, pluginEnvChange: "Hello removed CF_HELLO" });
    const note = screen.getByTestId("thread-env-stale");
    expect(note.textContent).toBe("Plugin environment changed·Restartto apply");
    expect(note.className).toContain("text-cf-text-muted");
    expect(note.className).toContain("text-caption-sm");
  });

  it("Restart runs thread.restart, the registry's command", () => {
    renderNote({ pluginEnvStale: true, pluginEnvChange: "" });
    fireEvent.click(screen.getByTestId("thread-env-stale-restart"));
    expect(start).toHaveBeenCalledWith("thread.restart");
  });

  it("the tooltip names the change and says the process restarts and the conversation continues", () => {
    expect(envStaleTip("Hello removed CF_HELLO")).toBe(
      "Hello removed CF_HELLO.\nClaude is still running with the old environment. Restart restarts the Claude process with the new one; the conversation continues.",
    );
    expect(envStaleTip("")).not.toContain("\n");
  });
});
