import { describe, expect, it } from "vitest";
import { createdUnder, inSidebar, leadOf, sidebarAnchor, threadFocus, type SidebarFields, type ThreadsById } from "./inSidebar";

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

describe("leadOf and createdUnder (the thread a linked surface names)", () => {
  const t = (id: string, createdBy = "") => ({ id, createdBy });
  // "archived" is archived: still in the list. "gone" and "gone-mid" were removed.
  const byId = Object.fromEntries(
    [t("lead"), t("child", "lead"), t("grand", "child"), t("archived"), t("arch-child", "archived"), t("orphan", "gone"), t("under-orphan", "orphan"), t("lone", "gone-mid"), t("loop-a", "loop-b"), t("loop-b", "loop-a")].map((x) => [x.id, x]),
  );
  const leads: [string, string, string][] = [
    ["the lead names itself", "lead", "lead"],
    ["a child of a live lead: the lead", "child", "lead"],
    ["a grandchild: the root lead, not its creator", "grand", "lead"],
    ["a child of an archived lead: the archived lead", "arch-child", "archived"],
    ["a child whose lead was removed: itself", "orphan", "orphan"],
    ["under a removed lead: the highest thread left", "under-orphan", "orphan"],
    ["its creator (the middle thread) removed: itself", "lone", "lone"],
    ["a creator cycle: itself", "loop-a", "loop-a"],
    ["an unknown thread: itself", "nope", "nope"],
  ];
  it.each(leads)("leadOf: %s", (_name, id, want) => {
    expect(leadOf(byId, id)).toBe(want);
  });

  const under: [string, string, string, boolean][] = [
    ["a child", "child", "lead", true],
    ["a grandchild, from the root", "grand", "lead", true],
    ["a grandchild, from its creator", "grand", "child", true],
    ["the thread itself", "lead", "lead", false],
    ["a creator is not under its child", "lead", "child", false],
    ["an archived lead's child", "arch-child", "archived", true],
    ["another lead's thread", "arch-child", "lead", false],
    ["past a removed creator", "lone", "gone-mid", false],
    ["a cycle ends", "loop-a", "lead", false],
    ["an unknown thread", "nope", "lead", false],
  ];
  it.each(under)("createdUnder: %s", (_name, id, ancestor, want) => {
    expect(createdUnder(byId, id, ancestor)).toBe(want);
  });
});
