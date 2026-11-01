// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { stubLayout, settle } from "@/test/composerWorld";
import { daemon, invocationsOf, resetDaemon } from "@/test/daemonFakes";
import { addThreads, seedWorld, thread } from "@/test/projectsWorld";
import { CommandPalette } from "./CommandPalette";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

function cmd(name: string, title: string, category: string, keybindings: string[] = []): CommandView {
  return { name, title, description: "", category, args: [], keybindings, available: true };
}

// The ranking cases of src/palette/rank.test.ts, in the category order the palette used to list.
const COMMANDS = [
  cmd("app.relaunch", "Relaunch App", "App"),
  cmd("app.echo_path", "Echo Path", "App"),
  cmd("pr.refresh", "Refresh Pull Request", "Pull Request"),
  cmd("thread.new", "New Thread", "Thread", ["cmd+n"]),
  cmd("view.help", "Keyboard Shortcuts and Help", "View", ["cmd+/"]),
  cmd("view.settings", "Settings", "View", ["cmd+,"]),
  cmd("view.panel.expand", "Expand Side Panel", "View"),
  cmd("view.panel.toggle", "Toggle Side Panel", "View", ["cmd+b"]),
  cmd("view.panel.split", "Split Side Panel", "View", ["cmd+\\"]),
];

beforeEach(() => {
  stubLayout();
  resetDaemon();
  seedWorld();
  daemon.commands = COMMANDS;
  useCommandsStore.setState({ commands: [], loading: false, error: null, contextKey: "" });
  useViewsStore.setState({ helpOpen: false });
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

async function openPalette(): Promise<void> {
  render(<CommandPalette />);
  act(() => {
    useUiStore.getState().openPalette();
  });
  await settle(10);
}

const input = () => screen.getByRole("combobox");
const typeQuery = (q: string) => {
  fireEvent.change(input(), { target: { value: q } });
};
const first = () => document.querySelector<HTMLElement>("[cmdk-item]");
const highlighted = () => document.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
const headings = () => Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent);
const mode = () => screen.getByTestId("palette").getAttribute("data-mode");

describe("the command palette's ranking (palette-rank.spec.ts)", () => {
  it.each([
    ["help", "view.help"],
    ["split", "view.panel.split"],
    ["settings", "view.settings"],
  ])("%s: %s first and highlighted, in one Results group", async (query, want) => {
    await openPalette();
    typeQuery(query);
    expect(first()?.dataset.command).toBe(want);
    expect(highlighted()?.dataset.command).toBe(want);
    expect(headings()).toEqual(["Results"]);
  });

  it("panel: a panel command first, not an early category's loose match", async () => {
    await openPalette();
    typeQuery("panel");
    expect(first()?.textContent).toContain("Panel");
    expect(headings()).toEqual(["Results"]);
  });

  it("Enter on help opens help; it does not relaunch the app", async () => {
    await openPalette();
    typeQuery("help");
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle();
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(useViewsStore.getState().helpOpen).toBe(true);
    expect(invocationsOf("app.relaunch")).toEqual([]);
  });

  it("the empty query keeps the category groups", async () => {
    await openPalette();
    expect(headings()[0]).not.toBe("Results");
    expect(headings()).toEqual(["App", "Pull Request", "Thread", "View"]);
  });
});

describe("thread.new in the palette (compose.spec.ts)", () => {
  it("picking New Thread shows the project picker, not model and effort prompts; Backspace goes back to the commands", async () => {
    await openPalette();
    typeQuery("new thread");
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle();
    expect(mode()).toBe("projects");
    // No project is highlighted, not the project last composed in.
    expect(screen.getByTestId("picker-no-project").getAttribute("data-selected")).toBe("true");
    expect(document.querySelector('[data-project="repo-cf"]')?.getAttribute("data-selected")).toBe("false");
    fireEvent.keyDown(input(), { key: "Backspace" });
    await settle();
    expect(mode()).toBe("commands");
  });
});

describe("New thread on this branch and Run in, only where they apply (composer-fixes.spec.ts)", () => {
  it.each<[string, Partial<ThreadView>, boolean, boolean]>([
    ["a thread without a project: no New thread on this branch", { projectId: "", projectIds: [], worktreePath: "/Users/dev" }, false, false],
    ["a workspace without projects, in its folder: no Run in", { projectId: "", projectIds: [], workspaceId: "w-zero" }, true, false],
    ["two projects: Run in", { projectIds: ["repo-cf", "repo-gp"] }, true, true],
  ])("%s", async (_name, o, newLike, runIn) => {
    daemon.commands = [...COMMANDS, cmd("thread.new-like", "New Thread on This Branch", "Thread"), cmd("thread.run-in", "Run Thread In", "Thread")];
    addThreads(thread("s-x", { name: "X", ...o }));
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-x" });
    });
    await openPalette();
    typeQuery("thread");
    const listed = Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]")).map((i) => i.dataset.command);
    expect(listed.includes("thread.new-like")).toBe(newLike);
    expect(listed.includes("thread.run-in")).toBe(runIn);
  });
});
