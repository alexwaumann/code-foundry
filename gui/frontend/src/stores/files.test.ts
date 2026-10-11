import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSearchRequest, FileSearchView, SkillSourceView } from "@/api/filesystem";
import { OutdatedDaemonError } from "@/api/errors";
import { fileSources, fileSourcesKey, type FileSourceInput } from "@/lib/completion";
import { cancelFiles, DEBOUNCE_MS, FILE_LIMIT, FRESH_MS, requestFiles, resetFiles, SEARCHING_AFTER_MS, useFilesStore, type SearchFilesFn } from "./files";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetFiles();
  vi.useRealTimers();
});

const R1: SkillSourceView[] = [{ repoId: "r1" }];
const R12: SkillSourceView[] = [{ repoId: "r1" }, { repoId: "r2", path: "/h/w/r2" }];
const entry = (sources: readonly SkillSourceView[]) => useFilesStore.getState().byKey[fileSourcesKey(sources)];

/** A fake SearchFiles whose calls resolve when told to. */
function deferred() {
  const calls: { req: FileSearchRequest; resolve: (v: FileSearchView) => void; reject: (e: unknown) => void }[] = [];
  const fn: SearchFilesFn = (req) =>
    new Promise<FileSearchView>((resolve, reject) => {
      calls.push({ req, resolve, reject });
    });
  return { fn, calls };
}

const hit = (path: string, isDir = false): FileSearchView => ({ matches: [{ path, isDir }], truncated: false });

/** Lets settled promises land (no timers move). */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("files store", () => {
  it("debounces keystrokes: one search per member for the last query, FILE_LIMIT each", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "s", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    requestFiles(R1, "se", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    requestFiles(R1, "ses", fn);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls.map((c) => c.req)).toEqual([{ repoId: "r1", query: "ses", limit: FILE_LIMIT }]);
    calls[0]?.resolve(hit("internal/api/session.go"));
    await flush();
    expect(entry(R1)).toEqual({
      answered: "ses",
      results: [{ repoId: "r1", matches: [{ path: "internal/api/session.go", isDir: false }] }],
      searching: false,
      outdated: false,
    });
  });

  it("fans out to every member at once (path only when given) and keeps source order", async () => {
    const { fn, calls } = deferred();
    requestFiles(R12, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls.map((c) => c.req)).toEqual([
      { repoId: "r1", query: "ses", limit: FILE_LIMIT },
      { repoId: "r2", path: "/h/w/r2", query: "ses", limit: FILE_LIMIT },
    ]);
    calls[1]?.resolve(hit("b.go"));
    await flush();
    expect(entry(R12)?.answered ?? null).toBeNull(); // waits for every member
    calls[0]?.resolve(hit("a.go"));
    await flush();
    expect(entry(R12)?.results.map((r) => [r.repoId, r.matches[0]?.path])).toEqual([
      ["r1", "a.go"],
      ["r2", "b.go"],
    ]);
  });

  it("a member whose search fails answers with nothing; the others still show", async () => {
    const { fn, calls } = deferred();
    requestFiles(R12, "x", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0]?.reject(new Error("invalid argument: outside home"));
    calls[1]?.resolve(hit("x.go"));
    await flush();
    expect(entry(R12)?.results).toEqual([
      { repoId: "r1", matches: [] },
      { repoId: "r2", matches: [{ path: "x.go", isDir: false }] },
    ]);
  });

  it("stale answers: a later request's answer wins; an earlier one landing after it is ignored", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "s", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    requestFiles(R1, "se", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls.map((c) => c.req.query)).toEqual(["s", "se"]);
    calls[1]?.resolve(hit("se.go"));
    await flush();
    expect(entry(R1)?.answered).toBe("se");
    calls[0]?.resolve(hit("s.go"));
    await flush();
    expect(entry(R1)?.answered).toBe("se");
    expect(entry(R1)?.results[0]?.matches[0]?.path).toBe("se.go");
  });

  it("an earlier answer landing first shows until the later one lands", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "s", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    requestFiles(R1, "se", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0]?.resolve(hit("s.go"));
    await flush();
    expect(entry(R1)?.answered).toBe("s");
    calls[1]?.resolve(hit("se.go"));
    await flush();
    expect(entry(R1)?.answered).toBe("se");
  });

  it("searching: only once the latest request is out longer than SEARCHING_AFTER_MS", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "s", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + SEARCHING_AFTER_MS - 1);
    expect(entry(R1)?.searching ?? false).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(entry(R1)?.searching).toBe(true);
    calls[0]?.resolve(hit("s.go"));
    await flush();
    expect(entry(R1)?.searching).toBe(false);

    // A fast answer never says it.
    requestFiles(R1, "se", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
    calls[1]?.resolve(hit("se.go"));
    await vi.advanceTimersByTimeAsync(SEARCHING_AFTER_MS);
    expect(entry(R1)?.searching).toBe(false);
  });

  it("the answered query is cached: asking again while fresh sends nothing, later it refreshes and shows the old answer meanwhile", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0]?.resolve(hit("a.go"));
    await flush();
    requestFiles(R1, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FRESH_MS);
    requestFiles(R1, "ses", fn);
    expect(entry(R1)?.answered).toBe("ses");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(hit("b.go"));
    await flush();
    expect(entry(R1)?.results[0]?.matches[0]?.path).toBe("b.go");
  });

  it("back to the query already on its way sends nothing; the cache is per member set", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    requestFiles(R1, "sess", fn);
    requestFiles(R1, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls.map((c) => c.req.query)).toEqual(["ses"]);
    requestFiles(R12, "ses", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(calls).toHaveLength(3);
  });

  it("cancelFiles drops a search still waiting out its debounce", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "ses", fn);
    cancelFiles(R1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(calls).toHaveLength(0);
  });

  it("an outdated daemon: the entry says so and nothing is asked again", async () => {
    const { fn, calls } = deferred();
    requestFiles(R1, "s", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    calls[0]?.reject(new OutdatedDaemonError(new Error("unimplemented")));
    await flush();
    expect(entry(R1)).toEqual({ answered: null, results: [], searching: false, outdated: true });
    requestFiles(R1, "se", fn);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + SEARCHING_AFTER_MS);
    expect(calls).toHaveLength(1);
    expect(entry(R1)?.searching).toBe(false);
  });

  describe("the checkout searched per worktree mode", () => {
    const wsMembers = [
      { repoId: "r1", worktreePath: "/h/w/r1" },
      { repoId: "r2", worktreePath: "/h/w/r2" },
    ];
    it.each<[string, FileSourceInput, Omit<FileSearchRequest, "query" | "limit">[]]>([
      ["a project, new worktree: the main checkout", { target: "project", repoIds: ["r1"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }]],
      [
        "a project, existing worktree: that worktree",
        { target: "project", repoIds: ["r1"], worktree: { kind: "existing", path: "/h/r1-wt" }, wsMembers: [] },
        [{ repoId: "r1", path: "/h/r1-wt" }],
      ],
      ["a project with Also in: each main checkout", { target: "project", repoIds: ["r1", "r3"], worktree: { kind: "new" }, wsMembers: [] }, [{ repoId: "r1" }, { repoId: "r3" }]],
      [
        "a workspace, Workspace worktrees: each member's worktree",
        { target: "workspace", repoIds: ["r1", "r2"], worktree: { kind: "members" }, wsMembers },
        [
          { repoId: "r1", path: "/h/w/r1" },
          { repoId: "r2", path: "/h/w/r2" },
        ],
      ],
      ["a workspace, new worktree: each main checkout", { target: "workspace", repoIds: ["r1", "r2"], worktree: { kind: "new" }, wsMembers }, [{ repoId: "r1" }, { repoId: "r2" }]],
    ])("%s", async (_name, input, want) => {
      const { fn, calls } = deferred();
      requestFiles(fileSources(input), "q", fn);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(calls.map((c) => c.req)).toEqual(want.map((w) => ({ ...w, query: "q", limit: FILE_LIMIT })));
    });
  });
});
