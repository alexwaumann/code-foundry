import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemon, invocationsOf, refuse, resetDaemon } from "@/test/daemonFakes";
import { resetCard, seedChildServer, seedServers, updateThread } from "@/test/threadInfoWorld";
import { terminalExited, terminalRemoved } from "@/test/actionsWorld";
import { addThreads, thread } from "@/test/projectsWorld";
import { layoutOf, pane, row as splitRow, seedLayout, space, tab } from "@/test/shellLayout";
import { tooltipText } from "@/test/tooltip";
import { useActionsStore } from "@/stores/actions";
import { useShellViewStore } from "@/stores/shellView";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ShellsGroup } from "./ShellsGroup";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

/**
 * The servers of a thread and of the threads below it (docs/notes/server-rollup.md): which
 * rows, their words, what a click and the two buttons run, and when a row leaves. What needs
 * a browser (xterm attaching, the keyboard landing in it, Attach counts, hover) stays in
 * e2e/server-rollup.spec.ts.
 */

const rows = () => screen.queryAllByTestId("ti-server");
const row = (port: number) => {
  const el = rows().find((r) => r.dataset.port === String(port));
  if (!el) throw new Error(`no row for ${String(port)}`);
  return el;
};
const words = (el: HTMLElement) =>
  [...within(el).getByTestId("ti-server-line").children]
    .map((c) => c.textContent.replace(/\s+/g, " ").trim())
    .join(" ");
const buttonOf = (el: HTMLElement, id: string) => {
  const b = el.parentElement?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!b) throw new Error(id);
  return b;
};
const opened = () => invocationsOf("view.open.url").map((i) => i.args.url);
/** The terminals a click asked the daemon to show (ui.focus.terminal). */
const shown = () => invocationsOf("ui.focus.terminal").map((i) => i.args.id);
const setRun = (id: string, o: { running?: boolean; ports?: number[] }) => {
  act(() => {
    useActionsStore.setState((s) => {
      const r = s.runs[id];
      return r ? { runs: { ...s.runs, [id]: { ...r, ...o } } } : s;
    });
  });
};

async function renderGroup(id: string) {
  const r = render(
    <>
      <ShellsGroup threadId={id} />
      <Toaster />
    </>,
  );
  await act(async () => {
    await new Promise((res) => setTimeout(res, 0));
  });
  return r;
}

beforeEach(() => {
  resetDaemon();
  resetCard();
  useTerminalsStore.setState({ byId: {}, order: [], loaded: true });
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("the flat list", () => {
  it("the parent's card: its own run, then the child's; no headings; the port both report is one row", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    expect(rows().map((r) => r.dataset.port)).toEqual(["7788", "9399", "5173"]);
    expect(words(row(7788))).toMatch(/^make dev · Debug daemon action · 1m( \ds)?$/);
    expect(words(row(9399))).toMatch(/^python3 -m http.server 9399 · Serve the web preview · 1m 1\ds$/);
    expect(words(row(5173))).toMatch(/^pnpm dev · Dev action · Serve the web preview · 1m 4\ds$/);
    expect(within(row(5173)).getByTestId("ti-server-meta").textContent).toBe("+1");
    expect(screen.getByTestId("ti-shells-group").textContent).not.toMatch(/Children|Descendants/);
  });

  it("the child's card: its own servers name no thread", async () => {
    const { child } = seedChildServer();
    await renderGroup(child);
    expect(rows().map((r) => r.dataset.port)).toEqual(["9399", "5173"]);
    expect(words(row(5173))).toMatch(/^pnpm dev · Dev action · 1m 4\ds$/);
    expect(words(row(9399))).toMatch(/^python3 -m http.server 9399 · 1m 1\ds$/);
  });

  it("a grandchild's server rolls up to the top; a fork's does not", async () => {
    const { parent, child } = seedChildServer();
    addThreads(
      thread("s-grand", { name: "Grandchild", createdBy: child, backgroundShells: [{ taskId: "g1", description: "", command: "serve", startedAtMs: 1, ports: [4000] }] }),
      thread("s-fork", { name: "Fork", parentId: parent, backgroundShells: [{ taskId: "f1", description: "", command: "serve", startedAtMs: 1, ports: [4001] }] }),
    );
    await renderGroup(parent);
    expect(rows().map((r) => r.dataset.port)).toContain("4000");
    expect(rows().map((r) => r.dataset.port)).not.toContain("4001");
    expect(row(4000).dataset.owner).toBe("s-grand");
  });

  it("the fold stays this thread's: a child's other shells are not counted", async () => {
    const { parent, child } = seedChildServer();
    updateThread(parent, { backgroundShells: [] });
    await renderGroup(parent);
    expect(screen.queryByTestId("ti-shells")).toBeNull();
    cleanup();
    await renderGroup(child);
    expect(screen.getByTestId("ti-shells").textContent).toContain("1 more shell");
  });

  it("a run still waiting on its first port, and a run of a worktree, have no row", async () => {
    const { parent, debugRun } = seedChildServer();
    setRun(debugRun, { ports: [] });
    await renderGroup(parent);
    expect(rows().map((r) => r.dataset.port)).toEqual(["9399", "5173"]);
  });

  it("a thread without a worktree lists its child's servers all the same", async () => {
    const { child } = seedChildServer();
    addThreads(thread("s-home", { name: "No project", projectId: "", worktreePath: "", backgroundShells: [] }));
    updateThread(child, { createdBy: "s-home" });
    await renderGroup("s-home");
    expect(rows().map((r) => r.dataset.port)).toEqual(["9399", "5173"]);
  });

  it("the hover card lists every port and what the row hides: the whole command, the owning thread", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    const card = tooltipText(row(5173));
    expect(card).toContain("localhost:5173localhost:24678");
    expect(card).toContain("pnpm dev");
    expect(card).toContain("Serve the web preview");
  });

  it("the hover card of this thread's own server names no thread", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    expect(tooltipText(row(7788))).not.toContain("Fix the stale PR badge");
  });
});

describe("a row's click", () => {
  it("a terminal run: its tab, shown (ui.focus.terminal) with the keyboard in it; the selection stays, no browser", async () => {
    const { parent, devTerminal } = seedChildServer();
    // The run's tab, in a second pane.
    await seedLayout(layoutOf([space(splitRow("r-1", [pane("p-1", [tab("t-th", "thread", parent)]), pane("p-2", [tab("t-tab-dev", "terminal", "", { params: { terminal: devTerminal } })])]), "p-1")]));
    useUiStore.getState().select({ kind: "thread", id: parent });
    await renderGroup(parent);
    expect(shown()).toEqual([]);
    fireEvent.click(row(5173));
    await waitFor(() => {
      expect(useShellViewStore.getState().focusRequest.paneId).toBe("p-2");
    });
    expect(shown()).toEqual([devTerminal]);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: parent });
    expect(opened()).toEqual([]);
  });

  it("Enter does the same", async () => {
    const { parent, devTerminal } = seedChildServer();
    await renderGroup(parent);
    fireEvent.keyDown(row(5173), { key: "Enter" });
    await waitFor(() => {
      expect(shown()).toEqual([devTerminal]);
    });
  });

  it("a background run and a shell open the browser", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    fireEvent.click(row(7788));
    fireEvent.click(row(9399));
    await waitFor(() => {
      expect(opened()).toEqual(["http://localhost:7788", "http://localhost:9399"]);
    });
    expect(shown()).toEqual([]);
  });

  it("a terminal the store lost opens the browser rather than nothing", async () => {
    const { parent, devTerminal } = seedChildServer();
    await renderGroup(parent);
    terminalRemoved(devTerminal);
    fireEvent.click(row(5173));
    await waitFor(() => {
      expect(opened()).toEqual(["http://localhost:5173"]);
    });
  });
});

describe("the row's buttons", () => {
  it("↗ opens the first port in the browser, whatever the row's click does", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    fireEvent.click(buttonOf(row(5173), "ti-server-open"));
    await waitFor(() => {
      expect(opened()).toEqual(["http://localhost:5173"]);
    });
    expect(shown()).toEqual([]);
  });

  it("■ on a child's shell stops it through the child, once for a double press", async () => {
    const { parent, child } = seedChildServer();
    await renderGroup(parent);
    const stop = buttonOf(row(9399), "ti-server-stop");
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => {
      expect(invocationsOf("thread.shell.stop").map((i) => [i.args.id, i.args.task])).toEqual([[child, "bd9r3t6w1"]]);
    });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(opened()).toEqual([]);
  });

  it("■ on a terminal run kills its terminal; the row leaves when the run ends and the tab stays", async () => {
    const { parent, devRun, devTerminal } = seedChildServer();
    await renderGroup(parent);
    fireEvent.click(row(5173));
    const stop = buttonOf(row(5173), "ti-server-stop");
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => {
      expect(invocationsOf("terminal.kill").map((i) => [i.args.id, i.confirmed])).toEqual([[devTerminal, true]]);
    });
    terminalExited(devTerminal, 129);
    setRun(devRun, { running: false, ports: [] });
    expect(rows().map((r) => r.dataset.run)).not.toContain(devRun);
    expect(invocationsOf("terminal.close")).toEqual([]);
  });

  it("■ on a background run runs action.stop, once", async () => {
    const { parent, debugRun } = seedChildServer();
    await renderGroup(parent);
    const stop = buttonOf(row(7788), "ti-server-stop");
    fireEvent.click(stop);
    fireEvent.click(stop);
    await waitFor(() => {
      expect(invocationsOf("action.stop").map((i) => i.args.run)).toEqual([debugRun]);
    });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
  });

  it("a stop that fails gives the square back", async () => {
    const { parent } = seedChildServer();
    daemon.handlers.set("action.stop", () => {
      throw refuse("no such run");
    });
    await renderGroup(parent);
    const stop = buttonOf(row(7788), "ti-server-stop");
    fireEvent.click(stop);
    await waitFor(() => {
      expect(stop.getAttribute("aria-disabled")).toBe("false");
    });
  });

  it("names what it stops and promises nothing about the port", async () => {
    const { parent } = seedChildServer();
    await renderGroup(parent);
    expect(tooltipText(buttonOf(row(5173), "ti-server-stop"))).toBe("Stop action");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(tooltipText(buttonOf(row(9399), "ti-server-stop"))).toBe("Stop shell");
    expect(buttonOf(row(5173), "ti-server-stop").getAttribute("aria-label")).toBe("Stop the action on localhost:5173");
    expect(buttonOf(row(9399), "ti-server-open").getAttribute("aria-label")).toBe("Open localhost:9399 in the browser");
  });
});

describe("rows leave by themselves", () => {
  it("a run ending while the row is hovered takes it away", async () => {
    const { parent, debugRun } = seedChildServer();
    await renderGroup(parent);
    fireEvent.pointerEnter(row(7788));
    setRun(debugRun, { running: false, ports: [] });
    expect(rows().map((r) => r.dataset.port)).toEqual(["9399", "5173"]);
  });

  it("a stopped source's port comes back on the source it hid", async () => {
    const { child, devRun } = seedChildServer();
    await renderGroup(child);
    expect(rows().map((r) => r.dataset.task ?? r.dataset.run)).toEqual(["bd9r3t6w1", devRun]);
    setRun(devRun, { running: false, ports: [] });
    expect(rows().map((r) => r.dataset.task)).toEqual(["bk4v8n2p7", "bd9r3t6w1"]);
  });

  it("an archived child's rows go, before its shells and runs have even ended", async () => {
    const { parent, child } = seedChildServer();
    await renderGroup(parent);
    updateThread(child, { archivedAtMs: Date.now() });
    expect(rows().map((r) => r.dataset.port)).toEqual(["7788"]);
  });

  it("a removed creator ends the rollup: the card above no longer lists the orphan, which lists its own", async () => {
    const { parent, child } = seedChildServer();
    addThreads(thread("s-top", { name: "Top", backgroundShells: [] }));
    updateThread(parent, { createdBy: "s-top" });
    await renderGroup("s-top");
    expect(rows().map((r) => r.dataset.owner)).toContain(child);
    act(() => {
      useThreadsStore.setState((s) => {
        const { [parent]: _gone, ...byId } = s.byId;
        return { byId, order: s.order.filter((id) => id !== parent) };
      });
    });
    expect(rows()).toHaveLength(0);
    cleanup();
    await renderGroup(child);
    expect(rows().map((r) => r.dataset.port)).toEqual(["9399", "5173"]);
  });
});

describe("narrow selectors", () => {
  it("an update that leaves the servers alone re-renders nothing", async () => {
    const { parent, child } = seedChildServer();
    let commits = 0;
    render(
      <Profiler
        id="g"
        onRender={() => {
          commits++;
        }}
      >
        <ShellsGroup threadId={parent} />
      </Profiler>,
    );
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    const settled = commits;
    updateThread(child, { statusReason: "working: something else" });
    updateThread(parent, { statusReason: "idle again" });
    addThreads(thread("s-stranger", { name: "Stranger", backgroundShells: [] }));
    act(() => {
      useActionsStore.setState((s) => {
        const run = s.runs["r-debug"];
        return run ? { runs: { ...s.runs, "r-other": { ...run, id: "r-other", threadId: "s-stranger", ports: [1] } } } : s;
      });
    });
    expect(commits).toBe(settled);
    expect(rows()).toHaveLength(3);
  });

  it("a run's port change does re-render", async () => {
    const { parent, debugRun } = seedChildServer();
    await renderGroup(parent);
    setRun(debugRun, { ports: [7788, 7789] });
    expect(within(row(7788)).getByTestId("ti-server-meta").textContent).toBe("+1");
  });

  it("this thread's servers alone still work (no child, no run)", async () => {
    const id = seedServers();
    await renderGroup(id);
    expect(rows()).toHaveLength(2);
  });
});
