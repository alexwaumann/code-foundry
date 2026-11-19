import { describe, expect, it } from "vitest";
import { canMarkUnread, type MarkUnreadFacts } from "./markUnread";

const idle: MarkUnreadFacts = { status: "idle", statusReason: "at prompt", state: "connected", archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, setup: null };

describe("canMarkUnread", () => {
  it.each<[string, Partial<MarkUnreadFacts>, boolean]>([
    ["idle at its prompt", {}, true],
    ["stopped, idle at its prompt", { state: "disconnected" }, true],
    ["working", { status: "busy", statusReason: "working" }, false],
    ["starting", { state: "starting" }, false],
    ["asking", { status: "attention", statusReason: "permission: Bash ls" }, false],
    ["already Done", { status: "attention", statusReason: "finished" }, false],
    ["in error", { status: "error", statusReason: "interrupted" }, false],
    ["waiting on a child", { statusReason: "waiting on 1 child thread" }, false],
    ["archived", { archivedAtMs: 1 }, false],
    ["snoozed", { snoozedUntilMs: 1 }, false],
    ["saved for later", { savedAtMs: 1 }, false],
    ["setting up", { setup: { phase: "running" } as MarkUnreadFacts["setup"] }, false],
    ["a setup that finished", { setup: { phase: "done" } as MarkUnreadFacts["setup"] }, true],
  ])("%s", (_, over, want) => {
    expect(canMarkUnread({ ...idle, ...over })).toBe(want);
  });

  it("no thread", () => {
    expect(canMarkUnread(undefined)).toBe(false);
  });
});
