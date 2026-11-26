import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { dismissNotice, notify, notifyProgress } from "./notify";
import { dropToasterTimers } from "@/test/toaster";

/**
 * notify over a real Toaster (sonner cannot be spied on, docs/notes/testing-gotchas.md):
 * each level is its own card, the options land where the card shows them, a progress toast
 * turns into its result in place, and dismiss takes toasts down.
 */

const toasts = () => [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];

function toastOf(title: string): HTMLElement {
  const el = toasts().find((t) => t.querySelector("[data-title]")?.textContent === title);
  if (!el) throw new Error(`no toast "${title}"`);
  return el;
}

const shown = (title: string) => waitFor(() => toastOf(title));

dropToasterTimers(); // before the file's hooks: the Toaster mounts on fake timers

beforeEach(() => {
  render(<Toaster />);
});

// sonner takes a dismissed toast out on a timer of its own. Left running, it fires after the
// file's jsdom is gone ("window is not defined", an unhandled error that fails the run), so
// each test waits for the toasts to be gone before it unmounts the Toaster.
afterEach(async () => {
  act(() => {
    dismissNotice();
  });
  await waitFor(() => {
    expect(toasts()).toHaveLength(0);
  });
  cleanup();
});

describe("notify", () => {
  it.each(["success", "info", "warning", "error"] as const)("shows a %s toast with its level's icon", async (level) => {
    act(() => {
      notify({ level, title: `A ${level}` });
    });
    const t = await shown(`A ${level}`);
    expect(t.dataset.type).toBe(level);
    expect(t.querySelector("[data-icon] svg")).not.toBeNull();
    expect(t.querySelector("[data-description]")).toBeNull();
    expect(t.querySelector("[data-close-button]")).toBeNull();
  });

  it("puts the description under the title", async () => {
    act(() => {
      notify({ level: "error", title: "Could not delete api", description: "directory not empty" });
    });
    const t = await shown("Could not delete api");
    expect(t.querySelector("[data-content] [data-description]")?.textContent).toBe("directory not empty");
  });

  it("renders a node description", async () => {
    act(() => {
      notify({ level: "success", title: "Pushed", description: <span data-testid="rich">main to origin</span> });
    });
    const t = await shown("Pushed");
    expect(t.querySelector("[data-testid=rich]")?.textContent).toBe("main to origin");
  });

  it("runs a button's onClick, cancel before action, and closes the toast", async () => {
    const open = vi.fn();
    const reveal = vi.fn();
    act(() => {
      notify({ level: "success", title: "Saved a.md", action: { label: "Open", onClick: open }, cancel: { label: "Show in Finder", onClick: reveal } });
    });
    const t = await shown("Saved a.md");
    expect([...t.querySelectorAll("button[data-button]")].map((b) => b.textContent)).toEqual(["Show in Finder", "Open"]);
    fireEvent.click(t.querySelector("button[data-action]") as HTMLElement);
    expect(open).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(toasts().filter((x) => x.dataset.removed !== "true")).toHaveLength(0);
    });
  });

  it("a row of buttons in order, the first the strong one; each runs its onClick and closes the toast", async () => {
    const calls: string[] = [];
    const button = (label: string) => ({ label, onClick: () => calls.push(label) });
    act(() => {
      notify({ level: "info", title: "Deploy waiting", buttons: [button("Continue"), button("Abort"), button("Open build")], cancel: { label: "Ignored", onClick: vi.fn() } });
    });
    const t = await shown("Deploy waiting");
    const row = [...t.querySelectorAll<HTMLElement>("[data-notice-buttons] button")];
    expect(row.map((b) => b.textContent)).toEqual(["Continue", "Abort", "Open build"]);
    expect(row[0]?.className).toContain("bg-cf-text ");
    expect(row[1]?.className).toContain("bg-cf-text/10");
    // The row replaces sonner's own pair.
    expect(t.querySelector("button[data-cancel]")).toBeNull();
    fireEvent.click(row[1] as HTMLElement);
    expect(calls).toEqual(["Abort"]);
    await waitFor(() => {
      expect(toasts().filter((x) => x.dataset.removed !== "true")).toHaveLength(0);
    });
  });

  it("a closable toast has the close button and still times out", async () => {
    act(() => {
      notify({ level: "info", title: "Assigned", closable: true, duration: 50 });
    });
    const t = await shown("Assigned");
    expect(t.querySelector("[data-close-button]")).not.toBeNull();
    await waitFor(() => {
      expect(toasts().filter((x) => x.dataset.removed !== "true")).toHaveLength(0);
    });
  });

  it("a sticky toast has a close button, which takes it down", async () => {
    act(() => {
      notify({ level: "error", title: "Push failed", sticky: true });
    });
    const t = await shown("Push failed");
    fireEvent.click(t.querySelector("[data-close-button]") as HTMLElement);
    await waitFor(() => {
      expect(toasts().filter((x) => x.dataset.removed !== "true")).toHaveLength(0);
    });
  });

  it("a progress toast is a neutral spinner until a notify with its id replaces it in place", async () => {
    let id: string | number = "";
    act(() => {
      id = notifyProgress({ title: "Push main", description: "running" });
    });
    const t = await shown("Push main");
    expect(t.dataset.type).toBe("loading");
    expect(t.querySelector("[data-icon] .animate-spin")).not.toBeNull();
    act(() => {
      notify({ level: "error", id, title: "Push main failed", description: "rejected", sticky: true });
    });
    await waitFor(() => {
      expect(toastOf("Push main failed").dataset.type).toBe("error");
    });
    expect(toasts()).toHaveLength(1);
    expect(toastOf("Push main failed").querySelector("[data-description]")?.textContent).toBe("rejected");
    expect(toastOf("Push main failed").querySelector("[data-close-button]")).not.toBeNull();
  });

  it("a result that replaces a toast clears what it does not set", async () => {
    act(() => {
      notify({ level: "info", id: "x", title: "First", description: "more", action: { label: "Open", onClick: () => {} } });
    });
    await shown("First");
    act(() => {
      notify({ level: "success", id: "x", title: "Second" });
    });
    await waitFor(() => toastOf("Second"));
    expect(toastOf("Second").querySelector("[data-description]")).toBeNull();
    expect(toastOf("Second").querySelector("button[data-button]")).toBeNull();
  });

  it("dismisses one toast by id", async () => {
    act(() => {
      notify({ level: "info", id: "a", title: "A" });
      notify({ level: "info", id: "b", title: "B" });
    });
    await shown("B");
    act(() => {
      dismissNotice("a");
    });
    await waitFor(() => {
      expect(toasts().filter((x) => x.dataset.removed !== "true").map((x) => x.querySelector("[data-title]")?.textContent)).toEqual(["B"]);
    });
  });
});
