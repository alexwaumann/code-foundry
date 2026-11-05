import { describe, expect, it } from "vitest";
import { COMPACT_OFFER_TOKENS, compactOffer } from "./compact";

type Input = NonNullable<Parameters<typeof compactOffer>[0]>;

const idle: Input = { state: "connected", status: "idle", statusReason: "at prompt", contextTokens: 412_000, effortPending: false, setup: null };

describe("compactOffer", () => {
  it.each<[string, Partial<Input>, number | null]>([
    ["idle at the prompt, past the threshold", {}, 412_000],
    ["one token past it", { contextTokens: COMPACT_OFFER_TOKENS + 1 }, COMPACT_OFFER_TOKENS + 1],
    ["exactly at it", { contextTokens: COMPACT_OFFER_TOKENS }, null],
    ["after a compaction", { contextTokens: 34_000 }, null],
    ["no result yet", { contextTokens: 0 }, null],
    ["a stopped thread: the command starts it", { state: "disconnected", status: "idle", statusReason: "" }, 412_000],
    ["a finished turn not seen yet", { status: "attention", statusReason: "finished" }, 412_000],
    ["a failed turn", { status: "attention", statusReason: "error: rate_limit" }, 412_000],
    ["a process that died mid-turn", { state: "disconnected", status: "error", statusReason: "crashed" }, 412_000],
    ["Claude works", { status: "busy", statusReason: "working" }, null],
    ["Claude compacts", { status: "busy", statusReason: "compacting" }, null],
    ["Claude starts", { state: "starting", status: "unknown", statusReason: "starting" }, null],
    ["before the handshake's status", { status: "unknown", statusReason: "starting" }, null],
    ["a pending permission", { status: "attention", statusReason: "permission: Bash ls" }, null],
    ["a pending question", { status: "attention", statusReason: "question: Which one?" }, null],
    ["an effort restart", { effortPending: true }, null],
    ["Ember's thread", { resident: "ember" }, null],
    ["a plugin's thread", { owner: "plugin-1" }, null],
    ["a deleted transcript", { transcriptMissing: true }, null],
  ])("%s", (_name, o, want) => {
    expect(compactOffer({ ...idle, ...o })).toBe(want);
  });

  it("an unknown thread", () => {
    expect(compactOffer(undefined)).toBeNull();
  });
});
