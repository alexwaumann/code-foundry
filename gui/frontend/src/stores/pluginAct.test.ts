import { describe, expect, it, vi } from "vitest";

const actOnSurface = vi.hoisted(() => vi.fn(() => Promise.resolve(3)));
vi.mock("@/api/plugin", async (orig) => ({ ...(await orig<typeof import("@/api/plugin")>()), actOnSurface }));

const { actOnElement, usePluginSurfacesStore } = await import("./pluginSurfaces");

// docs/notes/plugins-6-thread-terminal.md: an act carries the panel's context, so a shared
// instance (scope pr, project, global) knows which thread the click came from.
describe("actOnElement", () => {
  it("sends the watch's panel context with the act", async () => {
    const context = { activeThreadId: "s-viewer", activeProjectId: "p1", activeWorktreePath: "", activeTerminalId: "", activeView: "thread", activeWorkspaceId: "" };
    usePluginSurfacesStore.setState({
      watches: {
        w: { plugin: "hello", surface: "demo", instance: "hello/demo/pr:o/r#1", phase: "live", message: "", pluginState: "running", version: 2, view: { nodes: [] }, hostRendered: false, error: null, context },
      },
    });
    expect(await actOnElement("w", "ask-main")).toBe(true);
    expect(actOnSurface).toHaveBeenCalledWith({ instance: "hello/demo/pr:o/r#1", version: 2, key: "ask-main", context });
  });
});
