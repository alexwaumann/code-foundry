import { describe, expect, it } from "vitest";
import type { ThreadFlagView, ThreadStateView, ThreadStatusView } from "@/api/threads";
import { showsPlace, statusLine, statusText, statusTones, tipStatusTone } from "./statusLine";
import { threadGroup } from "./thread";

// A thread whose transcript Claude Code deleted (docs/notes/transcript-deleted.md): line 2
// says so in red before the place, and it sorts with the errors, whatever status it kept.
const errorFlag: ThreadFlagView = { plugin: "ci", pluginName: "CI", level: "attention", reason: "red", setAtMs: null, untilSeen: false };

describe("transcript deleted: line 2 and group", () => {
  it.each<[string, ThreadStateView, ThreadStatusView, string, ThreadFlagView[]]>([
    ["idle at its prompt", "disconnected", "idle", "at prompt", []],
    ["an unseen finished turn", "disconnected", "attention", "finished", []],
    ["interrupted", "disconnected", "error", "interrupted", []],
    ["a question lost with its process", "disconnected", "attention", "question: Which one?", []],
    ["a plugin's flag", "disconnected", "idle", "at prompt", [errorFlag]],
  ])("%s", (_name, state, status, statusReason, flags) => {
    const t = { state, status, statusReason, statusChangedAtMs: 1, flags, transcriptMissing: true as const };
    const l = statusLine(t);
    expect(l).toEqual({ kind: "transcriptDeleted", detail: "", at: null });
    expect(statusText(l, 0)).toBe("Transcript deleted");
    expect(threadGroup(t)).toBe("error");
  });

  it("is red, keeps the place after it, and gets the tooltip's red status row", () => {
    expect(statusTones.transcriptDeleted).toBe("red");
    expect(showsPlace("transcriptDeleted")).toBe(true);
    expect(tipStatusTone("transcriptDeleted")).toBe("red");
  });

  it("without the flag nothing changes", () => {
    const t = { state: "disconnected" as const, status: "idle" as const, statusReason: "at prompt", statusChangedAtMs: 1 };
    expect(statusLine(t).kind).toBe("place");
    expect(threadGroup(t)).toBe("idle");
  });
});
