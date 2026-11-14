import { beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const runCommandForResult = vi.hoisted(() => vi.fn<(name: string, args: Record<string, string>, opts: unknown) => Promise<{ resultJson: string } | null>>(() => Promise.resolve({ resultJson: "" })));
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult }));

const { showPluginTerminal, terminalShown } = await import("./pluginTerminals");
const { resetLayout, useLayoutStore } = await import("./layout");

// docs/notes/plugins-6-thread-terminal.md: a plugin's terminal has a tab only once the user opens one.
describe("plugin terminals in tabs", () => {
  beforeEach(async () => {
    resetLayout();
    runCommandForResult.mockClear();
    await seedLayout(
      layoutOf([
        space(pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-clock", "terminal", "", { params: { terminal: "clock" } })], "t-th"), "p-1"),
        space(pane("p-2", [tab("t-other", "terminal", "", { params: { terminal: "other" } })], "t-other"), "p-2", { id: "sp-2", name: "Two" }),
      ]),
    );
  });

  it("Open in a tab asks the daemon to show the terminal (ui.focus.terminal), quietly", async () => {
    expect(await showPluginTerminal("clock")).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("ui.focus.terminal", { id: "clock" }, { quiet: true });
    runCommandForResult.mockResolvedValueOnce(null);
    expect(await showPluginTerminal("clock")).toBe(false);
  });

  it("a terminal counts as shown while its tab is its pane's active one in the current space", () => {
    const s = useLayoutStore.getState();
    expect(terminalShown(s, "clock")).toBe(false);
    expect(terminalShown(s, "other")).toBe(false);
    const p1 = s.panes["p-1"];
    if (!p1) throw new Error("no pane p-1");
    expect(terminalShown({ ...s, panes: { ...s.panes, "p-1": { ...p1, active: "t-clock" } } }, "clock")).toBe(true);
  });
});
