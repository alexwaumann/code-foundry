import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { CommandButton } from "./CommandButton";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", () => ({ startCommandNamed }));

afterEach(() => {
  cleanup();
  startCommandNamed.mockClear();
});

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "session.new", title: "New Session", description: "", category: "Session", args: [], keybindings: ["cmd+n"], available: true, ...over };
}

describe("CommandButton", () => {
  it.each([
    ["listed: enabled, titled by the command", [cmd({})], "hide" as const, { present: true, disabled: false }],
    ["not listed, hide", [], "hide" as const, { present: false, disabled: false }],
    ["not listed, disable", [], "disable" as const, { present: true, disabled: true }],
    ["listed unavailable, disable", [cmd({ available: false })], "disable" as const, { present: true, disabled: true }],
  ])("%s", (_name, commands, whenUnavailable, want) => {
    useCommandsStore.setState({ commands });
    render(<CommandButton command="session.new" icon={Plus} whenUnavailable={whenUnavailable} data-testid="b" />);
    const b = screen.queryByTestId("b");
    expect(b !== null).toBe(want.present);
    if (!b) return;
    expect((b as HTMLButtonElement).disabled).toBe(want.disabled);
  });

  it("starts the command like the palette and names no chord", () => {
    useCommandsStore.setState({ commands: [cmd({})] });
    render(<CommandButton command="session.new" icon={Plus} data-testid="b" />);
    const b = screen.getByTestId("b");
    expect(b.getAttribute("title")).toBe("New Session");
    expect(b.getAttribute("aria-label")).toBe("New Session");
    expect(b.tabIndex).toBe(-1);
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("session.new");
  });

  it("a labelled button can take focus", () => {
    useCommandsStore.setState({ commands: [cmd({})] });
    render(<CommandButton command="session.new" icon={Plus} label="New session" keepFocus={false} />);
    const b = screen.getByRole("button", { name: "New session" });
    expect(b.tabIndex).toBe(0);
  });
});
