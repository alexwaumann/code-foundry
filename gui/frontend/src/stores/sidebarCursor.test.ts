import { beforeEach, describe, expect, it } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";
import type { ThreadView } from "@/api/threads";

const { selectedRowKey } = await import("./sidebarCursor");
const { resetLayout } = await import("./layout");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");

// Only what sidebarAnchor reads: s-3 is s-1's hidden child.
const threads = { "s-1": { id: "s-1", createdBy: "" }, "s-2": { id: "s-2", createdBy: "" }, "s-3": { id: "s-3", createdBy: "s-1" }, "s-4": { id: "s-4", createdBy: "" } } as unknown as Record<string, ThreadView>;

const cursor = () => useUiStore.getState().cursorKey;
const select = (id: string): void => {
  useUiStore.getState().select({ kind: "thread", id });
};

async function focusDraft(draft: string): Promise<void> {
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-c", "compose", "", { params: draft ? { draft } : {} })]), "p-1")]));
}

beforeEach(async () => {
  resetLayout();
  useThreadsStore.setState({ byId: threads, order: Object.keys(threads), loaded: true });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" }, cursorKey: null });
  await focusDraft("");
});

/** No list is mounted in any case: the rule is the stores' (docs/notes/shell-reset-rules.md). */
describe("the sidebar cursor and the highlighted row", () => {
  it("reads the highlighted row: a hidden child's anchor, else the focused draft", async () => {
    expect(selectedRowKey()).toBe("s:s-1");
    select("s-3");
    expect(selectedRowKey()).toBe("s:s-1");
    useUiStore.setState({ selection: { kind: "home" } as never });
    expect(selectedRowKey()).toBeNull();
    await focusDraft("d-1");
    expect(selectedRowKey()).toBe("d:d-1");
  });

  it.each([
    { name: "another thread selected elsewhere drops it", cursorAt: "s:s-2", then: () => { select("s-4"); }, want: null },
    { name: "the highlight going (a page) drops it", cursorAt: "s:s-2", then: () => { useUiStore.setState({ selection: { kind: "home" } as never }); }, want: null },
    { name: "a row opened from the cursor keeps it", cursorAt: "s:s-2", then: () => { select("s-2"); }, want: "s:s-2" },
    { name: "the selection moving within its row (a hidden child) keeps it", cursorAt: "s:s-2", then: () => { select("s-3"); }, want: "s:s-2" },
    { name: "the threads changing without moving the highlight keeps it", cursorAt: "s:s-2", then: () => { useThreadsStore.setState({ byId: { ...threads } }); }, want: "s:s-2" },
    { name: "Ember's row keeps the cursor until the highlight moves", cursorAt: "ember", then: () => { useUiStore.setState({ sidebarFocusSeq: 1 }); }, want: "ember" },
    { name: "Ember's row loses it when the highlight moves", cursorAt: "ember", then: () => { select("s-2"); }, want: null },
  ])("$name", ({ cursorAt, then, want }) => {
    useUiStore.getState().setCursor(cursorAt);
    then();
    expect(cursor()).toBe(want);
  });

  it("a draft's composer taking the focus drops a cursor on a thread", async () => {
    useUiStore.setState({ selection: { kind: "home" } as never });
    useUiStore.getState().setCursor("s:s-2");
    await focusDraft("d-1");
    expect(cursor()).toBeNull();
  });

  it("a cursor set with the selection in one step (the linked PRs tag) stays on the row it opens", () => {
    useUiStore.getState().setCursor("s:s-2");
    select("s-2");
    select("s-2");
    expect(cursor()).toBe("s:s-2");
    select("s-1");
    expect(cursor()).toBeNull();
  });

  it("a cursor set after the highlight moved is set against the new one", () => {
    select("s-2");
    useUiStore.getState().setCursor("s:s-1");
    useThreadsStore.setState({ byId: { ...threads } });
    expect(cursor()).toBe("s:s-1");
  });
});
