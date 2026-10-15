import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import { useCommandsStore } from "@/stores/commands";
import { tooltipText } from "@/test/tooltip";
import { CommandButton } from "./CommandButton";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));

afterEach(() => {
  cleanup();
  startCommandNamed.mockClear();
});

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "terminal.new", title: "New Terminal", description: "", category: "Terminal", args: [], keybindings: ["cmd+t"], available: true, ...over };
}

describe("CommandButton", () => {
  it.each([
    ["listed: enabled, titled by the command", [cmd({})], "hide" as const, { present: true, disabled: false }],
    ["not listed, hide", [], "hide" as const, { present: false, disabled: false }],
    ["not listed, disable", [], "disable" as const, { present: true, disabled: true }],
    ["listed unavailable, disable", [cmd({ available: false })], "disable" as const, { present: true, disabled: true }],
  ])("%s", (_name, commands, whenUnavailable, want) => {
    useCommandsStore.setState({ commands });
    render(<CommandButton command="terminal.new" icon={Plus} whenUnavailable={whenUnavailable} data-testid="b" />);
    const b = screen.queryByTestId("b");
    expect(b !== null).toBe(want.present);
    if (!b) return;
    expect((b as HTMLButtonElement).disabled).toBe(want.disabled);
  });

  it("session.new stays enabled where the daemon lists it unavailable (the project picker supplies the repo)", () => {
    useCommandsStore.setState({ commands: [cmd({ name: "session.new", title: "New Thread", available: false })] });
    render(<CommandButton command="session.new" icon={Plus} whenUnavailable="disable" data-testid="b" />);
    expect(screen.getByTestId<HTMLButtonElement>("b").disabled).toBe(false);
  });

  it("starts the command like the palette and names no chord", () => {
    useCommandsStore.setState({ commands: [cmd({})] });
    render(<CommandButton command="terminal.new" icon={Plus} data-testid="b" />);
    const b = screen.getByTestId("b");
    expect(b.getAttribute("title")).toBeNull();
    expect(b.getAttribute("aria-label")).toBe("New Terminal");
    expect(b.tabIndex).toBe(-1);
    // The name is its tooltip (the shadcn Tooltip, not a native title).
    expect(tooltipText(b)).toBe("New Terminal");
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("terminal.new");
  });

  it("an icon-only button's tooltip can be overridden; a disabled one hangs it on a span around the button", () => {
    useCommandsStore.setState({ commands: [] });
    render(<CommandButton command="terminal.new" icon={Plus} tooltip="Open a shell" whenUnavailable="disable" data-testid="b" />);
    const b = screen.getByTestId<HTMLButtonElement>("b");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-label")).toBe("Open a shell");
    // A disabled button gets no pointer events: the span is the tooltip's trigger.
    const wrap = b.parentElement as HTMLElement;
    expect(wrap.tagName).toBe("SPAN");
    expect(wrap.dataset.state).toBe("closed");
    expect(b.dataset.state).toBeUndefined();
  });

  it.each([
    ["listed: a button named by its content, no title", [cmd({})], "button"],
    ["not listed: the same content as plain text", [], "span"],
    ["listed unavailable: plain text", [cmd({ available: false })], "span"],
  ])("custom content, plain when unavailable: %s", (_name, commands, tag) => {
    useCommandsStore.setState({ commands });
    render(
      <CommandButton command="terminal.new" whenUnavailable="plain" className="x" data-testid="b">
        <span>my thread</span>
      </CommandButton>,
    );
    const b = screen.getByTestId("b");
    expect(b.tagName.toLowerCase()).toBe(tag);
    expect(b.textContent).toBe("my thread");
    expect(b.getAttribute("title")).toBeNull();
    expect(b.getAttribute("aria-label")).toBeNull();
    // Visible content names the button: no tooltip either.
    expect(b.dataset.state).toBeUndefined();
    expect(b.classList.contains("x")).toBe(true);
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledTimes(tag === "button" ? 1 : 0);
  });

  it("a labelled button can take focus", () => {
    useCommandsStore.setState({ commands: [cmd({})] });
    render(<CommandButton command="terminal.new" icon={Plus} label="New terminal" keepFocus={false} />);
    const b = screen.getByRole("button", { name: "New terminal" });
    expect(b.tabIndex).toBe(0);
  });
});
