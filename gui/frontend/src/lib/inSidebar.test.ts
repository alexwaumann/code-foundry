import { describe, expect, it } from "vitest";
import { inSidebar, NEW_THREAD_FOCUS_MS, sidebarAnchor, threadFocus, type SidebarFields } from "./inSidebar";

describe("inSidebar", () => {
  const cases: [string, SidebarFields, boolean, boolean][] = [
    ["the user's thread, setting off", { createdBy: "", inSidebar: null }, false, true],
    ["the user's thread, setting on", { createdBy: "", inSidebar: null }, true, true],
    ["a created thread, no override, setting off", { createdBy: "p", inSidebar: null }, false, false],
    ["a created thread, no override, setting on", { createdBy: "p", inSidebar: null }, true, true],
    ["a created thread shown, setting off", { createdBy: "p", inSidebar: true }, false, true],
    ["a created thread shown, setting on", { createdBy: "p", inSidebar: true }, true, true],
    ["a created thread hidden, setting off", { createdBy: "p", inSidebar: false }, false, false],
    ["a created thread hidden, setting on", { createdBy: "p", inSidebar: false }, true, false],
    // The daemon never sends an override on the user's own thread; no creator wins anyway.
    ["the user's thread with a stray false", { createdBy: "", inSidebar: false }, false, true],
  ];
  it.each(cases)("%s", (_name, t, showCreated, want) => {
    expect(inSidebar(t, showCreated)).toBe(want);
  });
});

describe("threadFocus (a focusThread intent)", () => {
  const now = 1_000_000;
  const t = (createdBy: string, over: boolean | null, agoMs: number | null) => ({ createdBy, inSidebar: over, createdAtMs: agoMs === null ? null : now - agoMs });
  const cases: [string, ReturnType<typeof t> | undefined, boolean, "select" | "skip" | "wait"][] = [
    ["not in the list yet: wait for it", undefined, false, "wait"],
    ["the user's new thread", t("", null, 0), false, "select"],
    ["a new created thread, hidden by the setting", t("p", null, 50), false, "skip"],
    ["a new created thread, the setting on", t("p", null, 50), true, "select"],
    ["a new created thread with --sidebar", t("p", true, 50), false, "select"],
    ["a new created thread with --sidebar=false, the setting on", t("p", false, 50), true, "skip"],
    ["a hidden thread without a creation time", t("p", null, null), false, "skip"],
    ["a hidden thread just under the window", t("p", null, NEW_THREAD_FOCUS_MS - 1), false, "skip"],
    ["an older hidden thread: an explicit thread.focus", t("p", null, NEW_THREAD_FOCUS_MS), false, "select"],
  ];
  it.each(cases)("%s", (_name, thread, showCreated, want) => {
    expect(threadFocus(thread, showCreated, now)).toBe(want);
  });
});

describe("sidebarAnchor", () => {
  const t = (id: string, createdBy = "", over: boolean | null = null) => ({ id, createdBy, inSidebar: over });
  const byId = Object.fromEntries(
    [
      t("root"),
      t("child", "root"),
      t("grand", "child"),
      t("shown", "root", true),
      t("under-shown", "shown"),
      t("orphan", "gone"),
      t("loop-a", "loop-b"),
      t("loop-b", "loop-a"),
    ].map((x) => [x.id, x]),
  );
  const cases: [string, string, boolean, string | null][] = [
    ["a shown thread is its own row", "root", false, "root"],
    ["a hidden child: its creator", "child", false, "root"],
    ["a hidden grandchild: the nearest shown ancestor", "grand", false, "root"],
    ["a hidden thread under a shown child: that child", "under-shown", false, "shown"],
    ["a shown child is its own row", "shown", false, "shown"],
    ["the setting on: every thread is its own row", "grand", true, "grand"],
    ["a removed creator: none", "orphan", false, null],
    ["an unknown thread: none", "nope", false, null],
    ["a creator cycle: none", "loop-a", false, null],
  ];
  it.each(cases)("%s", (_name, id, showCreated, want) => {
    expect(sidebarAnchor(byId, id, showCreated)).toBe(want);
  });
});
