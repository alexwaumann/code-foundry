import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpTab } from "@/surfaces/mcpTarget";
import { fileTab } from "@/surfaces/fileTarget";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { applyLayoutOp } = await import("@/api/layout");
const { layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { openTab } = await import("@/shell/host");
const { useLayoutStore } = await import("./layout");
const { setMcpTab, useMcpTabsStore } = await import("./mcpTabs");

const chosen = () => useMcpTabsStore.getState().byKey;

/** The layout id of thread `thread`'s tab of `kind`. */
const layoutId = (thread: string, kind: string): string => Object.values(useLayoutStore.getState().tabs).find((t) => t.thread === thread && t.kind === kind)?.id ?? "";

async function open(thread: string, tab: Parameters<typeof openTab>[1]): Promise<void> {
  openTab(`thread:${thread}`, tab);
  await layoutSettled();
}

async function op(o: Parameters<typeof applyLayoutOp>[0]): Promise<void> {
  await applyLayoutOp(o);
  await layoutSettled();
}

beforeEach(async () => {
  // Threads a and b, side by side in one pane.
  const seed = threadSeed("a");
  const root = seed.spaces[0]?.root;
  root?.tabs?.push({ id: "t-b", kind: "thread", thread: "b" });
  await resetFakeLayout(seed);
  useMcpTabsStore.setState({ byKey: {} });
});

const other = fileTab({ project: "web", base: "/src/web", path: "README.md" });

describe("the MCP surface's chosen tab", () => {
  it("is kept per thread while its MCP tab stays open, and dropped once it closes", async () => {
    await open("a", mcpTab());
    await open("b", mcpTab());
    setMcpTab("thread:a", "failed");
    setMcpTab("thread:b", "disabled");
    expect(chosen()).toEqual({ "thread:a": "failed", "thread:b": "disabled" });

    // Another of the thread's tabs opening or closing keeps it.
    await open("a", other);
    await op({ op: "close_tab", tab: layoutId("a", "file") });
    expect(chosen()).toEqual({ "thread:a": "failed", "thread:b": "disabled" });

    await op({ op: "close_tab", tab: layoutId("a", "mcp") });
    expect(chosen()).toEqual({ "thread:b": "disabled" });
    // Reopened, it starts on Connected (no entry).
    await open("a", mcpTab());
    expect(chosen()["thread:a"]).toBeUndefined();
  });

  it("follows the MCP tab into another pane", async () => {
    await open("a", mcpTab());
    await open("a", other);
    setMcpTab("thread:a", "failed");
    const mcp = layoutId("a", "mcp");
    const pane = Object.values(useLayoutStore.getState().panes).find((p) => p.tabIds.includes(mcp))?.id ?? "";
    await op({ op: "move_tab", tab: mcp, pane, edge: "bottom" });
    expect(Object.values(useLayoutStore.getState().panes).find((p) => p.tabIds.includes(mcp))?.id).not.toBe(pane);
    expect(chosen()).toEqual({ "thread:a": "failed" });
  });

  it("is dropped with the thread's tabs", async () => {
    await open("a", mcpTab());
    setMcpTab("thread:a", "disabled");
    await op({ op: "close_thread", thread: "a" });
    expect(chosen()).toEqual({});
  });
});
