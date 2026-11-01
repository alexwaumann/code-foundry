import { beforeEach, describe, expect, it } from "vitest";
import { mcpTab } from "@/surfaces/mcpTarget";
import { closePanelTab, makeTab, movePanelTabToGroup, openSurface, splitPanel, usePanelStore } from "./panel";
import { setMcpTab, useMcpTabsStore } from "./mcpTabs";

const chosen = () => useMcpTabsStore.getState().byKey;

beforeEach(() => {
  usePanelStore.setState({ byKey: {} });
  useMcpTabsStore.setState({ byKey: {} });
});

describe("the MCP surface's chosen tab", () => {
  it("is kept per panel while its MCP tab stays open, and dropped once it closes", () => {
    openSurface("thread:a", mcpTab());
    openSurface("thread:b", mcpTab());
    setMcpTab("thread:a", "failed");
    setMcpTab("thread:b", "disabled");
    expect(chosen()).toEqual({ "thread:a": "failed", "thread:b": "disabled" });

    // Another tab opening or closing in the panel keeps it.
    const other = makeTab("changes", "Changes", { project: "web", path: "/src/web" });
    openSurface("thread:a", other);
    closePanelTab("thread:a", other.id);
    expect(chosen()).toEqual({ "thread:a": "failed", "thread:b": "disabled" });

    closePanelTab("thread:a", mcpTab().id);
    expect(chosen()).toEqual({ "thread:b": "disabled" });
    // Reopened, it starts on Connected (no entry).
    openSurface("thread:a", mcpTab());
    expect(chosen()["thread:a"]).toBeUndefined();
  });

  it("follows the MCP tab into the panel's other group", () => {
    openSurface("thread:a", mcpTab());
    openSurface("thread:a", makeTab("changes", "Changes", { project: "web", path: "/src/web" }));
    setMcpTab("thread:a", "failed");
    splitPanel("thread:a");
    movePanelTabToGroup("thread:a", mcpTab().id, 1);
    expect(chosen()).toEqual({ "thread:a": "failed" });
  });

  it("is dropped with the panel itself", () => {
    openSurface("thread:a", mcpTab());
    setMcpTab("thread:a", "disabled");
    usePanelStore.setState({ byKey: {} });
    expect(chosen()).toEqual({});
  });
});
