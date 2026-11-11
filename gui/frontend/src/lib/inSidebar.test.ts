import { describe, expect, it } from "vitest";
import { inSidebar, sidebarAnchor, threadFocus, type SidebarFields, type ThreadsById } from "./inSidebar";

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
  const byId: ThreadsById = { p: {} };
  const t = (createdBy: string): SidebarFields => ({ createdBy });
  const cases: [string, SidebarFields | undefined, boolean, "select" | "skip" | "wait"][] = [
    ["not in the list yet: wait for it", undefined, false, "wait"],
    ["not in the list yet, explicit: wait for it too", undefined, true, "wait"],
    ["the user's thread", t(""), false, "select"],
    ["a hidden child (its creator exists)", t("p"), false, "skip"],
    ["a hidden child, explicit (thread.focus)", t("p"), true, "select"],
    ["a child whose creator is gone (shown)", t("gone"), false, "select"],
  ];
  it.each(cases)("%s", (_name, thread, explicit, want) => {
    expect(threadFocus(thread, byId, explicit)).toBe(want);
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
