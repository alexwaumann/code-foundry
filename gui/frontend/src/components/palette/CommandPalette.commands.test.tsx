import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgSpecView, CommandView, UiContextView } from "@/api/command";

/**
 * The daemon's List for a context: terminal commands are available with a terminal in it,
 * thread.new with a project; the rest always. Unavailable ones come too (the GUI asks for
 * them, for thread.new's picker); terminal.remove is a NoPalette verb.
 */
const listed = vi.hoisted(() => ({ commands: [] as CommandView[], contexts: [] as UiContextView[] }));
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  ...(await import("@/test/daemonFakes")).commandFakes,
  listCommands: (ctx: UiContextView) => {
    listed.contexts.push(ctx);
    return Promise.resolve(
      listed.commands.map((c) => ({ ...c, available: c.name.startsWith("terminal.") ? ctx.activeTerminalId !== "" : c.name === "thread.new" ? ctx.activeProjectId !== "" : true })),
    );
  },
}));

const { CommandPalette } = await import("./CommandPalette");
const { Toaster } = await import("@/components/ui/sonner");
const { invocationsOf, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { CF, FEAT, seedWorld } = await import("@/test/projectsWorld");
const { applyIntent } = await import("@/stores/intents");
const { useCommandsStore } = await import("@/stores/commands");
const { useTerminalsStore } = await import("@/stores/terminals");
const { useBottomStore } = await import("@/stores/bottomPanel");
const { HOME, useUiStore } = await import("@/stores/ui");

/**
 * The command palette over a faked List (e2e/app.spec.ts): what it lists for the context it
 * opened in, the chords on its rows, a command's arg prompts and their values, and the
 * openPalette and notify intents. e2e keeps cmd+shift+p reaching the app from a focused
 * xterm and the FocusProject reveal after worktree.create.
 */

const arg = (name: string, o: Partial<ArgSpecView> = {}): ArgSpecView => ({ name, type: "string", required: true, description: "", enumValues: [], defaultValue: "", ...o });
const cmd = (name: string, title: string, o: Partial<CommandView> = {}): CommandView => ({ name, title, description: "", category: "General", args: [], keybindings: [], available: true, ...o });

const COMMANDS: CommandView[] = [
  cmd("thread.new", "New Thread", { category: "Thread", keybindings: ["cmd+n"] }),
  cmd("terminal.new", "New Terminal", { category: "Terminal", keybindings: ["cmd+t"] }),
  cmd("terminal.kill", "Kill Terminal", { category: "Terminal" }),
  cmd("terminal.remove", "Remove Terminal", { category: "Terminal", noPalette: true }),
  cmd("project.refresh", "Refresh Project", { category: "Project" }),
  cmd("worktree.create", "Create Worktree", { category: "Project", args: [arg("branch", { description: "Branch name" })] }),
  cmd("theme.set-dark", "Set Dark Theme", { category: "Appearance", args: [arg("theme", { type: "enum", enumValues: ["catppuccin-mocha", "github-dark", "nord"], defaultValue: "nord" })] }),
];

const palette = () => screen.queryByTestId("palette");
const row = (name: string) => palette()?.querySelector<HTMLElement>(`[data-command="${name}"]`) ?? null;
const input = () => within(palette() as HTMLElement).getByRole("combobox");

async function settle(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function openPalette(query = "") {
  act(() => {
    useUiStore.getState().openPalette(query);
  });
  await settle();
}

async function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await settle();
}

async function enter() {
  fireEvent.keyDown(input(), { key: "Enter" });
  await settle();
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  listed.commands = COMMANDS;
  listed.contexts.length = 0;
  useCommandsStore.setState({ commands: [], contextKey: "", loading: false, error: null });
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
  act(() => {
    useUiStore.getState().closePalette();
    useUiStore.getState().select(HOME);
  });
  render(
    <>
      <CommandPalette />
      <Toaster />
    </>,
  );
});

afterEach(() => {
  act(() => {
    toast.dismiss();
    useUiStore.getState().closePalette();
  });
  cleanup();
});

describe("what the palette lists", () => {
  it("only commands startable in its context: thread.new by its picker with nothing selected; terminal ones with a shell; never a NoPalette verb", async () => {
    await openPalette();
    expect(listed.contexts.at(-1)).toMatchObject({ activeThreadId: "", activeTerminalId: "" });
    expect(row("thread.new")).not.toBeNull();
    expect(row("terminal.new")).toBeNull();
    expect(row("terminal.kill")).toBeNull();
    act(() => {
      useUiStore.getState().closePalette();
    });
    await settle();
    expect(palette()).toBeNull();

    // A thread's shell with the keyboard in it: the shell is the context's terminal.
    useTerminalsStore.setState({
      byId: { "t-s1-shell": { id: "t-s1-shell", argv: ["/bin/zsh"], cwd: CF, cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: null, exitedAtMs: null, altScreen: false, labels: { kind: "shell", thread: "s-1", project: "repo-cf", worktree: CF } } },
      order: ["t-s1-shell"],
      loaded: true,
    });
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
      useBottomStore.setState({ byKey: { "thread:s-1": { open: true, activeTerminalId: "t-s1-shell" } } });
      useUiStore.setState({ focus: "bottom" });
    });
    await openPalette();
    expect(listed.contexts.at(-1)).toMatchObject({ activeThreadId: "s-1", activeTerminalId: "t-s1-shell" });
    expect(row("terminal.kill")).not.toBeNull();
    expect(row("thread.new")).not.toBeNull();
    expect(row("terminal.remove")).toBeNull();
    // Keybindings are shown.
    expect(row("thread.new")?.textContent).toContain("⌘N");
  });
});

describe("arg prompts", () => {
  it("required args are asked inline, then the command runs in the context the palette opened in; enum args list their values, the default highlighted", async () => {
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-4" });
    });
    await openPalette();
    await type("create worktree");
    await enter();
    expect(palette()?.dataset.mode).toBe("args");
    await type("feat/palette");
    await enter();
    expect(palette()).toBeNull();
    const made = lastInvocation("worktree.create");
    expect(made?.args).toEqual({ branch: "feat/palette" });
    expect(made?.context.activeWorktreePath).toBe(FEAT);

    await openPalette();
    await type("set dark theme");
    await enter();
    const options = within(palette() as HTMLElement).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["catppuccin-mocha", "github-dark", "norddefault"]);
    expect(options.find((o) => o.getAttribute("aria-selected") === "true")?.textContent).toBe("norddefault");
    fireEvent.click(options[0] as HTMLElement);
    await settle();
    expect(palette()).toBeNull();
    expect(invocationsOf("theme.set-dark").map((i) => i.args)).toEqual([{ theme: "catppuccin-mocha" }]);
  });
});

describe("the openPalette and notify intents", () => {
  it("notify toasts its title and body; openPalette opens the palette on its query", async () => {
    act(() => {
      applyIntent({ kind: "notify", level: "warning", title: "Disk almost full", body: "3% left" });
    });
    await waitFor(() => {
      expect(screen.getByText("Disk almost full")).toBeTruthy();
    });
    expect(screen.getByText("3% left")).toBeTruthy();
    act(() => {
      applyIntent({ kind: "openPalette", query: "refresh" });
    });
    await settle();
    expect((input() as HTMLInputElement).value).toBe("refresh");
    expect(row("project.refresh")).not.toBeNull();
  });
});
