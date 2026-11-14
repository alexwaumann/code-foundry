// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_MS } from "@/lib/useCopied";
import { CopyButton } from "./copy-button";

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  notify.mockReset();
  writeText.mockReset();
  writeText.mockImplementation(() => Promise.resolve());
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Clicks the button and lets the clipboard's promise settle. */
async function press(name: string): Promise<HTMLElement> {
  const btn = screen.getByRole("button", { name });
  await act(async () => {
    fireEvent.click(btn);
    await Promise.resolve();
  });
  return btn;
}

describe("CopyButton", () => {
  it("shows a check in the success colour and reads Copied, then returns, with no toast", async () => {
    vi.useFakeTimers();
    render(<CopyButton text="/w/a/file.ts" label="Copy path" testId="copy" />);
    const btn = await press("Copy path");
    expect(writeText).toHaveBeenCalledWith("/w/a/file.ts");
    expect(btn.getAttribute("aria-label")).toBe("Copied");
    expect(btn.dataset.copied).toBe("true");
    const icon = btn.querySelector("svg");
    expect(icon?.classList.contains("text-cf-success-text")).toBe(true);
    expect(icon?.classList.contains("lucide-check")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(COPIED_MS - 1);
    });
    expect(btn.getAttribute("aria-label")).toBe("Copied");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(btn.getAttribute("aria-label")).toBe("Copy path");
    expect(btn.dataset.copied).toBeUndefined();
    expect(btn.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reads a function's text on press", async () => {
    let text = "first";
    render(<CopyButton text={() => text} label="Copy diff" />);
    text = "second";
    await press("Copy diff");
    expect(writeText).toHaveBeenCalledWith("second");
  });

  it("a failed copy keeps the copy icon and toasts Copy failed", async () => {
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    Object.defineProperty(document, "execCommand", {
      value: () => {
        throw new Error("no");
      },
      configurable: true,
    });
    render(<CopyButton text="x" label="Copy" />);
    const btn = await press("Copy");
    await act(async () => {
      await Promise.resolve();
    });
    expect(btn.getAttribute("aria-label")).toBe("Copy");
    expect(btn.dataset.copied).toBeUndefined();
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "Copy failed" });
  });
});
