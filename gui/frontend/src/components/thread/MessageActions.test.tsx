import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryView } from "@/api/thread";
import { useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";

// A queued or not sent message's own controls (docs/notes/cancel-queued-messages.md): which
// show in which state, and which action each runs. That they keep the row's height and the
// caption's place: e2e thread-cancel-message.spec.ts.

const actions = vi.hoisted(() => ({ cancelThreadMessage: vi.fn(() => Promise.resolve(true)), resendNotSentMessage: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@/stores/threadActions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/stores/threadActions")>()), ...actions }));

const { UserBubble } = await import("./UserBubble");

beforeEach(() => {
  useThreadStore.setState({ expanded: {}, folds: {} });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function Bubble({ delivery, own = true, steer = true }: { delivery?: DeliveryView; own?: boolean; steer?: boolean }) {
  return (
    <ThreadContext.Provider value={{ threadId: "t1", cwd: "/" }}>
      <UserBubble text="Also add a README table" composerText="" attachments={[]} createdAtMs={0} steer={steer} delivery={delivery} foldKey="m1" messageId={own ? "m1" : undefined} />
    </ThreadContext.Provider>
  );
}

const words = () => [...(screen.queryByTestId("thread-message-actions")?.querySelectorAll("button") ?? [])].map((b) => b.textContent);

describe("a message's Cancel and Re-send", () => {
  it.each([
    ["queued: Cancel", "queued", ["Cancel"]],
    ["not sent: Re-send, then Cancel", "unsent", ["Re-send", "Cancel"]],
    ["read: none", "read", []],
    ["never queued: none", undefined, []],
  ] as const)("%s", (_, delivery, want) => {
    render(<Bubble delivery={delivery} />);
    expect(words()).toEqual(want);
  });

  it("a queued prompt-to-be (too late for its turn) has Cancel too", () => {
    render(<Bubble delivery="queued" steer={false} />);
    expect(words()).toEqual(["Cancel"]);
  });

  it("not on another thread's message, nor outside a timeline", () => {
    render(<Bubble delivery="queued" own={false} />);
    expect(words()).toEqual([]);
  });

  it("they lead the caption row, right before the caption, with no tooltip and no Copy between", () => {
    render(<Bubble delivery="unsent" />);
    const meta = screen.getByTestId("thread-message-actions").closest(".u-meta");
    expect([...(meta?.children ?? [])].map((k) => k.getAttribute("data-testid"))).toEqual(["thread-message-actions", "thread-steer-caption"]);
    expect(screen.getByTestId("thread-message-cancel").getAttribute("title")).toBeNull();
  });

  it("Cancel runs the cancel with the message as sent", () => {
    render(<Bubble delivery="queued" />);
    fireEvent.click(screen.getByTestId("thread-message-cancel"));
    expect(actions.cancelThreadMessage).toHaveBeenCalledWith("t1", "m1", { text: "Also add a README table", composerText: "", attachments: [] });
  });

  it("Re-send runs the re-send", () => {
    render(<Bubble delivery="unsent" />);
    fireEvent.click(screen.getByTestId("thread-message-resend"));
    expect(actions.resendNotSentMessage).toHaveBeenCalledWith("t1", "m1");
  });
});
