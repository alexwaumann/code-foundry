import { describe, expect, it } from "vitest";
import { coldCacheNote, fmtRereadUsd, type ColdCacheInput } from "./coldCache";

const EXPIRES = Date.UTC(2026, 9, 12, 10, 0, 0);

function input(o: Partial<ColdCacheInput> = {}): ColdCacheInput {
  return {
    state: "connected",
    status: "idle",
    contextTokens: 25_700,
    cacheExpiresAtMs: EXPIRES,
    contextRereadUsd: 0.0771,
    pending: 0,
    phase: "idle",
    nowMs: EXPIRES + 60_000,
    ...o,
  };
}

const NOTE = "Cache expired · the next message re-reads 25.7K tokens (~$0.08)";

describe("coldCacheNote", () => {
  it.each<[string, Partial<ColdCacheInput>, string | null]>([
    ["an idle thread past its expiry", {}, NOTE],
    ["exactly at the expiry", { nowMs: EXPIRES }, NOTE],
    ["a finished turn not seen yet is idle enough", { status: "attention" }, NOTE],
    ["unknown status while connected", { status: "unknown" }, NOTE],
    ["before the expiry", { nowMs: EXPIRES - 1 }, null],
    // Whether Claude runs does not matter; after the idle stop every stopped thread is past expiry.
    ["stopped at its prompt", { state: "disconnected" }, NOTE],
    ["stopped with a finished turn", { state: "disconnected", status: "attention" }, NOTE],
    ["stopped, status unknown", { state: "disconnected", status: "unknown" }, NOTE],
    ["stopped with a busy left by an older daemon", { state: "disconnected", status: "busy" }, NOTE],
    ["stopping", { state: "closing" }, NOTE],
    ["stopped, before the expiry", { state: "disconnected", nowMs: EXPIRES - 1 }, null],
    // Starting for a message just sent is working.
    ["starting", { state: "starting" }, null],
    ["starting after a finished turn", { state: "starting", status: "attention" }, null],
    ["Claude is working", { status: "busy" }, null],
    ["a prompt is pending", { pending: 1 }, null],
    ["a send is starting", { phase: "starting" }, null],
    ["images are attaching", { phase: "attaching" }, null],
    ["no result yet: no expiry", { cacheExpiresAtMs: null }, null],
    ["no result yet: no tokens", { contextTokens: 0 }, null],
    ["an unpriced model leaves the cost out", { contextRereadUsd: 0 }, "Cache expired · the next message re-reads 25.7K tokens"],
    ["a tiny cost", { contextTokens: 950, contextRereadUsd: 0.0019 }, "Cache expired · the next message re-reads 950 tokens (<$0.01)"],
    ["a big context", { contextTokens: 812_345, contextRereadUsd: 8.12 }, "Cache expired · the next message re-reads 812K tokens (~$8.12)"],
  ])("%s", (_, o, want) => {
    expect(coldCacheNote(input(o))).toBe(want);
  });
});

describe("fmtRereadUsd", () => {
  it.each<[number, string]>([
    [0.0001, "<$0.01"],
    [0.0099, "<$0.01"],
    [0.01, "~$0.01"],
    [0.0771, "~$0.08"],
    [1234.5, "~$1,234.50"],
  ])("%s → %s", (v, want) => {
    expect(fmtRereadUsd(v)).toBe(want);
  });
});
