import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const { TerminalHost } = await import("./TerminalHost");
const { attach, finds, renderers } = await import("@/test/terminalHost");
const { openTerminalLink } = await import("./terminalLinks");
const { useCommandsStore } = await import("@/stores/commands");
const { closeTerminalFind, openTerminalFind, useTerminalFindStore } = await import("@/stores/terminalFind");

const cmd = (name: string, chord: string) => ({ name, title: name, description: "", category: "View", keybindings: [chord], args: [], available: true, noPalette: false });
const input = () => screen.getByTestId<HTMLInputElement>("terminal-find-input");
const bar = () => screen.queryByTestId("terminal-find");
const count = () => screen.getByTestId("terminal-find-count").textContent;

/** The real TerminalHost and bar on a renderer that records (src/test/terminalHost.ts). */
function host(terminalId: string | null, hidden = false) {
  return <TerminalHost terminalId={terminalId} hidden={hidden} testId="host" />;
}

function publish(index: number, total: number, capped = false) {
  act(() => {
    finds.publish?.({ index, total, capped });
  });
}

function open(id: string) {
  act(() => {
    openTerminalFind(id);
  });
}

function type(query: string) {
  fireEvent.change(input(), { target: { value: query } });
}

beforeEach(() => {
  finds.calls.length = 0;
  attach.reset();
  useCommandsStore.setState({ commands: [cmd("terminal.find", "cmd+f"), cmd("terminal.find.next", "cmd+g"), cmd("terminal.find.previous", "cmd+shift+g")] as never });
});

afterEach(() => {
  cleanup();
  useTerminalFindStore.setState({ byTerminal: {} });
});

describe("the terminal host", () => {
  it("opens a cmd+clicked link through the app, not window.open", () => {
    render(host("t1"));
    expect(renderers.options.at(-1)?.openLink).toBe(openTerminalLink);
  });
});

describe("the terminal's find bar", () => {
  it("shows nothing until opened, then takes the keyboard with its placeholder and no count", () => {
    render(host("t1"));
    expect(bar()).toBeNull();
    open("t1");
    expect(input().placeholder).toBe("Find in terminal");
    expect(document.activeElement).toBe(input());
    expect(screen.queryByTestId("terminal-find-count")).toBeNull();
    expect(screen.getByTestId("terminal-find-next").getAttribute("aria-disabled")).toBe("true");
  });

  it("sits outside the xterm host, so its keys are a field's and not the shell's", () => {
    render(host("t1"));
    open("t1");
    expect(input().closest("[data-terminal-host]")).toBeNull();
    expect(input().closest("[data-terminal-box]")?.getAttribute("data-terminal-box")).toBe("t1");
    expect(input().closest("[data-keys-local]")).not.toBeNull();
  });

  it("searches as the query is typed, and shows the renderer's count", () => {
    render(host("t1"));
    open("t1");
    type("res");
    expect(finds.calls.at(-1)).toBe("find res");
    publish(3, 9);
    expect(count()).toBe("4 of 9");
    expect(screen.getByTestId("terminal-find-next").getAttribute("aria-disabled")).toBeNull();
    publish(3, 10);
    expect(count()).toBe("4 of 10");
  });

  it("shows Aa only while the query has a capital letter", () => {
    render(host("t1"));
    open("t1");
    type("Res");
    expect(screen.getByTestId("terminal-find-case").textContent).toBe("Aa");
    type("res");
    expect(screen.queryByTestId("terminal-find-case")).toBeNull();
  });

  it("emptying the field clears the highlights and keeps the bar", () => {
    render(host("t1"));
    open("t1");
    type("res");
    type("");
    expect(finds.calls.at(-1)).toBe("clear");
    expect(bar()).not.toBeNull();
  });

  it("Enter, shift+Enter, the buttons and the verbs' chords step", () => {
    render(host("t1"));
    open("t1");
    type("res");
    publish(0, 2);
    finds.calls.length = 0;
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    fireEvent.click(screen.getByTestId("terminal-find-next"));
    fireEvent.click(screen.getByTestId("terminal-find-prev"));
    fireEvent.keyDown(input(), { key: "g", code: "KeyG", metaKey: true });
    fireEvent.keyDown(input(), { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(finds.calls).toEqual(["step 1", "step -1", "step 1", "step -1", "step 1", "step -1"]);
  });

  it("does not step from a dimmed button", () => {
    render(host("t1"));
    open("t1");
    finds.calls.length = 0;
    fireEvent.click(screen.getByTestId("terminal-find-next"));
    expect(finds.calls).toEqual([]);
  });

  it("a second terminal.find selects the query; in the field its chord does", () => {
    render(host("t1"));
    open("t1");
    type("resize");
    input().setSelectionRange(6, 6);
    open("t1");
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 6]);
    input().setSelectionRange(6, 6);
    fireEvent.keyDown(input(), { key: "f", code: "KeyF", metaKey: true });
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 6]);
  });

  it("Escape and the close button close, clear and give the keyboard back to xterm", async () => {
    const { XtermRenderer } = await import("@/terminal/xterm");
    const focus = vi.spyOn(XtermRenderer.prototype, "focus");
    render(host("t1"));
    open("t1");
    type("res");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(bar()).toBeNull();
    expect(finds.calls.at(-1)).toBe("clear");
    expect(focus).toHaveBeenCalledTimes(1);
    open("t1");
    fireEvent.click(screen.getByTestId("terminal-find-close"));
    expect(bar()).toBeNull();
    expect(focus).toHaveBeenCalledTimes(2);
    focus.mockRestore();
  });

  it("each tab has its query: a switch shows the other's, and comes back to its own", () => {
    const view = render(host("t1"));
    open("t1");
    type("one");
    view.rerender(host("t2"));
    expect(bar()).toBeNull();
    expect(finds.calls.at(-1)).toBe("clear");
    open("t2");
    type("two");
    expect(finds.calls.at(-1)).toBe("find two");
    view.rerender(host("t1"));
    expect(input().value).toBe("one");
    expect(finds.calls.at(-1)).toBe("find one");
  });

  it("a bar that comes back with its tab leaves the keyboard where it is", () => {
    const view = render(host("t1"));
    open("t1");
    view.rerender(host("t2"));
    (document.activeElement as HTMLElement | null)?.blur();
    view.rerender(host("t1"));
    expect(bar()).not.toBeNull();
    expect(document.activeElement).not.toBe(input());
  });

  it("reports a renderer's matches to the terminal attached, not the last one", () => {
    const view = render(host("t1"));
    open("t1");
    open("t2");
    view.rerender(host("t2"));
    publish(0, 5);
    expect(useTerminalFindStore.getState().byTerminal.t1?.results.total).toBe(0);
    expect(useTerminalFindStore.getState().byTerminal.t2?.results.total).toBe(5);
  });

  it("hiding the panel (the host unmounts) keeps the query and drops the renderer's listener; showing it searches again", () => {
    const view = render(host("t1"));
    open("t1");
    type("res");
    view.unmount();
    expect(finds.publish).toBeNull();
    finds.calls.length = 0;
    render(host("t1"));
    expect(input().value).toBe("res");
    expect(finds.calls).toEqual(["find res"]);
  });

  it("a detached host (no tab) has no bar and clears", () => {
    const view = render(host("t1"));
    open("t1");
    type("res");
    view.rerender(host(null, true));
    expect(bar()).toBeNull();
    expect(finds.calls.at(-1)).toBe("clear");
  });

  it("a session closed from outside takes the bar with it", () => {
    render(host("t1"));
    open("t1");
    act(() => {
      closeTerminalFind("t1");
    });
    expect(bar()).toBeNull();
  });
});
