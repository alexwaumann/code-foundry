import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore, type Selection } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { tooltipText } from "@/test/tooltip";
import { HistoryButtons } from "./HistoryButtons";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));

const thread = (id: string): Selection => ({ kind: "thread", id });
const command = (name: string, title: string): CommandView => ({ name, title, description: "", category: "View", args: [], keybindings: [], available: true });

function buttons() {
  render(<HistoryButtons />);
  return { back: screen.getByTestId<HTMLButtonElement>("sidebar-back"), forward: screen.getByTestId<HTMLButtonElement>("sidebar-forward") };
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [command("view.back", "Back"), command("view.forward", "Forward")] });
  // Not loaded: no entry counts as gone.
  useThreadsStore.setState({ loaded: false });
});

afterEach(() => {
  cleanup();
  startCommandNamed.mockClear();
  useViewsStore.setState({ settingsOpen: false, themesOpen: false, usageOpen: false });
  useThreadsStore.setState({ loaded: false, byId: {} });
});

describe("HistoryButtons", () => {
  it.each([
    ["one entry: nowhere to go", [thread("a")], 0, { back: false, forward: false }],
    ["at the newest entry", [thread("a"), thread("b")], 1, { back: true, forward: false }],
    ["between entries", [thread("a"), thread("b"), thread("c")], 1, { back: true, forward: true }],
    ["at the oldest entry", [thread("a"), thread("b")], 0, { back: false, forward: true }],
  ])("%s", (_name, history, historyIndex, want) => {
    useUiStore.setState({ history, historyIndex });
    const { back, forward } = buttons();
    expect({ back: !back.disabled, forward: !forward.disabled }).toEqual(want);
  });

  it.each([["settingsOpen"], ["themesOpen"], ["usageOpen"]])("Back stays lit with no history while %s, which it closes", (view) => {
    useUiStore.setState({ history: [thread("a")], historyIndex: 0 });
    useViewsStore.setState({ [view]: true });
    const { back, forward } = buttons();
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
  });

  it("an entry whose thread is gone does not count", () => {
    useThreadsStore.setState({ loaded: true, byId: {} });
    useUiStore.setState({ history: [thread("gone"), { kind: "view", name: "home" }], historyIndex: 1 });
    expect(buttons().back.disabled).toBe(true);
  });

  it("run the history commands, named without a chord", () => {
    useUiStore.setState({ history: [thread("a"), thread("b"), thread("c")], historyIndex: 1 });
    const { back, forward } = buttons();
    expect(tooltipText(back)).toBe("Back");
    fireEvent.click(back);
    fireEvent.click(forward);
    expect(startCommandNamed.mock.calls).toEqual([["view.back"], ["view.forward"]]);
  });
});
