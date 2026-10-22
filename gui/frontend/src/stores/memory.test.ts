import { ConnectError, Code } from "@connectrpc/connect";
import { beforeEach, describe, expect, it } from "vitest";
import type { MemorySnapshotView } from "@/api/memory";
import { applyMemoryEvent, loadMemory, resetMemory, useMemoryStore } from "./memory";

function snap(texts: string[], version = 1): MemorySnapshotView {
  return {
    entries: texts.map((text, i) => ({ file: `${text}.md`, id: text, index: i + 1, text, createdMs: 1, origin: { kind: "user" }, injected: true, leftOut: "" })),
    injected: texts.length,
    injectedBytes: 0,
    maxEntries: 40,
    maxBytes: 4096,
    maxEntryChars: 500,
    dir: "/m",
    error: "",
    version,
  };
}

const texts = () => useMemoryStore.getState().snapshot?.entries.map((e) => e.text);

beforeEach(resetMemory);

describe("memory store", () => {
  it("an event replaces the snapshot", () => {
    applyMemoryEvent({ snapshot: snap(["a", "b"]) });
    applyMemoryEvent({ snapshot: snap(["b"], 2) });
    expect(texts()).toEqual(["b"]);
  });

  it("a Get sets it", async () => {
    await loadMemory(() => Promise.resolve(snap(["a"])));
    expect(texts()).toEqual(["a"]);
  });

  it("an event that arrives while a Get runs wins", async () => {
    let resolve: (s: MemorySnapshotView) => void = () => undefined;
    const pending = loadMemory(() => new Promise((r) => (resolve = r)));
    applyMemoryEvent({ snapshot: snap(["new"], 3) });
    resolve(snap(["old"], 2));
    await pending;
    expect(texts()).toEqual(["new"]);
  });

  it("a failed Get with nothing loaded is the error; with a snapshot it is ignored", async () => {
    await loadMemory(() => Promise.reject(new Error("boom")));
    expect(useMemoryStore.getState().loadError).toContain("boom");
    applyMemoryEvent({ snapshot: snap(["a"]) });
    expect(useMemoryStore.getState().loadError).toBe("");
    await loadMemory(() => Promise.reject(new Error("again")));
    expect(useMemoryStore.getState()).toMatchObject({ loadError: "" });
    expect(texts()).toEqual(["a"]);
  });

  it("a daemon without MemoryService is outdated", async () => {
    await loadMemory(() => Promise.reject(new ConnectError("no", Code.Unimplemented)));
    expect(useMemoryStore.getState()).toMatchObject({ outdated: true, loadError: "" });
  });
});
