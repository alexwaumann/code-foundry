import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startPrSession = vi.hoisted(() => vi.fn());
vi.mock("@/stores/prSessions", async (orig) => ({ ...(await orig<typeof import("@/stores/prSessions")>()), startPrSession }));

const { usePrSessionsStore, startingKey } = await import("@/stores/prSessions");
const { PrAskComposer } = await import("./PrAskComposer");
const { composerKeyAction } = await import("./keys");

const REF = { slug: "acme/repo", number: 7 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  usePrSessionsStore.setState({ starting: {} });
});

describe("composerKeyAction", () => {
  it.each([
    [{ key: "Enter", shiftKey: false }, "send"],
    [{ key: "Enter", shiftKey: false, metaKey: true }, "send"],
    [{ key: "Enter", shiftKey: true }, null],
    [{ key: "Enter", shiftKey: false, altKey: true }, null],
    [{ key: "Enter", shiftKey: false, ctrlKey: true }, null],
    [{ key: "Enter", shiftKey: false, isComposing: true }, null],
    [{ key: "Escape", shiftKey: false }, "cancel"],
    [{ key: "Escape", shiftKey: false, isComposing: true }, null],
    // WebKit: compositionend comes before the confirming Enter, whose keyCode is 229.
    [{ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229 }, null],
    [{ key: "Escape", shiftKey: false, isComposing: false, keyCode: 229 }, null],
    [{ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }, "send"],
    [{ key: "Escape", shiftKey: false, keyCode: 27 }, "cancel"],
    [{ key: "a", shiftKey: false }, null],
  ] as const)("%j → %s", (e, want) => {
    expect(composerKeyAction(e)).toBe(want);
  });
});

describe("PrAskComposer", () => {
  const input = () => screen.getByTestId("pr-ask-input");

  it("Enter sends the question through startPrSession and closes on success", async () => {
    startPrSession.mockResolvedValueOnce("s-1");
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "Why the lock?" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).toHaveBeenCalledWith("ask", REF, "Why the lock?");
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("an IME Enter (keyCode 229) does not send", () => {
    render(<PrAskComposer prRef={REF} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "日本" } });
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(notPrevented).toBe(true);
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("Shift+Enter does not send", () => {
    render(<PrAskComposer prRef={REF} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "line one" } });
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true); // the textarea inserts the newline
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("Enter on a blank question sends nothing", () => {
    render(<PrAskComposer prRef={REF} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-ask-send")).toHaveProperty("disabled", true);
  });

  it("Escape cancels without sending", () => {
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "never mind" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("a failure keeps the composer open with its text", async () => {
    startPrSession.mockResolvedValueOnce(null);
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "Why?" } });
    fireEvent.click(screen.getByTestId("pr-ask-send"));
    await vi.waitFor(() => {
      expect(startPrSession).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "Why?");
  });

  it("is read-only and does not send again while pr.ask runs", () => {
    usePrSessionsStore.setState({ starting: { [startingKey(REF, "ask")]: true } });
    render(<PrAskComposer prRef={REF} onClose={vi.fn()} />);
    expect(input()).toHaveProperty("readOnly", true);
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe("Starting a session…");
    fireEvent.change(input(), { target: { value: "again" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).not.toHaveBeenCalled();
  });
});
