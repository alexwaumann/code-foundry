// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchActivityView } from "@/api/search";

const startCommandNamed = vi.hoisted(() => vi.fn<(name: string, args?: Record<string, string>) => boolean>());
vi.mock("@/keys/bindings", () => ({ startCommandNamed }));

const { applySearchActivity, useSearchActivityStore } = await import("@/stores/searchActivity");
const { useUiStore } = await import("@/stores/ui");
const { SearchNav } = await import("./SearchNav");

const none: SearchActivityView = { runningId: "", unseenId: "", unseenStatus: "done", unseenHits: 0 };
const say = (a: SearchActivityView) => {
  act(() => {
    applySearchActivity(a);
  });
};
const row = () => screen.queryByTestId("nav-search");

beforeEach(() => {
  startCommandNamed.mockReset();
  useSearchActivityStore.setState({ activity: null });
  render(<SearchNav />);
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

describe("SearchNav", () => {
  it("takes no space with nothing to say", () => {
    expect(row()).toBeNull();
    say(none);
    expect(row()).toBeNull();
  });

  it("running: the words and a spinner, no count", () => {
    say({ ...none, runningId: "q-r" });
    expect(row()?.textContent).toBe("Searching…");
    expect(screen.getByTestId("nav-search-spinner")).toBeTruthy();
    expect(screen.queryByTestId("nav-search-count")).toBeNull();
  });

  it("finished unseen: the amber count, no spinner", () => {
    say({ ...none, unseenId: "q-d", unseenHits: 5 });
    expect(row()?.textContent).toBe("Search results5");
    expect(screen.getByTestId("nav-search-count").className).toContain("bg-cf-warning-surface");
    expect(screen.queryByTestId("nav-search-spinner")).toBeNull();
  });

  it("no hits: words alone; a failure in the error tone", () => {
    say({ ...none, unseenId: "q-d" });
    expect(row()?.textContent).toBe("No search results");
    expect(screen.queryByTestId("nav-search-count")).toBeNull();
    say({ ...none, unseenId: "q-f", unseenStatus: "failed" });
    expect(row()?.textContent).toBe("Search failed");
    expect(screen.getByText("Search failed").className).toContain("text-cf-error-text");
  });

  it("a click runs search.open on the search the row shows", () => {
    say({ ...none, runningId: "q-r", unseenId: "q-d", unseenHits: 2 });
    fireEvent.click(screen.getByTestId("nav-search"));
    expect(startCommandNamed.mock.calls).toEqual([["search.open", { id: "q-d" }]]);
    say({ ...none, runningId: "q-r" });
    fireEvent.click(screen.getByTestId("nav-search"));
    expect(startCommandNamed.mock.calls[1]).toEqual(["search.open", { id: "q-r" }]);
  });

  it("hidden while the dialog is open, back on close; the palette's other pages leave it", () => {
    say({ ...none, runningId: "q-r" });
    act(() => {
      useUiStore.getState().openSearchPalette();
    });
    expect(row()).toBeNull();
    act(() => {
      useUiStore.getState().closePalette();
    });
    expect(row()).not.toBeNull();
    act(() => {
      useUiStore.getState().openPalette();
    });
    expect(row()).not.toBeNull();
  });

  it("seen elsewhere, the next unseen, and a restart's snapshot each replace what it said", () => {
    say({ ...none, unseenId: "q-d", unseenHits: 3 });
    // Opening one: the other unseen one stays on the row.
    say({ ...none, unseenId: "q-e", unseenHits: 1 });
    expect(row()?.textContent).toBe("Search results1");
    // Seen from the CLI, or forgotten.
    say(none);
    expect(row()).toBeNull();
    // A run the daemon lost: its snapshot has no running id, so "Searching…" cannot stay.
    say({ ...none, runningId: "q-r" });
    say({ ...none, unseenId: "q-r", unseenStatus: "failed" });
    expect(row()?.textContent).toBe("Search failed");
  });
});
