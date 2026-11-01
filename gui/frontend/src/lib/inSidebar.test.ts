import { describe, expect, it } from "vitest";
import { inSidebar, NEW_THREAD_FOCUS_MS, sidebarAnchor, threadFocus, type SidebarFields, type ThreadsById } from "./inSidebar";

describe("inSidebar", () => {
  const byId: ThreadsById = { p: {}, archived: {} };
  const cases: [string, SidebarFields, boolean][] = [
    ["the user's thread (no creator)", { createdBy: "" }, true],
    ["a created thread, its creator present", { createdBy: "p" }, false],
    // Archived threads are in the list: an archived creator still exists.
    ["a created thread, its creator archived", { createdBy: "archived" }, false],
    ["a created thread, its creator removed", { createdBy: "gone" }, true],
  ];
  it.each(cases)("%s", (_name, t, want) => {
    expect(inSidebar(t, byId)).toBe(want);
  });
});

describe("threadFocus (a focusThread intent)", () => {
  const now = 1_000_000;
  const byId: ThreadsById = { p: {} };
  const t = (createdBy: string, agoMs: number | null) => ({ createdBy, createdAtMs: agoMs === null ? null : now - agoMs });
  const cases: [string, ReturnType<typeof t> | undefined, "select" | "skip" | "wait"][] = [
    ["not in the list yet: wait for it", undefined, "wait"],
    ["the user's new thread", t("", 0), "select"],
    ["a new created thread", t("p", 50), "skip"],
    ["a new thread whose creator is gone", t("gone", 50), "select"],
    ["a hidden thread without a creation time", t("p", null), "skip"],
    ["a hidden thread just under the window", t("p", NEW_THREAD_FOCUS_MS - 1), "skip"],
    ["an older hidden thread: an explicit thread.focus", t("p", NEW_THREAD_FOCUS_MS), "select"],
  ];
  it.each(cases)("%s", (_name, thread, want) => {
    expect(threadFocus(thread, byId, now)).toBe(want);
  });
});

describe("sidebarAnchor", () => {
  const t = (id: string, createdBy = "") => ({ id, createdBy });
  const byId = Object.fromEntries(
    [t("root"), t("child", "root"), t("grand", "child"), t("orphan", "gone"), t("under-orphan", "orphan"), t("loop-a", "loop-b"), t("loop-b", "loop-a")].map((x) => [x.id, x]),
  );
  const cases: [string, string, string | null][] = [
    ["a shown thread is its own row", "root", "root"],
    ["a hidden child: its creator", "child", "root"],
    ["a hidden grandchild: the nearest shown ancestor", "grand", "root"],
    ["a removed creator: the orphan is its own row", "orphan", "orphan"],
    ["a child of an orphan: the orphan", "under-orphan", "orphan"],
    ["an unknown thread: none", "nope", null],
    ["a creator cycle: none", "loop-a", null],
  ];
  it.each(cases)("%s", (_name, id, want) => {
    expect(sidebarAnchor(byId, id)).toBe(want);
  });
});
