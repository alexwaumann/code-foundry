import { describe, expect, it } from "vitest";
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, DIFF_KIND, diffOfTab, diffTab, sameSource, sourceOfParam, sourceParam, type DiffTarget } from "./diffTarget";

const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "web", worktree: "/w", base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own: false, ...o });

describe("sources as tab params", () => {
  it.each([
    [{ kind: "merge-base" } as const, "merge-base"],
    [{ kind: "working" } as const, "working"],
    [{ kind: "staged" } as const, "staged"],
    [{ kind: "ref", ref: "origin/main" } as const, "ref:origin/main"],
    [{ kind: "ref", ref: "HEAD@{1}" } as const, "ref:HEAD@{1}"],
  ])("%j round-trips", (source, param) => {
    expect(sourceParam(source)).toBe(param);
    expect(sourceOfParam(param, DEFAULT_BASE)).toEqual(source);
  });

  it.each([[undefined], [""], ["ref:"], ["nonsense"]])("%j is the fallback", (v) => {
    expect(sourceOfParam(v, DEFAULT_HEAD)).toEqual(DEFAULT_HEAD);
  });

  it("two refs are the same source only by name", () => {
    expect(sameSource({ kind: "ref", ref: "a" }, { kind: "ref", ref: "a" })).toBe(true);
    expect(sameSource({ kind: "ref", ref: "a" }, { kind: "ref", ref: "b" })).toBe(false);
  });
});

describe("diffTab", () => {
  it("one id per checkout, whatever it compares or shows", () => {
    const id = diffTab(target()).id;
    expect(diffTab(target({ file: "a.ts", head: COMMITTED_HEAD, base: { kind: "staged" } })).id).toBe(id);
    expect(diffTab(target({ worktree: "/other" })).id).not.toBe(id);
    expect(diffTab(target({ project: "api" })).id).not.toBe(id);
    expect(diffTab(target()).kind).toBe(DIFF_KIND);
  });

  it("leaves defaults out of the params", () => {
    expect(diffTab(target()).params).toEqual({ project: "web", worktree: "/w" });
  });

  it("round-trips everything else", () => {
    const t = target({ base: { kind: "ref", ref: "v1" }, head: { kind: "staged" }, file: "new.md", oldPath: "old.md", own: true });
    expect(diffTab(t).params).toEqual({ project: "web", worktree: "/w", base: "ref:v1", head: "staged", path: "new.md", oldPath: "old.md", own: "1" });
    expect(diffOfTab(diffTab(t))).toEqual(t);
  });

  it("keeps the filter and the fold, and an unset fold stays unset", () => {
    const t = target({ filter: "src/", fold: false });
    expect(diffTab(t).params).toMatchObject({ filter: "src/", fold: "0" });
    expect(diffOfTab(diffTab(t))).toEqual(t);
    expect(diffOfTab(diffTab(target({ fold: true })))?.fold).toBe(true);
    expect(diffTab(target()).params.fold).toBeUndefined();
    expect(diffOfTab(diffTab(target()))?.fold).toBeUndefined();
  });

  it("a rename's source means nothing without a file, or equal to it", () => {
    expect(diffTab(target({ oldPath: "x" })).params.oldPath).toBeUndefined();
    expect(diffTab(target({ file: "x", oldPath: "x" })).params.oldPath).toBeUndefined();
  });

  it("a tab that names no checkout is none", () => {
    expect(diffOfTab({ params: { project: "web" } })).toBeNull();
    expect(diffOfTab({ params: { worktree: "/w" } })).toBeNull();
  });
});
