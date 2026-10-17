import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillSourceView, SkillView } from "@/api/filesystem";
import { OutdatedDaemonError } from "@/api/errors";
import { skillSourcesKey } from "@/lib/completion";
import { loadSkills, resetSkills, useSkillsStore, type ListSkillsFn } from "./skills";

afterEach(() => {
  resetSkills();
});

const deploy: SkillView = { name: "deploy", description: "Ship it.", scope: "project", projectId: "r1", path: "/h/r1/.claude/skills/deploy/SKILL.md" };
const commit: SkillView = { name: "commit", description: "Commit.", scope: "user", projectId: "", path: "/h/.claude/skills/commit/SKILL.md" };

const R1: SkillSourceView[] = [{ projectId: "r1" }];
const entry = (sources: readonly SkillSourceView[]) => useSkillsStore.getState().byKey[skillSourcesKey(sources)];

/** A fake ListSkills whose calls resolve when told to. */
function deferred() {
  const calls: { sources: readonly SkillSourceView[]; includeUser: boolean; resolve: (s: SkillView[]) => void; reject: (e: unknown) => void }[] = [];
  const fn: ListSkillsFn = (sources, includeUser) =>
    new Promise<SkillView[]>((resolve, reject) => {
      calls.push({ sources, includeUser, resolve, reject });
    });
  return { fn, calls };
}

describe("skills store", () => {
  it("loads a source list with the user's skills, keyed by the list", async () => {
    const list = vi.fn<ListSkillsFn>().mockResolvedValue([deploy, commit]);
    const p = loadSkills(R1, list);
    expect(entry(R1)).toEqual({ status: "loading", skills: [], outdated: false });
    await p;
    expect(list).toHaveBeenCalledWith(R1, true);
    expect(entry(R1)).toEqual({ status: "ready", skills: [deploy, commit], outdated: false });
    expect(entry([{ projectId: "r1", path: "/h/r1-wt" }])).toBeUndefined();
  });

  it("concurrent loads of one list share a request", async () => {
    const { fn, calls } = deferred();
    const a = loadSkills(R1, fn);
    const b = loadSkills([{ projectId: "r1" }], fn);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve([deploy]);
    await Promise.all([a, b]);
    expect(entry(R1)?.skills).toEqual([deploy]);
  });

  it("a list that changes while its request is in flight: the late answer lands under the old list only", async () => {
    const { fn, calls } = deferred();
    const R2: SkillSourceView[] = [{ projectId: "r1" }, { projectId: "r2" }];
    const old = loadSkills(R1, fn);
    const cur = loadSkills(R2, fn);
    expect(calls.map((c) => c.sources)).toEqual([R1, R2]);
    calls[1]?.resolve([deploy, commit]);
    await cur;
    calls[0]?.resolve([deploy]);
    await old;
    expect(entry(R2)?.skills).toEqual([deploy, commit]);
    expect(entry(R1)?.skills).toEqual([deploy]);
  });

  it("a reload keeps the previous list until it answers, and after it fails", async () => {
    await loadSkills(R1, () => Promise.resolve([deploy]));
    const { fn, calls } = deferred();
    const p = loadSkills(R1, fn);
    expect(entry(R1)).toEqual({ status: "ready", skills: [deploy], outdated: false });
    calls[0]?.reject(new Error("boom"));
    await p;
    expect(entry(R1)).toEqual({ status: "ready", skills: [deploy], outdated: false });
    await loadSkills(R1, () => Promise.resolve([deploy, commit]));
    expect(entry(R1)?.skills).toEqual([deploy, commit]);
  });

  it.each([
    ["an outdated daemon", new OutdatedDaemonError(new Error("404")), true],
    ["any other error", new Error("boom"), false],
  ])("%s: nothing to offer", async (_name, err, outdated) => {
    await loadSkills(R1, () => Promise.reject(err));
    expect(entry(R1)).toEqual({ status: "error", skills: [], outdated });
  });

  it("an outdated daemon also replaces a list loaded before (the RPC is gone)", async () => {
    await loadSkills(R1, () => Promise.resolve([deploy]));
    await loadSkills(R1, () => Promise.reject(new OutdatedDaemonError(new Error("404"))));
    expect(entry(R1)).toEqual({ status: "error", skills: [], outdated: true });
  });
});
