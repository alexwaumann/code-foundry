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
    },
    { index: 2, text: "Keep it short", file: "hand.md", injected: false },
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
        },
        { file: "hand.md", index: 2, text: "Keep it short", createdMs: null, origin: { kind: "user" }, injected: false },
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
    ]);
  });
});
