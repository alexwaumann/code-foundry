import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagToken } from "@/lib/prompt";
import { useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { UserBubble } from "./UserBubble";

// A user message's Copy (docs/notes/copy-prompt.md). Hover shows it through CSS (thread.css
// `.u-meta`), which jsdom does not apply: e2e thread-copy-prompt.spec.ts checks that.

const ctx = { threadId: "t1", cwd: "/" };
/** What the bubble's content measures (MessageFold): over its fold when large. */
let height = 100;
const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

beforeEach(() => {
  height = 100;
  writeText.mockClear();
  useThreadStore.setState({ expanded: {}, folds: {} });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
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

const AT = new Date(2026, 10, 20, 14, 12).getTime();

function Bubble(props: Partial<Parameters<typeof UserBubble>[0]>) {
  return (
    <ThreadContext.Provider value={ctx}>
      <UserBubble text="Add a retry backoff." composerText="" attachments={[]} createdAtMs={AT} foldKey="m1" {...props} />
    </ThreadContext.Provider>
  );
}

const copyBtn = () => screen.queryByTestId("thread-copy-prompt");

/** The meta line's children, by test id or class: what sits left to right under the bubble. */
function metaLine(): string[] {
  const meta = copyBtn()?.closest(".u-meta");
  return [...(meta?.children ?? [])].map((k) => k.getAttribute("data-testid") ?? k.className);
}

describe("a user message's Copy", () => {
  it("sits just left of the time, named Copy prompt, in the meta line under the bubble", () => {
    render(<Bubble />);
    const btn = copyBtn();
    expect(btn?.getAttribute("aria-label")).toBe("Copy prompt");
    expect(btn?.classList.contains("ib")).toBe(true);
    expect(btn?.hasAttribute("data-copied")).toBe(false);
    expect(metaLine()).toEqual(["thread-copy-prompt", "when"]);
    // The line is the message's last child, after the bubble.
    expect(btn?.closest(".u")?.lastElementChild?.classList.contains("u-meta")).toBe(true);
  });

  it("copies the message as typed; a check and Copied for a moment, then back", async () => {
    render(<Bubble text={"first line\n\n  indented second"} />);
    fireEvent.click(copyBtn() as HTMLElement);
    await waitFor(() => {
      expect(copyBtn()?.getAttribute("aria-label")).toBe("Copied");
    });
    expect(writeText).toHaveBeenCalledWith("first line\n\n  indented second");
    expect(copyBtn()?.hasAttribute("data-copied")).toBe(true);
    expect(copyBtn()?.querySelector("svg[data-copied]")).not.toBeNull();
    await waitFor(
      () => {
        expect(copyBtn()?.getAttribute("aria-label")).toBe("Copy prompt");
      },
      { timeout: 3000 },
    );
    expect(copyBtn()?.hasAttribute("data-copied")).toBe(false);
  });

  it("copies a folded long prompt whole, not the part on screen", async () => {
    height = 4000;
    const long = Array.from({ length: 40 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    render(<Bubble text={long} />);
    expect(screen.getByTestId("thread-user-fold").dataset.folded).toBe("true");
    fireEvent.click(copyBtn() as HTMLElement);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(long);
    });
  });

  it("copies tags as plain text, not the composer's tokens or what Claude got", async () => {
    const composer = `Run ${tagToken({ tagKind: "skill", name: "tdd", projectId: "" })} on ${tagToken({ tagKind: "file", projectId: "p1", path: "src/a.ts", line: 24 })} for ${tagToken({ tagKind: "pr", slug: "o/r", number: 7 })}`;
    render(<Bubble text="(projected)" composerText={composer} />);
    fireEvent.click(copyBtn() as HTMLElement);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Run /tdd on @src/a.ts#L24 for o/r#7");
    });
  });

  it.each([
    { name: "a steer", steer: true, queued: false, line: ["thread-copy-prompt", "thread-steer-caption"] },
    { name: "a queued steer", steer: true, queued: true, line: ["thread-copy-prompt", "thread-steer-caption"] },
    { name: "a queued message", steer: false, queued: true, line: ["thread-copy-prompt", "inline-flex items-center gap-1.5"] },
  ])("$name has it before its caption, on the same line", ({ steer, queued, line }) => {
    render(<Bubble steer={steer} queued={queued} />);
    expect(metaLine()).toEqual(line);
    const meta = copyBtn()?.closest(".u-meta");
    expect(meta?.querySelector('[data-testid="thread-queued"]') !== null).toBe(queued);
    if (steer) expect(screen.getByTestId("thread-steer-caption").textContent).toContain("sent mid-turn");
  });

  it("a message with only attachments has none, and its time stands alone", () => {
    render(<Bubble text="[Image: a.png]" composerText={tagToken({ tagKind: "image", id: "0", name: "a.png" })} attachments={["/att/0a.png"]} />);
    expect(copyBtn()).toBeNull();
    expect(document.querySelector(".u-meta")).toBeNull();
    expect(document.querySelector(".u > .when")).not.toBeNull();
  });

  it("a bubble outside a timeline (no fold key: the search preview, the theme gallery) has none", () => {
    render(<Bubble foldKey={undefined} />);
    expect(copyBtn()).toBeNull();
  });
});
