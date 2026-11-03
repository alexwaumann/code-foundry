import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixStalePrBadge, publishThread } from "@/test/threadWorld";
import { useCommandsStore } from "@/stores/commands";
import { useThreadStore } from "@/stores/thread";
import { openThreadFind, useThreadFindStore } from "@/stores/threadFind";
import { useUiStore } from "@/stores/ui";
import { FindBar } from "./FindBar";

const T = "s-1";
const session = () => useThreadFindStore.getState().byThread[T];
const input = () => screen.getByTestId<HTMLInputElement>("thread-find-input");
const cmd = (name: string, chord: string) => ({ name, title: name, description: "", category: "View", keybindings: [chord], args: [], available: true, noPalette: false });

beforeEach(() => {
  publishThread(T, fixStalePrBadge("idle"));
  useCommandsStore.setState({ commands: [cmd("thread.find", "cmd+f"), cmd("thread.find.next", "cmd+g"), cmd("thread.find.previous", "cmd+shift+g")] as never });
});

afterEach(() => {
  cleanup();
  useThreadFindStore.setState({ byThread: {} });
  useThreadStore.setState({ logs: {} });
});

function renderOpen(query?: string) {
  act(() => {
    openThreadFind(T, query);
  });
  return render(<FindBar threadId={T} />);
}

describe("FindBar", () => {
  it("renders nothing while closed", () => {
    render(<FindBar threadId={T} />);
    expect(screen.queryByTestId("thread-find")).toBeNull();
  });

  it("opens focused with its placeholder, no count, the steps dimmed", () => {
    renderOpen();
    expect(input()).toHaveProperty("placeholder", "Find in thread");
    expect(document.activeElement).toBe(input());
    expect(screen.queryByTestId("thread-find-count")).toBeNull();
    expect(screen.getByTestId("thread-find-next").getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("thread-find-case")).toBeNull();
  });

  it("counts from the data as the query is typed; 'n of m' once a match is current", () => {
    renderOpen();
    fireEvent.change(input(), { target: { value: "head sha" } });
    expect(session()?.query).toBe("head sha");
    expect(screen.getByTestId("thread-find-count").textContent).toBe("0 of 3");
    expect(screen.getByTestId("thread-find-next").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(screen.getByTestId("thread-find-next"));
    expect(screen.getByTestId("thread-find-count").textContent).toBe("1 of 3");
  });

  it("shows Aa only while the query has a capital letter", () => {
    renderOpen("Head");
    expect(screen.getByTestId("thread-find-case").textContent).toBe("Aa");
    fireEvent.change(input(), { target: { value: "head" } });
    expect(screen.queryByTestId("thread-find-case")).toBeNull();
  });

  it("Enter and shift+Enter step, as do the find verbs' chords in the field", () => {
    renderOpen("head sha");
    fireEvent.keyDown(input(), { key: "Enter" });
    const first = session()?.current;
    expect(first).not.toBeNull();
    expect(screen.getByTestId("thread-find-count").textContent).toBe("1 of 3");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("thread-find-count").textContent).toBe("2 of 3");
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(session()?.current).toEqual(first);
    fireEvent.keyDown(input(), { key: "g", code: "KeyG", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("thread-find-count").textContent).toBe("3 of 3");
    fireEvent.keyDown(input(), { key: "g", code: "KeyG", metaKey: true });
    expect(screen.getByTestId("thread-find-count").textContent).toBe("1 of 3");
    fireEvent.click(screen.getByTestId("thread-find-prev"));
    expect(screen.getByTestId("thread-find-count").textContent).toBe("3 of 3");
  });

  it("cmd+f in the field selects the query", () => {
    renderOpen("head sha");
    input().setSelectionRange(8, 8);
    fireEvent.keyDown(input(), { key: "f", code: "KeyF", metaKey: true });
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, 8]);
  });

  it("Escape (and the close button) close and clear, handing the keyboard back to the prompt", () => {
    renderOpen("head sha");
    const seq = useUiStore.getState().promptFocusSeq;
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(session()).toBeUndefined();
    expect(screen.queryByTestId("thread-find")).toBeNull();
    expect(useUiStore.getState().promptFocusSeq).toBe(seq + 1);
    cleanup();
    renderOpen("x");
    fireEvent.click(screen.getByTestId("thread-find-close"));
    expect(session()).toBeUndefined();
  });
});
