import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchEntryView } from "@/api/search";

const getSearch = vi.hoisted(() => vi.fn<(id: string) => Promise<Partial<SearchEntryView>>>());
vi.mock("@/api/search", async (orig) => ({ ...(await orig<typeof import("@/api/search")>()), getSearch }));

const { presentSearch } = await import("./threadSearch");
const { useSearchDialogStore } = await import("./searchDialog");
const { useUiStore } = await import("./ui");

const settled = () => new Promise((r) => setTimeout(r, 0));
const opened = () => {
  const p = useUiStore.getState().palette;
  return p.open && p.page === "search";
};

beforeEach(() => {
  getSearch.mockReset();
  useSearchDialogStore.setState({ target: null, targetSeq: 0 });
});

afterEach(() => {
  useUiStore.getState().closePalette();
});

describe("presentSearch", () => {
  it("no id: opens with no read and no target", async () => {
    expect(presentSearch()).toBe(true);
    await settled();
    expect(opened()).toBe(true);
    expect(getSearch).not.toHaveBeenCalled();
    expect(useSearchDialogStore.getState().target).toBeNull();
  });

  it("an id: reads the search, then opens on it; each target counts, so an open dialog goes to it", async () => {
    getSearch.mockResolvedValue({ id: "q-1", mode: "agent", query: "why?" });
    presentSearch("q-1");
    expect(opened()).toBe(false);
    await settled();
    expect(opened()).toBe(true);
    expect(useSearchDialogStore.getState()).toMatchObject({ target: { id: "q-1", query: "why?" }, targetSeq: 1 });
  });

  it.each<[string, () => void]>([
    ["forgotten meanwhile", () => getSearch.mockRejectedValue(new Error("not found"))],
    ["a Find entry", () => getSearch.mockResolvedValue({ id: "q-f", mode: "find", query: "x" })],
  ])("%s: opens as the chord does", async (_name, arrange) => {
    arrange();
    presentSearch("q-x");
    await settled();
    expect(opened()).toBe(true);
    expect(useSearchDialogStore.getState().target).toBeNull();
  });
});
