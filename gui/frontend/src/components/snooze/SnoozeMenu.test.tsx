import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { SnoozePresetItems } from "./SnoozeMenu";
import { useCommandsStore } from "@/stores/commands";
import { useSettingsStore } from "@/stores/settings";
import { useThreadsStore } from "@/stores/threads";

/** A plain item: the menus' Radix items are not what these tests read. */
function Item({ onSelect, children, ...rest }: { onSelect: () => void; children?: ReactNode; "data-testid"?: string; "data-preset"?: string }) {
  return (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  );
}
const Separator = () => <hr />;

const snoozeDefault: CommandView = { name: "thread.snooze.default", title: "Snooze to Default", description: "", category: "Thread", args: [], keybindings: ["cmd+shift+s"], available: true };

function setDefault(v: string | undefined): void {
  useSettingsStore.setState({ snapshot: { values: v === undefined ? {} : { "threads.default_snooze": v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

/** Each item's label and its default mark ("" without one), in order. */
function marks(): [string, string][] {
  return screen.getAllByRole("button").map((b) => [b.dataset.preset ?? b.dataset.testid ?? "", within(b).queryByTestId("snooze-default")?.textContent ?? ""]);
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [snoozeDefault] });
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", savedAtMs: null } as ThreadView, "s-2": { id: "s-2", savedAtMs: null } as ThreadView }, order: ["s-1", "s-2"] });
  setDefault(undefined);
});

afterEach(() => {
  cleanup();
});

describe("the snooze menu's default", () => {
  it.each([
    { name: "unset: tomorrow", value: undefined, want: "tomorrow" },
    { name: "a preset", value: "3h", want: "3h" },
    { name: "save for later", value: "save", want: "snooze-save" },
    { name: "an unknown value: tomorrow, the daemon's fallback", value: "soon", want: "tomorrow" },
  ])("marks the default preset with the chord after its label: $name", ({ value, want }) => {
    setDefault(value);
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={Separator} />);
    const marked = marks().filter(([, m]) => m !== "");
    expect(marked).toEqual([[want, "default⇧⌘S"]]);
  });

  it("shows the chord as the user bound it, and only the word when it is unbound", () => {
    useCommandsStore.setState({ commands: [{ ...snoozeDefault, keybindings: ["cmd+alt+z"] }] });
    const { unmount } = render(<SnoozePresetItems id="s-1" Item={Item} Separator={Separator} />);
    expect(marks().find(([id]) => id === "tomorrow")?.[1]).toBe("default⌥⌘Z");
    unmount();
    useCommandsStore.setState({ commands: [{ ...snoozeDefault, keybindings: [] }] });
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={Separator} />);
    expect(marks().find(([id]) => id === "tomorrow")?.[1]).toBe("default");
  });

  it("in the bulk menu: the word without the chord, which acts on the thread in view only", () => {
    render(<SnoozePresetItems id="s-1" ids={["s-1", "s-2"]} Item={Item} Separator={Separator} />);
    expect(marks().filter(([, m]) => m !== "")).toEqual([["tomorrow", "default"]]);
  });

  it("the time stays on the right of every preset", () => {
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={Separator} />);
    expect(screen.getAllByTestId("snooze-preset-time")).toHaveLength(4);
  });
});
