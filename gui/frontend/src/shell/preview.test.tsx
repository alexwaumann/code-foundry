import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const runs: { name: string; args: Record<string, string> }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { keepPreviewTab, previewTabOf, useKeepPreviewOnDraft } = await import("./preview");
const { resetLayout, useLayoutStore } = await import("@/stores/layout");
const { updateDraft, useComposeStore } = await import("@/stores/compose");
const { threadDraftKey } = await import("@/lib/threadDraft");

/** s-1's tab a preview (or kept), beside s-2's kept tab. */
const layout = (preview: boolean, rev = 1) => layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1", { preview }), tab("t-2", "thread", "s-2")]), "p-1")], rev);
const type = (text: string) => {
  act(() => {
    updateDraft(threadDraftKey("s-1"), { text });
  });
};
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(async () => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: "" });
  });
  resetLayout();
  useComposeStore.setState({ drafts: {} });
  await seedLayout(layout(true));
});

afterEach(() => {
  cleanup();
  resetLayout();
});

describe("previewTabOf", () => {
  it("is the thread's tab when it is a preview, else nothing", async () => {
    expect(previewTabOf(useLayoutStore.getState(), "s-1")).toBe("t-1");
    expect(previewTabOf(useLayoutStore.getState(), "s-2")).toBe("");
    expect(previewTabOf(useLayoutStore.getState(), "")).toBe("");
    await seedLayout(layout(false, 2));
    expect(previewTabOf(useLayoutStore.getState(), "s-1")).toBe("");
  });
});

describe("keepPreviewTab", () => {
  it("runs tab.keep on a preview only", async () => {
    await keepPreviewTab("t-2");
    await keepPreviewTab("t-gone");
    expect(runs).toEqual([]);
    await keepPreviewTab("t-1");
    expect(runs).toEqual([{ name: "tab.keep", args: { tab: "t-1" } }]);
  });
});

describe("typing in a preview's composer (useKeepPreviewOnDraft)", () => {
  it("keeps it once, as soon as the draft holds text, not on every key", async () => {
    renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    type("h");
    type("he");
    type("hello");
    await flush();
    expect(runs).toEqual([{ name: "tab.keep", args: { tab: "t-1" } }]);
  });

  it("an attachment added (a paste of a file) keeps it too", async () => {
    renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    act(() => {
      updateDraft(threadDraftKey("s-1"), { attachments: [{ id: "a-1" }] as never });
    });
    await flush();
    expect(runs).toEqual([{ name: "tab.keep", args: { tab: "t-1" } }]);
  });

  it("a draft already there when it opens keeps nothing until it changes; blank text keeps nothing", async () => {
    updateDraft(threadDraftKey("s-1"), { text: "left from before" });
    renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    await flush();
    expect(runs).toEqual([]);
    type("");
    type("   ");
    await flush();
    expect(runs).toEqual([]);
    type("now");
    await flush();
    expect(runs).toEqual([{ name: "tab.keep", args: { tab: "t-1" } }]);
  });

  it("reading keeps nothing: the layout changing (focus, a scroll's rerender) with the draft unchanged", async () => {
    const { rerender } = renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    rerender();
    await seedLayout({ ...layout(true, 2), spaces: [space(pane("p-1", [tab("t-1", "thread", "s-1", { preview: true }), tab("t-2", "thread", "s-2")], "t-2"), "p-1")] });
    await flush();
    expect(runs).toEqual([]);
  });

  it("a kept tab's composer asks nothing", async () => {
    await seedLayout(layout(false, 2));
    renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    type("hello");
    await flush();
    expect(runs).toEqual([]);
  });

  it("a new preview of the same thread (closed and opened again) is kept anew", async () => {
    renderHook(() => {
      useKeepPreviewOnDraft("s-1");
    });
    type("a");
    await flush();
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-9", "thread", "s-1", { preview: true })]), "p-1")], 2));
    type("ab");
    await flush();
    expect(runs.map((r) => r.args.tab)).toEqual(["t-1", "t-9"]);
  });
});
