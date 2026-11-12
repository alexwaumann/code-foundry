import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const calls: unknown[][] = [];
vi.mock("@/shell/terminalActions", async (orig) => ({
  ...(await orig<typeof import("@/shell/terminalActions")>()),
  runAgain: (t: { id: string }, command: string) => {
    calls.push(["runAgain", t.id, command]);
    return Promise.resolve();
  },
  forgetRan: (t: { id: string }) => {
    calls.push(["forgetRan", t.id]);
    return Promise.resolve();
  },
  renameTab: (id: string, name: string) => {
    calls.push(["rename", id, name]);
    return Promise.resolve();
  },
  autoNameTab: (id: string) => {
    calls.push(["auto", id]);
    return Promise.resolve();
  },
  resetTerminal: (id: string) => {
    calls.push(["reset", id]);
    return Promise.resolve();
  },
}));
vi.mock("@/shell/commands", async (orig) => ({
  ...(await orig<typeof import("@/shell/commands")>()),
  closeTabNow: (id: string) => {
    calls.push(["close", id]);
    return Promise.resolve(null);
  },
}));

const { TerminalTabBody, TabNameField } = await import("./TerminalTab");
const { TerminalCwdHint } = await import("./TerminalCwdHint");
const { useThreadsStore } = await import("@/stores/threads");
const { PaneTabStrip } = await import("./PaneTabStrip");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");
const { useTerminalsStore } = await import("@/stores/terminals");
const { beginTabRename, endTabRename, useTabRenameStore } = await import("@/shell/terminalActions");

function term(id: string, over: Partial<TerminalView> = {}): TerminalView {
  return { id, argv: ["/bin/zsh", "-l"], cwd: "/Users/dev/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels: { kind: "shell", thread: "s-1" }, liveCwd: "/Users/dev/src/app", foreground: "", lastCommand: "", ...over };
}

async function seed(params: Record<string, string>, name = ""): Promise<void> {
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-term", "terminal", "s-1", { params, name }), tab("t-free", "terminal", "", { params: { terminal: "term-2" } })]), "p-1")]));
}

const entry = (id = "t-term") => {
  const t = useLayoutStore.getState().tabs[id];
  if (!t) throw new Error(`no tab ${id}`);
  return t;
};

beforeEach(() => {
  calls.length = 0;
  resetLayout();
  useTerminalsStore.setState({ byId: { "term-1": term("term-1"), "term-2": term("term-2", { labels: { kind: "shell" }, liveCwd: "/Users/dev" }) }, order: ["term-1", "term-2"], loaded: true });
});

afterEach(() => {
  cleanup();
  endTabRename();
  resetLayout();
});

describe("a terminal tab's body", () => {
  it("attaches its terminal and shows no line when nothing was restored", async () => {
    await seed({ terminal: "term-1" });
    render(<TerminalTabBody tab={entry()} />);
    expect(screen.getByTestId("shell-terminal-host").getAttribute("data-terminal-id")).toBe("term-1");
    expect(screen.queryByTestId("terminal-ran-line")).toBeNull();
  });

  it("restored after a snooze: one line with the last command and Run again (a click, or Enter on the line); × drops it", async () => {
    await seed({ terminal: "term-1", ran: "make dev" });
    render(<TerminalTabBody tab={entry()} />);
    const line = screen.getByTestId("terminal-ran-line");
    expect(line.textContent).toContain("make dev");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByTestId("terminal-run-again"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(line, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls).toEqual([
      ["runAgain", "t-term", "make dev"],
      ["runAgain", "t-term", "make dev"],
      ["forgetRan", "t-term"],
    ]);
  });
});

describe("a terminal tab in its strip", () => {
  // The strip's tabs, not its hidden measuring row.
  const label = () => screen.getAllByRole("tab").map((t) => t.querySelector('[data-testid="shell-tab-label"]')?.textContent);

  it("is named by what runs in it, idle by its shell and folder, and a manual name sticks", async () => {
    await seed({ terminal: "term-1" });
    render(<PaneTabStrip paneId="p-1" focused />);
    expect(label()).toEqual(["zsh · app", "zsh · ~"]);
    act(() => {
      useTerminalsStore.setState((s) => ({ byId: { ...s.byId, "term-1": term("term-1", { foreground: "make dev" }) } }));
    });
    expect(label()[0]).toBe("make dev");
    await act(async () => {
      await seed({ terminal: "term-1" }, "server");
    });
    expect(label()[0]).toBe("server");
  });

  it("its context menu renames it, gives back its automatic name, and closes it", async () => {
    await seed({ terminal: "term-1" }, "server");
    render(<PaneTabStrip paneId="p-1" focused />);
    const first = screen.getAllByTestId("shell-tab")[0];
    if (!first) throw new Error("no tab");
    fireEvent.contextMenu(first);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Rename…", "Automatic name", "Close terminal"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Automatic name" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(calls).toEqual([["auto", "t-term"]]);
  });

  it("Rename… opens the name field once the menu has closed", async () => {
    await seed({ terminal: "term-1" }, "server");
    render(<PaneTabStrip paneId="p-1" focused />);
    const first = screen.getAllByTestId("shell-tab")[0];
    if (!first) throw new Error("no tab");
    fireEvent.contextMenu(first);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    expect(await screen.findByTestId("shell-tab-name-field")).toBeTruthy();
    expect(useTabRenameStore.getState().tabId).toBe("t-term");
  });

  it("Automatic name is off while the tab has no manual name", async () => {
    await seed({ terminal: "term-1" });
    render(<PaneTabStrip paneId="p-1" focused />);
    const first = screen.getAllByTestId("shell-tab")[0];
    if (!first) throw new Error("no tab");
    fireEvent.contextMenu(first);
    expect((await screen.findByRole("menuitem", { name: "Automatic name" })).getAttribute("data-disabled")).not.toBeNull();
  });

  it("cmd+r's field: Enter renames, Escape keeps the name, an empty name is the automatic one", async () => {
    await seed({ terminal: "term-1" }, "server");
    render(<PaneTabStrip paneId="p-1" focused />);
    act(() => {
      beginTabRename("t-term");
    });
    const field = screen.getByTestId("shell-tab-name-field");
    expect((field as HTMLInputElement).value).toBe("server");
    expect(field.getAttribute("placeholder")).toBe("zsh · app");
    fireEvent.change(field, { target: { value: "api" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(calls).toEqual([["rename", "t-term", "api"]]);
    expect(useTabRenameStore.getState().tabId).toBe("");

    act(() => {
      beginTabRename("t-term");
    });
    fireEvent.change(screen.getByTestId("shell-tab-name-field"), { target: { value: "other" } });
    fireEvent.keyDown(screen.getByTestId("shell-tab-name-field"), { key: "Escape" });
    expect(calls).toHaveLength(1);

    act(() => {
      beginTabRename("t-term");
    });
    fireEvent.change(screen.getByTestId("shell-tab-name-field"), { target: { value: "  " } });
    fireEvent.keyDown(screen.getByTestId("shell-tab-name-field"), { key: "Enter" });
    expect(calls.at(-1)).toEqual(["rename", "t-term", "  "]);
  });

  it("the field alone renders with the tab's name", async () => {
    await seed({ terminal: "term-1" }, "server");
    render(<TabNameField tab={entry()} />);
    expect(screen.getByDisplayValue("server")).toBe(screen.getByTestId("shell-tab-name-field"));
  });
});

describe("the directory hint", () => {
  beforeEach(() => {
    useThreadsStore.setState({ byId: { "s-1": { id: "s-1", worktreePath: "/Users/dev/src/app" } }, order: ["s-1"] } as never);
  });

  it("shows nothing while the shell is in its thread's directory, and for a shell of no thread", () => {
    const { container } = render(
      <>
        <TerminalCwdHint terminalId="term-1" />
        <TerminalCwdHint terminalId="term-2" />
      </>,
    );
    expect(container.textContent).toBe("");
  });

  it("after a cd, names the thread's directory and offers Reset, which resets that terminal", () => {
    useTerminalsStore.setState((s) => ({ byId: { ...s.byId, "term-1": term("term-1", { liveCwd: "/tmp" }) } }));
    render(<TerminalCwdHint terminalId="term-1" />);
    expect(screen.getByTestId("terminal-cwd-hint").textContent).toContain("thread is in ~/src/app");
    fireEvent.click(screen.getByTestId("terminal-cwd-reset"));
    expect(calls).toEqual([["reset", "term-1"]]);
  });
});
