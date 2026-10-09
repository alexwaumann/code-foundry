import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startPrSession = vi.hoisted(() => vi.fn());
vi.mock("@/stores/prSessions", async (orig) => ({ ...(await orig<typeof import("@/stores/prSessions")>()), startPrSession }));

const { usePrSessionsStore, startingKey } = await import("@/stores/prSessions");
const { ASK_ELSEWHERE_HINT, ASK_KEYS_HINT, ASK_SENDING_HINT, PrAskComposer } = await import("./PrAskComposer");
const { composerKeyAction } = await import("./keys");

const REF = { slug: "acme/repo", number: 7 };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** startPrSession as the store runs it: the shared busy flag is set while it runs. */
function runningAsk(answer: Promise<string | null>) {
  return async () => {
    usePrSessionsStore.setState({ starting: { [startingKey(REF, "ask")]: true } });
    try {
      return await answer;
    } finally {
      usePrSessionsStore.setState({ starting: {} });
    }
  };
}

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

  it("Enter sends the question through startPrSession, closes on success and hands focus to the panel", async () => {
    startPrSession.mockResolvedValueOnce("s-1");
    const onClose = vi.fn();
    render(
      <aside data-region="panel" tabIndex={-1} data-testid="panel">
        <PrAskComposer prRef={REF} focusRequest={1} onClose={onClose} />
      </aside>,
    );
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input());
    });
    fireEvent.change(input(), { target: { value: "Why the lock?" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).toHaveBeenCalledWith("ask", REF, "Why the lock?");
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // If the daemon's FocusSession never arrives, panel keys still work.
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
  });

  it("an IME Enter (keyCode 229) does not send", () => {
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "日本" } });
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(notPrevented).toBe(true);
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("shows the short key hint while idle", () => {
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />);
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe(ASK_KEYS_HINT);
  });

  it("Shift+Enter does not send", () => {
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "line one" } });
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true); // the textarea inserts the newline
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("Enter on a blank question sends nothing", () => {
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-ask-send")).toHaveProperty("disabled", true);
  });

  it("Escape cancels without sending", () => {
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "never mind" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(startPrSession).not.toHaveBeenCalled();
  });

  it("a failure keeps the composer open with its text", async () => {
    startPrSession.mockResolvedValueOnce(null);
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "Why?" } });
    fireEvent.click(screen.getByTestId("pr-ask-send"));
    await vi.waitFor(() => {
      expect(startPrSession).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(onClose).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "Why?");
  });

  it("while its pr.ask runs: read-only, Cancel disabled, Escape and Enter ignored; it closes when the session starts", async () => {
    const d = deferred<string | null>();
    startPrSession.mockImplementationOnce(runningAsk(d.promise));
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "Why?" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveProperty("readOnly", true);
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe(ASK_SENDING_HINT);
    expect(screen.getByTestId("pr-ask-cancel")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");

    const escapeHandled = !fireEvent.keyDown(input(), { key: "Escape" });
    expect(escapeHandled).toBe(true); // kept from the panel's keys too
    fireEvent.click(screen.getByTestId("pr-ask-cancel"));
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    expect(startPrSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pr-ask")).toBeTruthy();

    await act(async () => {
      d.resolve("s-1");
      await d.promise;
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("while pr.ask for the same pull request runs from another surface: the shared spinner, the hint, nothing sent", () => {
    usePrSessionsStore.setState({ starting: { [startingKey(REF, "ask")]: true } });
    const onClose = vi.fn();
    render(<PrAskComposer prRef={REF} focusRequest={1} onClose={onClose} />);
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe(ASK_ELSEWHERE_HINT);
    expect(screen.getByTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("pr-ask-send")).toHaveProperty("disabled", true);
    // Its own text stays editable and it can still be cancelled.
    expect(input()).toHaveProperty("readOnly", false);
    fireEvent.change(input(), { target: { value: "again" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(startPrSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe(ASK_ELSEWHERE_HINT);
    expect(input()).toHaveProperty("value", "again");
    act(() => {
      usePrSessionsStore.setState({ starting: {} });
    });
    expect(screen.getByTestId("pr-ask-hint").textContent).toBe(ASK_KEYS_HINT);
    expect(screen.getByTestId("pr-ask-send")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("pr-ask-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("two surfaces on the same pull request share the spinner; the sender says it is starting, the other that it already is", async () => {
    const d = deferred<string | null>();
    startPrSession.mockImplementationOnce(runningAsk(d.promise));
    render(
      <>
        <div data-testid="a">
          <PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />
        </div>
        <div data-testid="b">
          <PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />
        </div>
      </>,
    );
    const inputA = screen.getAllByTestId("pr-ask-input")[0] as HTMLElement;
    fireEvent.change(inputA, { target: { value: "From A" } });
    fireEvent.keyDown(inputA, { key: "Enter" });
    const sends = screen.getAllByTestId("pr-ask-send");
    expect(sends.map((b) => b.getAttribute("aria-busy"))).toEqual(["true", "true"]);
    expect(screen.getAllByTestId("pr-ask-hint").map((h) => h.textContent)).toEqual([ASK_SENDING_HINT, ASK_ELSEWHERE_HINT]);
    await act(async () => {
      d.resolve(null);
      await d.promise;
    });
    expect(screen.getAllByTestId("pr-ask-send").map((b) => b.getAttribute("aria-busy"))).toEqual([null, null]);
    expect(screen.getAllByTestId("pr-ask-hint").map((h) => h.textContent)).toEqual([ASK_KEYS_HINT, ASK_KEYS_HINT]);
  });

  it("a new focus request moves focus back into the open composer", async () => {
    const { rerender } = render(
      <>
        <button type="button" data-testid="elsewhere" />
        <PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />
      </>,
    );
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input());
    });
    screen.getByTestId("elsewhere").focus();
    rerender(
      <>
        <button type="button" data-testid="elsewhere" />
        <PrAskComposer prRef={REF} focusRequest={2} onClose={vi.fn()} />
      </>,
    );
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input());
    });
  });
});
