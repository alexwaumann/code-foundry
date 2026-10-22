import { describe, expect, it } from "vitest";
import { memoryBy, rememberedWhen } from "./memory";

describe("memoryBy", () => {
  const origin = { kind: "thread" as const, threadId: "s-1", threadName: "Old name" };
  it.each([
    ["the user", { kind: "user" as const }, undefined, { kind: "user" }],
    ["a live thread by its current name", origin, { name: "New name", archivedAtMs: null }, { kind: "thread", id: "s-1", name: "New name", state: "live" }],
    ["an unnamed thread by its id", origin, { name: "", archivedAtMs: null }, { kind: "thread", id: "s-1", name: "s-1", state: "live" }],
    ["an archived thread", origin, { name: "New name", archivedAtMs: 5 }, { kind: "thread", id: "s-1", name: "New name", state: "archived" }],
    ["a removed thread by its recorded name", origin, undefined, { kind: "thread", id: "s-1", name: "Old name", state: "removed" }],
    ["a removed unnamed thread by its id", { ...origin, threadName: "" }, undefined, { kind: "thread", id: "s-1", name: "s-1", state: "removed" }],
  ])("%s", (_name, o, thread, want) => {
    expect(memoryBy(o, thread)).toEqual(want);
  });
});

describe("rememberedWhen", () => {
  // Thursday 2026-10-22 15:00 local.
  const now = new Date(2026, 9, 22, 15, 0).getTime();
  it.each([
    ["unknown", null, ""],
    ["seconds ago", now - 20_000, "just now"],
    ["in the future", now + 60_000, "just now"],
    ["minutes ago", now - 5 * 60_000, "5 min ago"],
    ["earlier today", new Date(2026, 9, 22, 0, 30).getTime(), "today"],
    ["yesterday late", new Date(2026, 9, 21, 23, 59).getTime(), "yesterday"],
    ["three days ago", new Date(2026, 9, 19, 9, 0).getTime(), "3 days ago"],
    ["a week ago", new Date(2026, 9, 14, 9, 0).getTime(), "on Oct 14"],
    ["another year", new Date(2025, 11, 31, 9, 0).getTime(), "on Dec 31, 2025"],
  ])("%s", (_name, ms, want) => {
    expect(rememberedWhen(ms, now)).toBe(want);
  });
});
