import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import { MemoryEventSchema, MemorySnapshotSchema } from "@/gen/codefoundry/v1/memory_pb";
import { toEventView } from "./events";
import { toMemorySnapshotView } from "./memory";

const created = Date.UTC(2026, 9, 22, 14, 3, 11);

const snapshot = create(MemorySnapshotSchema, {
  entries: [
    {
      index: 1,
      text: "Always open PRs as drafts",
      file: "always-open-prs-as-drafts.md",
      created: timestampFromMs(created),
      threadId: "s-1",
      threadName: "Fix login",
      injected: true,
      id: "always-open-prs-as-drafts",
    },
    { index: 2, text: "Keep it short", file: "hand.md", injected: false, id: "hand", leftOut: "too_long" },
    // An older daemon: no id or reason.
    { index: 3, text: "Old", file: "Old.MD", injected: false },
  ],
  injected: 1,
  injectedBytes: 28,
  maxEntries: 40,
  maxBytes: 4096,
  maxEntryChars: 500,
  dir: "/h/memory",
  version: 3n,
});

describe("memory mapping", () => {
  it("maps entries with their provenance and the caps", () => {
    expect(toMemorySnapshotView(snapshot)).toEqual({
      entries: [
        {
          file: "always-open-prs-as-drafts.md",
          index: 1,
          text: "Always open PRs as drafts",
          createdMs: created,
          origin: { kind: "thread", threadId: "s-1", threadName: "Fix login" },
          injected: true,
          id: "always-open-prs-as-drafts",
          leftOut: "",
        },
        { file: "hand.md", id: "hand", index: 2, text: "Keep it short", createdMs: null, origin: { kind: "user" }, injected: false, leftOut: "too_long" },
        { file: "Old.MD", id: "Old", index: 3, text: "Old", createdMs: null, origin: { kind: "user" }, injected: false, leftOut: "entries" },
      ],
      injected: 1,
      injectedBytes: 28,
      maxEntries: 40,
      maxBytes: 4096,
      maxEntryChars: 500,
      dir: "/h/memory",
      error: "",
      version: 3,
    });
  });

  it("maps a missing snapshot to an empty memory", () => {
    expect(toMemorySnapshotView(undefined).entries).toEqual([]);
  });

  it("is an EventService source", () => {
    const ev = create(EventSchema, { event: { case: "memory", value: create(MemoryEventSchema, { snapshot }) } });
    const view = toEventView(ev);
    expect(view?.source).toBe("memory");
    expect(view?.source === "memory" && view.event.snapshot.entries.map((e) => e.text)).toEqual([
      "Always open PRs as drafts",
      "Keep it short",
      "Old",
    ]);
  });
});
