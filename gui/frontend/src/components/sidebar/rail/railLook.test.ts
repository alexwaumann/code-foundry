import { describe, expect, it } from "vitest";
import type { StatusLine } from "@/lib/statusLine";
import { edgeMask, RAIL_WIDTH, railGroupHeight, railThreadLook } from "./railLook";

const line = (kind: StatusLine["kind"]) => ({ kind }) as StatusLine;

describe("railThreadLook", () => {
  it.each([
    ["needs", "input", "input", "text-cf-warning-text"],
    ["needs", "question", "question", "text-cf-warning-text"],
    ["needs", "plan", "plan", "text-cf-warning-text"],
    ["attention", "error", "error", "text-cf-error-text"],
    ["attention", "interrupted", "interrupted", "text-cf-error-text"],
    ["done", "finished", "finished", "text-cf-success-text"],
    ["attention", "snoozeEnded", "snoozeEnded", "text-cf-warning-text"],
    // A row that would show only a time: the thread's icon, muted.
    ["idle", "place", "thread", "text-cf-sidebar-muted-foreground"],
    ["pinned", "place", "thread", "text-cf-sidebar-muted-foreground"],
  ] as const)("%s row, %s: %s in %s", (section, kind, want, tone) => {
    const look = railThreadLook(section, line(kind));
    expect(look.kind).toBe(want);
    expect(look.tone).toBe(tone);
  });
});

describe("the rail's sizes", () => {
  it("is the shell gap plus a 28px column; a group of n icons is n targets of 26 with 2px between", () => {
    expect(RAIL_WIDTH).toBe(40);
    expect(railGroupHeight(0)).toBe(0);
    expect(railGroupHeight(1)).toBe(26);
    expect(railGroupHeight(4)).toBe(110);
  });
});

describe("edgeMask", () => {
  it("fades only the edge with more to scroll to", () => {
    expect(edgeMask(false, false)).toBeUndefined();
    expect(edgeMask(false, true)).toBe("linear-gradient(to bottom, #000 0, #000 calc(100% - 20px), transparent 100%)");
    expect(edgeMask(true, false)).toBe("linear-gradient(to bottom, transparent 0, #000 20px, #000 100%)");
    expect(edgeMask(true, true)).toBe("linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 20px), transparent 100%)");
  });
});
