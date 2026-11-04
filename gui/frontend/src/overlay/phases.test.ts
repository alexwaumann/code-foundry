import { describe, expect, it } from "vitest";
import { HIDDEN, reduceOverlay, type OverlayEvent, type OverlayState } from "./phases";

const play = (events: OverlayEvent[], from: OverlayState = HIDDEN) => events.reduce(reduceOverlay, from);
const begin: OverlayEvent = { kind: "begin", sessionId: "s1" };
const stopping: OverlayEvent = { kind: "stopping", sessionId: "s1" };

describe("reduceOverlay", () => {
  it.each<[string, OverlayEvent[], OverlayState["phase"]]>([
    ["a session opens listening", [begin], "listening"],
    ["a flush is working", [begin, stopping], "working"],
    ["stopped after working is done", [begin, stopping, { kind: "ended", sessionId: "s1", reason: "stopped" }], "done"],
    ["stopped before Watch said stopping is still done", [begin, { kind: "ended", sessionId: "s1", reason: "stopped" }], "done"],
    ["an error while listening fails", [begin, { kind: "ended", sessionId: "s1", reason: "error" }], "failed"],
    ["an error while working fails", [begin, stopping, { kind: "ended", sessionId: "s1", reason: "error" }], "failed"],
    ["a discarded press collapses", [begin, { kind: "ended", sessionId: "s1", reason: "discarded" }], "collapsing"],
    ["silence collapses", [begin, { kind: "ended", sessionId: "s1", reason: "silence" }], "collapsing"],
    ["turning dictation off collapses", [begin, { kind: "ended", sessionId: "s1", reason: "disabled" }], "collapsing"],
    ["a lost session collapses", [begin, { kind: "lost", sessionId: "s1" }], "collapsing"],
    ["a late stopping does not undo an end", [begin, { kind: "ended", sessionId: "s1", reason: "stopped" }, stopping], "done"],
    ["a late loss does not undo done", [begin, { kind: "ended", sessionId: "s1", reason: "stopped" }, { kind: "lost", sessionId: "s1" }], "done"],
    ["finished hides", [begin, { kind: "ended", sessionId: "s1", reason: "stopped" }, { kind: "finished" }], "hidden"],
    ["another session's events are ignored", [begin, { kind: "ended", sessionId: "old", reason: "error" }, { kind: "stopping", sessionId: "old" }], "listening"],
    ["events with nothing on the plate are ignored", [stopping], "hidden"],
  ])("%s", (_name, events, want) => {
    expect(play(events).phase).toBe(want);
  });

  it("a new session takes a plate still playing the last", () => {
    expect(play([begin, { kind: "ended", sessionId: "s1", reason: "stopped" }, { kind: "begin", sessionId: "s2" }])).toEqual({ phase: "listening", sessionId: "s2" });
  });

  it("the same session again changes nothing", () => {
    expect(play([begin, stopping, begin]).phase).toBe("working");
  });
});
