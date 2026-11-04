import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetTurnView, messageFoldKey, setRowExpanded, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { findText } from "./find/findDom";
import { foldHides, FOLD_FADE_PX, FOLDED_ATTR } from "./foldDom";
import { UserBubble } from "./UserBubble";

const T = "t1";
const ctx = { threadId: T, cwd: "/" };

/** What the content measures (the bubble's text); the fold box itself never grows past its max-height. */
let height = 600;
let resized: (() => void)[] = [];

beforeEach(() => {
  height = 600;
  resized = [];
  useThreadStore.setState({ expanded: {}, folds: {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {}
      observe(el: Element): void {
        if ((el as HTMLElement).dataset.testid === "thread-user-content") resized.push(this.cb);
      }
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "thread-user-content" ? height : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Bubble({ foldKey = "m1", ...rest }: { foldKey?: string | undefined } & Partial<Parameters<typeof UserBubble>[0]>) {
  return (
    <ThreadContext.Provider value={ctx}>
      <UserBubble text="a long message" composerText="" attachments={[]} createdAtMs={null} foldKey={foldKey} {...rest} />
    </ThreadContext.Provider>
  );
}

const box = () => screen.getByTestId("thread-user-fold");
const toggle = () => screen.getByTestId("thread-user-fold-toggle");

describe("a long user message's fold", () => {
  it.each([
    { name: "under the fold", px: 120, folded: false },
    { name: "at the fold", px: 170, folded: false },
    { name: "just over it, inside the tolerance", px: 194, folded: false },
    { name: "just past the tolerance", px: 195, folded: true },
    { name: "far past it", px: 4000, folded: true },
  ])("$name ($px px): folded $folded", ({ px, folded }) => {
    height = px;
    render(<Bubble />);
    expect(box().dataset.folded).toBe(String(folded));
    expect(screen.queryByTestId("thread-user-fold-toggle") !== null).toBe(folded);
    expect(box().hasAttribute(FOLDED_ATTR)).toBe(folded);
    expect(box().style.maxHeight).toBe(folded ? "170px" : "194px");
  });

  it("Show more opens it whole; Show less folds it again", () => {
    render(<Bubble />);
    expect(toggle().textContent).toBe("Show more");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle());
    expect(box().dataset.folded).toBe("false");
    expect(box().style.maxHeight).toBe("");
    expect(toggle().textContent).toBe("Show less");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    expect(box().dataset.folded).toBe("true");
  });

  it("a resize across the threshold folds and unfolds it: the content is measured, not the clipped box", () => {
    height = 180;
    render(<Bubble />);
    expect(box().dataset.folded).toBe("false");
    // The list narrows: the same text wraps to more lines.
    height = 260;
    act(() => {
      for (const cb of resized) cb();
    });
    expect(box().dataset.folded).toBe("true");
    height = 180;
    act(() => {
      for (const cb of resized) cb();
    });
    expect(box().dataset.folded).toBe("false");
    expect(screen.queryByTestId("thread-user-fold-toggle")).toBeNull();
  });

  it("the choice is per message and outlives the row unmounting", () => {
    function Two() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setShown((s) => !s);
            }}
          >
            flip
          </button>
          {shown && <Bubble foldKey="m1" testId="one" />}
          <Bubble foldKey="m2" testId="two" />
        </>
      );
    }
    render(<Two />);
    const fold = (id: string) => screen.getByTestId(id).querySelector<HTMLElement>('[data-testid="thread-user-fold"]');
    const button = (id: string) => screen.getByTestId(id).querySelector<HTMLElement>('[data-testid="thread-user-fold-toggle"]');
    fireEvent.click(button("one") as HTMLElement);
    expect(fold("one")?.dataset.folded).toBe("false");
    expect(fold("two")?.dataset.folded).toBe("true");
    fireEvent.click(screen.getByText("flip"));
    fireEvent.click(screen.getByText("flip"));
    expect(fold("one")?.dataset.folded).toBe("false");
  });

  it("leaving the thread keeps the opened messages and forgets the rest of its view", () => {
    setRowExpanded(T, messageFoldKey("m1"), true);
    setRowExpanded(T, "a-tool-row", true);
    forgetTurnView(T);
    expect(useThreadStore.getState().expanded[T]).toEqual({ [messageFoldKey("m1")]: true });
    render(<Bubble />);
    expect(box().dataset.folded).toBe("false");
  });

  it.each([
    { name: "a steer", props: { steer: true } },
    { name: "a queued message", props: { queued: true } },
    { name: "a subagent's prompt", props: { label: "Prompt from parent", testId: "subagent-prompt" } },
  ])("$name folds like any message", ({ props }) => {
    render(<Bubble {...props} />);
    expect(box().dataset.folded).toBe("true");
  });

  it("without a fold key it shows whole: the search preview, the theme gallery", () => {
    render(<UserBubble text="a long message" composerText="" attachments={[]} createdAtMs={null} />);
    expect(screen.queryByTestId("thread-user-fold")).toBeNull();
    expect(screen.getByText("a long message")).toBeTruthy();
  });

  it("the whole text stays in the DOM under the fold, and the toggle is no part of what find searches", () => {
    render(<Bubble text="find me here" findItem="m1" />);
    const root = screen.getByTestId("thread-user-content");
    expect(root.getAttribute("data-find-item")).toBe("m1");
    expect(findText(root).text).toBe("find me here");
    expect(toggle().closest("[data-find-item]")).toBeNull();
  });

  it("a tag under the fold still works: tabbing to it opens the message; a click on one in the fold does not", () => {
    render(<Bubble />);
    const tag = document.createElement("button");
    screen.getByTestId("thread-user-content").append(tag);
    box().getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 100, width: 400, height: 170 });
    tag.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 500, width: 40, height: 20 });
    const visible = vi.spyOn(tag, "matches").mockReturnValue(false);
    fireEvent.focus(tag);
    expect(box().dataset.folded).toBe("true");
    visible.mockReturnValue(true);
    fireEvent.focus(tag);
    expect(box().dataset.folded).toBe("false");
  });
});

describe("foldHides", () => {
  const rect = (top: number, height = 20) => DOMRect.fromRect({ x: 0, y: top, width: 100, height });

  /** A folded box from y 100 to y 270, and the text in it. */
  function folded(attr: boolean): HTMLElement {
    const outer = document.createElement("div");
    if (attr) outer.setAttribute(FOLDED_ATTR, "");
    outer.getBoundingClientRect = () => rect(100, 170);
    const root = document.createElement("div");
    outer.append(root);
    return root;
  }

  it.each([
    { name: "a line above the fade", top: 120, hides: false },
    { name: "the last line clear of the fade", top: 270 - FOLD_FADE_PX - 20, hides: false },
    { name: "a line in the fade", top: 250, hides: true },
    { name: "a line far below the fold", top: 900, hides: true },
  ])("$name: $hides", ({ top, hides }) => {
    expect(foldHides(folded(true), [rect(top)])).toBe(hides);
  });

  it("a line of several hides the match; an open message hides nothing", () => {
    expect(foldHides(folded(true), [rect(120), rect(900)])).toBe(true);
    expect(foldHides(folded(false), [rect(900)])).toBe(false);
  });
});
