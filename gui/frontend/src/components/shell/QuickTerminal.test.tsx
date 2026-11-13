import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const calls: unknown[][] = [];
vi.mock("@/shell/terminalActions", async (orig) => ({
  ...(await orig<typeof import("@/shell/terminalActions")>()),
  runQuickAgain: (thread: string, terminal: string, command: string) => {
    calls.push(["runQuickAgain", thread, terminal, command]);
    return Promise.resolve();
  },
  forgetQuickRan: (thread: string) => {
    calls.push(["forgetQuickRan", thread]);
    return Promise.resolve();
  },
}));

const { ThreadWithQuick } = await import("./QuickTerminal");
const { resetLayout } = await import("@/stores/layout");
const { useTerminalsStore } = await import("@/stores/terminals");

function quickShell(id: string): TerminalView {
  return { id, argv: ["/bin/zsh", "-l"], cwd: "/w", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels: { kind: "shell", thread: "s-1", slot: "quick" }, liveCwd: "/w", foreground: "", lastCommand: "" };
}

async function seed(ran: string): Promise<void> {
  const l = layoutOf([space(pane("p-1", [tab("t-th", "thread", "s-1")]), "p-1")]);
  await seedLayout({ ...l, threads: [{ threadId: "s-1", spaceId: "sp-a", quick: { open: true, height: 0, ran }, remembered: [], rememberedPaneId: "" }] });
}

beforeEach(() => {
  calls.length = 0;
  resetLayout();
  useTerminalsStore.setState({ byId: { "term-q": quickShell("term-q") }, order: ["term-q"], loaded: true });
});

afterEach(() => {
  cleanup();
  resetLayout();
});

describe("the quick terminal", () => {
  it("shows no line when a snooze ended nothing", async () => {
    await seed("");
    render(<ThreadWithQuick threadId="s-1">conversation</ThreadWithQuick>);
    expect(screen.getByTestId("quick-terminal-host").getAttribute("data-terminal-id")).toBe("term-q");
    expect(screen.queryByTestId("terminal-ran-line")).toBeNull();
  });

  it("restored after a snooze: the last command and Run again, in its shell; × drops the line", async () => {
    await seed("npm run dev");
    render(<ThreadWithQuick threadId="s-1">conversation</ThreadWithQuick>);
    expect(screen.getByTestId("terminal-ran-line").textContent).toContain("npm run dev");
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByTestId("terminal-run-again"));
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(calls).toEqual([
      ["runQuickAgain", "s-1", "term-q", "npm run dev"],
      ["forgetQuickRan", "s-1"],
    ]);
  });
});
