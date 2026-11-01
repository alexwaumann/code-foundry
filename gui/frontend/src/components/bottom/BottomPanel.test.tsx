import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { TerminalView } from "@/api/terminal";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const { BottomPanel } = await import("./BottomPanel");
const { BottomToggle } = await import("./BottomToggle");
const { ProjectsPage } = await import("@/components/projects/ProjectsPage");
const { RowMenu } = await import("@/components/sidebar/RowMenu");
const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { daemon, invocationsOf, lastInvocation, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { attach } = await import("@/test/terminalHost");
const { ACTION_IDS, action, actionTerminal, fakeActionCommands, seedActions, terminalExited, terminalRemoved, terminalUpdated } = await import("@/test/actionsWorld");
const { CF, DOT, FEAT, GP, seedWorld } = await import("@/test/projectsWorld");
const { runAction } = await import("@/stores/actionActions");
const { closeEmptyPanels, newWorktreeTerminal, toggleBottomFromHere } = await import("@/stores/bottomActions");
const { getBottom, useBottomStore } = await import("@/stores/bottomPanel");
const { useCommandsStore } = await import("@/stores/commands");
const { useActionStopsStore } = await import("@/stores/actionStops");
const { useTerminalsStore } = await import("@/stores/terminals");
const { useThreadsStore } = await import("@/stores/threads");
const { PROJECTS_INDEX, projectPage, useUiStore } = await import("@/stores/ui");
const { tooltipText } = await import("@/test/tooltip");

/**
 * The bottom panel (docs/notes/bottom-panel-2-gui.md) over the real stores, with the real
 * TerminalHost on a renderer that draws nothing (src/test/terminalHost.ts): tabs, the
 * terminal host's attach, the exit overlay, the empty state, and an action run's tab with
 * its echo and status line (docs/notes/actions-2-gui.md). e2e/bottom-panel.spec.ts keeps
 * focus moving into xterm and back, Attach stream counts, the resize handle and chords.
 */

const S1_SHELL = "t-s1-shell";

function shell(id: string, o: { thread?: string; project?: string; worktree: string }, extra: Partial<TerminalView> = {}): TerminalView {
  const labels: Record<string, string> = { kind: "shell", project: o.project ?? "repo-cf", worktree: o.worktree };
  if (o.thread) labels.thread = o.thread;
  return { id, argv: ["/bin/zsh", "-l"], cwd: o.worktree, cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: Date.now(), exitedAtMs: null, altScreen: false, labels, ...extra };
}

/** The mock's seeded shells: s-1's, and one of the feat/sidebar worktree (the Projects page's). */
function seedShells(): void {
  const list = [shell(S1_SHELL, { thread: "s-1", worktree: CF }), shell("t-top", { worktree: FEAT })];
  useTerminalsStore.setState({ byId: Object.fromEntries(list.map((t) => [t.id, t])), order: list.map((t) => t.id), loaded: true });
}

const cmd = (name: string, title: string, keybindings: string[] = []): CommandView => ({ name, title, description: "", category: "Terminal", args: [], keybindings, available: true });

/** The daemon's terminal.new: a shell in the context's worktree, owned by its thread; or a refusal. */
let newSeq = 0;
function fakeTerminalNew(): { fail: string | null; hold: Promise<void> | null } {
  const ctl: { fail: string | null; hold: Promise<void> | null } = { fail: null, hold: null };
  daemon.handlers.set("terminal.new", async (inv) => {
    if (ctl.hold) await ctl.hold;
    if (ctl.fail) throw refuse(ctl.fail);
    const id = `t-new-${String(++newSeq)}`;
    const thread = inv.context.activeThreadId;
    const t = thread
      ? shell(id, { thread, project: inv.context.activeProjectId, worktree: inv.context.activeWorktreePath })
      : shell(id, { project: inv.context.activeProjectId, worktree: inv.context.activeWorktreePath });
    terminalUpdated(t);
    return { message: `created terminal ${id}`, resultJson: JSON.stringify({ id }) };
  });
  return ctl;
}

const worktreeOf = (threadId: string) => (threadId === "s-2" ? { projectId: "repo-gp", worktree: GP } : { projectId: "repo-cf", worktree: CF });

const bottom = () => screen.queryByTestId("bottom-panel");
const tabs = () => within(screen.getByTestId("bottom-tabs")).queryAllByRole("tab");
const tabTexts = () => tabs().map((t) => t.textContent);
const tabOf = (id: string) => document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
const host = () => screen.getByTestId("bottom-terminal-host");
const status = () => screen.getByTestId("action-status");
const label = () => screen.getByTestId("action-status-label").textContent;
const time = () => within(status()).getByTestId("action-status-time").textContent;

/** Lets commands answer, streams open and React render. */
async function settle(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function select(sel: Parameters<ReturnType<typeof useUiStore.getState>["select"]>[0]) {
  act(() => {
    useUiStore.getState().select(sel);
  });
}

/** A sidebar row's context menu: New terminal here. */
async function newTerminalHere(id: string) {
  // The row menu reads the thread's plugin flags (src/test/projectsWorld.ts's threads have none).
  act(() => {
    useThreadsStore.setState((st) => ({ byId: { ...st.byId, [id]: { ...(st.byId[id] as ThreadView), flags: [] } } }));
  });
  const menu = render(
    <ContextMenu>
      <ContextMenuTrigger data-testid={`row-${id}`}>row</ContextMenuTrigger>
      <RowMenu id={id} />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId(`row-${id}`));
  fireEvent.click(screen.getByRole("menuitem", { name: "New terminal here" }));
  await settle();
  menu.unmount();
}

function renderPanel() {
  return render(
    <>
      <BottomToggle />
      <BottomPanel columnHeight={800} />
    </>,
  );
}

beforeEach(() => {
  resetDaemon();
  attach.reset();
  seedWorld();
  seedActions();
  seedShells();
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
  useActionStopsStore.setState({ byId: {} });
  // refreshCommands (after every command) lists them again from the fake.
  daemon.commands = [cmd("terminal.new", "New Terminal", ["cmd+t"]), cmd("view.bottom.toggle", "Toggle Bottom Panel", ["cmd+j"])];
  useCommandsStore.setState({ commands: daemon.commands });
  useUiStore.setState({ focus: "content", bottomFocusSeq: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("an action run's tab (e2e/actions.spec.ts)", () => {
  it("runs for the thread in its panel: the name, the echo, Running with its clock, then the failure with its duration and Rerun, no exit overlay", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    fakeActionCommands(worktreeOf);
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    expect(bottom()).toBeNull();

    let id = "";
    await act(async () => {
      id = (await runAction(ACTION_IDS.test, { kind: "thread", threadId: "s-1" })) ?? "";
    });
    await settle();
    expect(invocationsOf("action.run").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ action: ACTION_IDS.test, terminal: "true" }, "s-1"]]);
    expect(bottom()).not.toBeNull();
    expect(tabTexts()).toEqual(["code-foundry", "Test"]);
    const tab = tabOf(id) as HTMLElement;
    expect(tab.dataset.kind).toBe("action");
    expect(within(tab).getByRole("tab").getAttribute("aria-selected")).toBe("true");
    expect(host().dataset.terminalId).toBe(id);
    // The command, dimmed, above the output; the status line under it from the start.
    expect(screen.getByTestId("action-echo").textContent).toBe("$ go test ./...");
    expect(within(tab).getByTestId("action-tab-status").dataset.status).toBe("running");
    expect(status().dataset.status).toBe("running");
    expect(label()).toBe("Running");
    expect(time()).toBe("0:00");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(time()).toBe("0:02");
    expect(screen.getByTestId("action-stop")).toBeTruthy();

    // The test fails after 2.6 s: a red x on the tab, the line says so, with Rerun; no overlay.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    terminalExited(id, 1);
    act(() => {
      attach.exit(id, 1);
    });
    await settle();
    expect(within(tab).getByTestId("action-tab-status").dataset.status).toBe("failed");
    expect(status().dataset.status).toBe("failed");
    expect(label()).toBe("Exited with code 1");
    expect(time()).toBe("2.6s");
    expect(screen.getByTestId("action-rerun")).toBeTruthy();
    expect(screen.queryByTestId("action-stop")).toBeNull();
    expect(host().dataset.attachPhase).toBe("exited");
    expect(screen.queryByTestId("exit-overlay")).toBeNull();
    // An action tab is not struck through like an exited shell's.
    expect(tab.dataset.exited).toBeUndefined();
  });

  it("Stop keeps the tab, Stopped; Rerun replaces it with a new run; a passing run's check; × closes it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    fakeActionCommands(worktreeOf);
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    let dev = "";
    await act(async () => {
      dev = (await runAction(ACTION_IDS.dev, { kind: "thread", threadId: "s-1" })) ?? "";
    });
    await settle();
    expect(screen.getByTestId("action-echo").textContent).toBe("$ pnpm dev");
    expect(status().dataset.status).toBe("running");
    act(() => {
      vi.advanceTimersByTime(1_200);
    });
    fireEvent.click(screen.getByTestId("action-stop"));
    await settle();
    expect(invocationsOf("terminal.kill").map((i) => [i.args, i.confirmed])).toEqual([[{ id: dev }, true]]);
    // Exited 129 after Stop: "Stopped", neutral (not the red failure), with Rerun.
    expect(status().dataset.status).toBe("stopped");
    expect(label()).toBe("Stopped");
    expect(time()).toBe("1.2s");
    expect(within(tabOf(dev) as HTMLElement).getByTestId("action-tab-status").dataset.status).toBe("stopped");
    expect(screen.getByTestId("action-rerun")).toBeTruthy();

    // Rerun: a new run of the same action for the same thread; the old tab goes, the new one is active.
    fireEvent.click(screen.getByTestId("action-rerun"));
    await settle();
    const runs = invocationsOf("action.run");
    expect(runs).toHaveLength(2);
    expect(runs[1]?.args).toEqual({ action: ACTION_IDS.dev, terminal: "true" });
    expect(runs[1]?.context.activeThreadId).toBe("s-1");
    expect(invocationsOf("terminal.close").map((i) => i.args)).toEqual([{ id: dev }]);
    expect(tabOf(dev)).toBeNull();
    const fresh = document.querySelectorAll<HTMLElement>('[data-kind="action"]');
    expect(fresh).toHaveLength(1);
    const freshId = fresh[0]?.dataset.tabId ?? "";
    expect(freshId).not.toBe(dev);
    expect(within(fresh[0] as HTMLElement).getByRole("tab").getAttribute("aria-selected")).toBe("true");
    expect(host().dataset.terminalId).toBe(freshId);
    expect(status().dataset.status).toBe("running");

    // A finished run that exits 0: the green check, the duration, Rerun.
    let build = "";
    await act(async () => {
      build = (await runAction(ACTION_IDS.build, { kind: "thread", threadId: "s-1" })) ?? "";
    });
    await settle();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    terminalExited(build, 0);
    expect(within(tabOf(build) as HTMLElement).getByTestId("action-tab-status").dataset.status).toBe("ok");
    expect(label()).toBe("Exited with code 0");
    expect(status().dataset.status).toBe("ok");
    expect(time()).toBe("1.5s");

    // × closes it through terminal.close, like a shell's tab.
    fireEvent.click(screen.getByRole("button", { name: "Close Build" }));
    await settle();
    expect(tabOf(build)).toBeNull();
    expect(invocationsOf("terminal.close").map((i) => i.args.id)).toContain(build);
  });

  it("Stop on a run that ignores SIGHUP: Stopping… (Stop disabled) until the SIGKILL's exit, then Stopped", async () => {
    fakeActionCommands(worktreeOf, { killExits: false });
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    let debug = "";
    await act(async () => {
      debug = (await runAction(ACTION_IDS.debug, { kind: "thread", threadId: "s-1" })) ?? "";
    });
    await settle();
    expect(status().dataset.status).toBe("running");
    fireEvent.click(screen.getByTestId("action-stop"));
    await settle();
    expect(status().dataset.status).toBe("stopping");
    expect(label()).toBe("Stopping…");
    expect(screen.getByTestId<HTMLButtonElement>("action-stop").disabled).toBe(true);
    expect(within(tabOf(debug) as HTMLElement).getByTestId("action-tab-status").dataset.status).toBe("stopping");
    // The daemon's SIGKILL after its grace period: exit 137, still "Stopped" (the user pressed Stop).
    terminalExited(debug, 137);
    expect(status().dataset.status).toBe("stopped");
    expect(label()).toBe("Stopped");
    expect(invocationsOf("terminal.kill").map((i) => i.args)).toEqual([{ id: debug }]);
    expect(invocationsOf("action.run")[0]?.args).toEqual({ action: ACTION_IDS.debug, terminal: "true" });
  });

  it("an action an agent ran (no run of this window's) shows up as a tab of its thread's panel, its echo from argv", async () => {
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    const check = action(ACTION_IDS.check, "repo-cf", "Check", "make check", "lint");
    terminalUpdated(actionTerminal("t-agent", check, "r-agent", { threadId: "s-1", projectId: "repo-cf", worktree: CF }));
    await settle();
    expect(bottom()).not.toBeNull();
    expect([...document.querySelectorAll('[data-kind="action"]')].map((e) => e.textContent)).toEqual(["Check"]);
    expect(screen.getByTestId("action-echo").textContent).toBe("$ make check");
  });

  it("a worktree's run (a Projects page row) opens in the Projects page's panel", async () => {
    fakeActionCommands(worktreeOf);
    select(projectPage("repo-cf"));
    renderPanel();
    await act(async () => {
      await runAction(ACTION_IDS.build, { kind: "worktree", projectId: "repo-cf", path: CF });
    });
    await settle();
    expect(invocationsOf("action.run").map((i) => [i.args, i.context.activeProjectId, i.context.activeWorktreePath, i.context.activeThreadId])).toEqual([[{ action: ACTION_IDS.build, terminal: "true" }, "repo-cf", CF, ""]]);
    expect(bottom()?.dataset.panelKey).toBe("view:projects");
    expect([...document.querySelectorAll('[data-kind="action"]')].map((e) => e.textContent)).toEqual(["Build"]);
    expect(screen.getByTestId("action-echo").textContent).toBe("$ make build");
  });
});

describe("shells", () => {
  it("a shell that exits shows the exit overlay and a struck-through tab until the reaper removes it (e2e/app.spec.ts)", async () => {
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(host().dataset.terminalId).toBe(S1_SHELL);
    expect(host().dataset.attachPhase).toBe("live");
    expect(screen.queryByTestId("exit-overlay")).toBeNull();
    // Exited, not reaped yet: the attach stream's exit frame, then the terminal's state.
    act(() => {
      attach.exit(S1_SHELL, 1);
    });
    terminalExited(S1_SHELL, 1);
    await settle();
    expect(within(bottom() as HTMLElement).getByTestId("exit-overlay").textContent).toContain("Process exited with code 1");
    expect(tabOf(S1_SHELL)?.dataset.exited).toBe("true");
    // Reaped: the tab goes, and as the last one, the panel with it.
    terminalRemoved(S1_SHELL);
    await settle();
    expect(bottom()).toBeNull();
    expect(screen.getByTestId("bottom-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Projects page's panel lists the worktree shells; its + starts one in the active tab's worktree; a row's New terminal here lands there too", async () => {
    fakeTerminalNew();
    select(PROJECTS_INDEX);
    renderPanel();
    expect(screen.getByTestId("bottom-toggle").getAttribute("aria-pressed")).toBe("false");
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(screen.getByTestId("bottom-toggle").getAttribute("aria-pressed")).toBe("true");
    // t-top (feat/sidebar), titled by its worktree's folder; thread shells are not here.
    expect(tabTexts()).toEqual(["feat-sidebar"]);
    expect(tooltipText(tabs()[0] as HTMLElement)).toBe("~/src/code-foundry.worktrees/feat-sidebar");
    expect(host().dataset.terminalId).toBe("t-top");

    fireEvent.click(screen.getByTestId("bottom-new-terminal"));
    await settle();
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FEAT, activeThreadId: "" });
    expect(tabTexts()).toEqual(["feat-sidebar", "feat-sidebar 2"]);
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(useUiStore.getState().selection).toEqual(PROJECTS_INDEX);

    // A checkout row's New terminal here, on another project's page, lands in the same panel.
    cleanup();
    select(projectPage("repo-dot"));
    render(
      <>
        <ProjectsPage />
        <BottomPanel columnHeight={800} />
      </>,
    );
    await settle();
    fireEvent.click(document.querySelector(`[data-nav-key="pw:repo-dot::${DOT}"] [data-testid="worktree-new-terminal"]`) as HTMLElement);
    await settle();
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-dot", activeWorktreePath: DOT, activeThreadId: "" });
    expect(tabTexts()).toEqual(["feat-sidebar", "feat-sidebar 2", "dotfiles"]);
    expect(tabs()[2]?.getAttribute("aria-selected")).toBe("true");
  });

  it("a project page's Terminal (a worktree's shell): the Projects page's panel, no toast (e2e/terminal-routing.spec.ts)", async () => {
    fakeTerminalNew();
    select(projectPage("repo-cf"));
    renderPanel();
    await act(async () => {
      await newWorktreeTerminal("repo-cf", CF);
    });
    await settle();
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF, activeThreadId: "" });
    // t-top (feat/sidebar) and the new one (main).
    expect(tabTexts()).toEqual(["feat-sidebar", "code-foundry"]);
    expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("a thread row's New terminal here: the thread owns the shell, in its panel; the selection stays (e2e/terminal-routing.spec.ts)", async () => {
    fakeTerminalNew();
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    await newTerminalHere("s-2");
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeThreadId: "s-2", activeView: "thread" });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(bottom()).toBeNull();
    select({ kind: "thread", id: "s-2" });
    await settle();
    expect(tabs()).toHaveLength(1);
    expect(host().dataset.attachPhase).toBe("live");
    // s-1 has its shell already: a second tab.
    await newTerminalHere("s-1");
    select({ kind: "thread", id: "s-1" });
    await settle();
    expect(tabs()).toHaveLength(2);
  });

  it("a new shell opens its owner's panel with it active, whether or not the owner is selected; the keyboard stays put", async () => {
    select({ kind: "thread", id: "s-1" });
    renderPanel();
    const seq = useUiStore.getState().bottomFocusSeq;
    // Started elsewhere (a CLI, another window): no focus intent.
    terminalUpdated(shell("t-mine", { thread: "s-1", worktree: CF }));
    await settle();
    expect(bottom()).not.toBeNull();
    expect(tabs()).toHaveLength(2);
    expect(host().dataset.terminalId).toBe("t-mine");
    expect(within(tabOf("t-mine") as HTMLElement).getByRole("tab").getAttribute("aria-selected")).toBe("true");
    expect(useUiStore.getState().bottomFocusSeq).toBe(seq);
    expect(useUiStore.getState().focus).toBe("content");

    // For s-2, which is not selected: nothing changes here, but its panel is open on it.
    terminalUpdated(shell("t-other", { thread: "s-2", project: "repo-gp", worktree: GP }));
    await settle();
    expect(host().dataset.terminalId).toBe("t-mine");
    select({ kind: "thread", id: "s-2" });
    await settle();
    expect(bottom()).not.toBeNull();
    expect(host().dataset.terminalId).toBe("t-other");
  });
});

describe("cmd+j and the empty state", () => {
  it("on a thread without shells it opens at once, blank, then the shell; its exit hides the panel; the next one starts fresh; hiding closes nothing", async () => {
    const ctl = fakeTerminalNew();
    let release: () => void = () => undefined;
    ctl.hold = new Promise((r) => (release = r));
    select({ kind: "thread", id: "s-2" });
    renderPanel();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    // terminal.new takes a moment: no "No terminals" flash meanwhile.
    expect(bottom()).not.toBeNull();
    expect(screen.getByTestId("bottom-body").dataset.starting).toBe("true");
    expect(screen.queryByTestId("bottom-empty")).toBeNull();
    ctl.hold = null;
    release();
    await settle();
    expect(tabTexts()).toEqual(["ghostty-playground"]);
    expect(screen.getByTestId("bottom-body").dataset.starting).toBeUndefined();
    const first = host().dataset.terminalId ?? "";
    expect(first).toMatch(/^t-new-/);
    const started = invocationsOf("terminal.new");
    expect(started).toHaveLength(1);
    expect(started[0]?.context).toMatchObject({ activeThreadId: "s-2" });
    expect(useUiStore.getState().bottomFocusSeq).toBeGreaterThan(0);

    // The shell exits: its tab goes, and with it the panel.
    act(() => {
      useUiStore.setState({ focus: "bottom" });
    });
    const content = useUiStore.getState().contentFocusSeq;
    terminalRemoved(first);
    await settle();
    expect(bottom()).toBeNull();
    expect(useUiStore.getState().contentFocusSeq).toBe(content + 1);

    // Again: a fresh shell, not the empty state.
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(tabs()).toHaveLength(1);
    expect(host().dataset.terminalId).toMatch(/^t-new-/);
    expect(host().dataset.terminalId).not.toBe(first);
    // Hiding stays a plain hide: no shell is closed or started.
    const before = daemon.invocations.length;
    act(() => {
      toggleBottomFromHere();
    });
    expect(bottom()).toBeNull();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(tabs()).toHaveLength(1);
    expect(daemon.invocations.length).toBe(before);
  });

  it("the Projects page: its last shell exiting hides the panel; opening it then shows the empty state's hint and starts nothing", async () => {
    fakeTerminalNew();
    select(PROJECTS_INDEX);
    renderPanel();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(tabTexts()).toEqual(["feat-sidebar"]);
    terminalRemoved("t-top");
    await settle();
    expect(bottom()).toBeNull();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    expect(screen.getByTestId("bottom-empty").textContent).toContain("Start one with New terminal on a project or worktree row.");
    expect(screen.queryByTestId("bottom-empty-new")).toBeNull();
    expect(invocationsOf("terminal.new")).toHaveLength(0);
  });

  it("a persisted open panel whose shells are gone comes back closed (the startup List's closeEmptyPanels)", async () => {
    // As rehydrated from localStorage: s-2's panel open, and s-2 has no shells.
    act(() => {
      useBottomStore.setState({ byKey: { "thread:s-2": { open: true } } });
    });
    select({ kind: "thread", id: "s-2" });
    renderPanel();
    act(() => {
      closeEmptyPanels();
    });
    await settle();
    expect(bottom()).toBeNull();
    expect(getBottom("thread:s-2").open).toBe(false);
    expect(screen.getByTestId("bottom-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("when terminal.new fails, the empty state is the fallback: its button retries; cmd+w on it hides the panel", async () => {
    const ctl = fakeTerminalNew();
    ctl.fail = "no shell for you";
    select({ kind: "thread", id: "s-2" });
    renderPanel();
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    const empty = screen.getByTestId("bottom-empty");
    expect(empty.textContent).toContain("No terminals");
    expect(within(empty).getByTestId("bottom-empty-new").textContent).toBe("New Terminal⌘T");
    expect(tabs()).toHaveLength(0);
    expect(host().parentElement?.classList.contains("hidden")).toBe(true);
    // cmd+w with no tabs hides the panel and hands the keyboard to the content pane.
    const content = useUiStore.getState().contentFocusSeq;
    fireEvent.keyDown(screen.getByTestId("bottom-panel"), { key: "w", code: "KeyW", metaKey: true });
    await settle();
    expect(bottom()).toBeNull();
    expect(useUiStore.getState().contentFocusSeq).toBe(content + 1);
    // It fails again (the empty state once more); its button then starts one.
    ctl.fail = "again";
    act(() => {
      toggleBottomFromHere();
    });
    await settle();
    ctl.fail = null;
    fireEvent.click(screen.getByTestId("bottom-empty-new"));
    await settle();
    expect(tabs()).toHaveLength(1);
    expect(invocationsOf("terminal.new")).toHaveLength(3);
  });
});
