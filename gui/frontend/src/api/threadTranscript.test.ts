import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { toThreadView } from "@/api/threads";
import { ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { sameThread } from "@/stores/threads";

// Thread.transcript_missing (docs/notes/transcript-deleted.md) maps to an optional field, and
// its arrival or departure is a change the store keeps (sameThread).
describe("transcript deleted", () => {
  it("maps the flag, and leaves it out for a thread that can continue", () => {
    expect(toThreadView(create(ThreadSchema, { id: "s", transcriptMissing: true })).transcriptMissing).toBe(true);
    expect("transcriptMissing" in toThreadView(create(ThreadSchema, { id: "s" }))).toBe(false);
  });

  it("a thread losing its transcript, or getting it back, is not the same thread", () => {
    const ok = toThreadView(create(ThreadSchema, { id: "s" }));
    const gone = toThreadView(create(ThreadSchema, { id: "s", transcriptMissing: true }));
    expect(sameThread(ok, gone)).toBe(false);
    expect(sameThread(gone, ok)).toBe(false);
    expect(sameThread(gone, toThreadView(create(ThreadSchema, { id: "s", transcriptMissing: true })))).toBe(true);
  });
});
