// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompletionGroup } from "@/lib/completion";
import { addThreads, seedWorld, thread } from "@/test/projectsWorld";
import type { CompletionSource } from "./useCompletion";
import { useMentionSource } from "./useRefSources";

/**
 * "@"'s source (docs/notes/composer-thread-pr-tags.md) over the mock's threads: s-3 "Fix
 * resize race" (code-foundry, idle), s-7 "Spike a canvas sidebar" (archived), s-8
 * "Refactor the gh poller" (snoozed).
 */

/** code-foundry's file search, answered for `query`. */
function files(query: string, labels: string[]): CompletionSource {
  const groups: CompletionGroup[] =
    labels.length === 0 ? [] : [{ key: "repo-cf", heading: null, items: labels.map((l) => ({ key: l, label: l, detail: `docs/${l}`, tag: { tagKind: "file" as const, projectId: "repo-cf", path: `docs/${l}` } })) }];
  return { char: "@", label: "Files", available: true, groups, query, searching: false, emptyText: "No files match" };
}

function mention(query: string, fileLabels: string[], current = ""): CompletionSource {
  const out: { current: CompletionSource | null } = { current: null };
  function Harness() {
    // oxlint-disable-next-line react/immutability -- the harness hands the hook result out to the test
    out.current = useMentionSource({ char: "@", query, from: 0, to: query.length + 1 }, files(query, fileLabels), current);
    return null;
  }
  render(<Harness />);
  if (!out.current) throw new Error("not rendered");
  return out.current;
}

const headings = (s: CompletionSource) => s.groups.map((g) => (g.heading?.kind === "label" ? g.heading.text : null));
const labels = (s: CompletionSource) => s.groups.flatMap((g) => g.items.map((i) => i.label));

beforeEach(() => {
  seedWorld();
});

afterEach(cleanup);

describe("useMentionSource (composer-threads.spec.ts)", () => {
  it("@res: a Threads group above Files, the thread's project and status under its name, the card named for both", () => {
    const s = mention("res", ["resize.md"]);
    expect(headings(s)).toEqual(["Threads", "Files"]);
    expect(labels(s)).toEqual(["Fix resize race", "resize.md"]);
    expect(s.groups[0]?.items[0]?.detail).toBe("code-foundry · Idle");
    expect(s.groups[0]?.items[0]?.tag).toEqual({ tagKind: "thread", id: "s-3", name: "Fix resize race" });
    expect(s.label).toBe("Threads and files");
  });

  it("an archived thread is not offered: no threads or files match", () => {
    const s = mention("spike", []);
    expect(s.groups).toEqual([]);
    expect(s.emptyText).toBe("No threads or files match");
  });

  it("a snoozed thread is not offered either", () => {
    expect(labels(mention("gh", []))).toEqual([]);
  });

  it("an empty query: at most three threads, never the archived or snoozed ones, the files below", () => {
    const s = mention("", ["README.md"]);
    expect(headings(s)).toEqual(["Threads", "Files"]);
    const threads = s.groups[0]?.items.map((i) => i.label) ?? [];
    expect(threads).toHaveLength(3);
    expect(threads).not.toContain("Spike a canvas sidebar");
    expect(threads).not.toContain("Refactor the gh poller");
  });

  it("a thread's composer leaves itself out", () => {
    addThreads(thread("s-r1", { name: "Fix stale PR badge", state: "connected", status: "idle" }));
    expect(labels(mention("fix", []))).toContain("Fix stale PR badge");
    cleanup();
    const s = mention("fix", [], "s-r1");
    expect(labels(s)).not.toContain("Fix stale PR badge");
    expect(labels(s)[0]).toBe("Fix resize race");
  });
});
