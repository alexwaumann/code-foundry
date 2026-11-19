import { beforeEach, describe, expect, it } from "vitest";
import { defaultMergeMethod } from "@/components/pr/merge";
import { mergeMethodDefault, setMergeMethodDefault, useMergeDefaultsStore } from "./mergeDefaults";

beforeEach(() => {
  localStorage.clear();
  useMergeDefaultsStore.setState({ bySlug: {} });
});

describe("merge defaults", () => {
  it("a pick is the repository's default at once, per repository, slugs in any case", () => {
    expect(mergeMethodDefault("Acme/Repo")).toBeUndefined();
    setMergeMethodDefault("Acme/Repo", "rebase");
    setMergeMethodDefault("o/other", "merge");
    expect(mergeMethodDefault("acme/repo")).toBe("rebase");
    expect(useMergeDefaultsStore.getState().bySlug).toEqual({ "acme/repo": "rebase", "o/other": "merge" });
    // The split button's method: the pick while the repository allows it, else squash.
    expect(defaultMergeMethod(["merge", "squash", "rebase"], mergeMethodDefault("acme/repo"))).toBe("rebase");
    expect(defaultMergeMethod(["merge", "squash"], mergeMethodDefault("acme/repo"))).toBe("squash");
  });

  it("picking the default again changes nothing", () => {
    setMergeMethodDefault("o/r", "squash");
    const before = useMergeDefaultsStore.getState();
    setMergeMethodDefault("O/R", "squash");
    expect(useMergeDefaultsStore.getState()).toBe(before);
  });

  it("persists to localStorage and rehydrates (a restart keeps it)", async () => {
    setMergeMethodDefault("o/r", "rebase");
    const raw = localStorage.getItem("code-foundry.mergeMethods") ?? "{}";
    expect((JSON.parse(raw) as { state: unknown }).state).toEqual({ bySlug: { "o/r": "rebase" } });
    useMergeDefaultsStore.setState({ bySlug: {} });
    localStorage.setItem("code-foundry.mergeMethods", raw);
    await useMergeDefaultsStore.persist.rehydrate();
    expect(mergeMethodDefault("o/r")).toBe("rebase");
  });

  it("drops what it does not know from another build's copy", async () => {
    localStorage.setItem("code-foundry.mergeMethods", JSON.stringify({ state: { bySlug: { "o/r": "fast-forward", "o/s": "merge", "o/t": 3 } }, version: 1 }));
    await useMergeDefaultsStore.persist.rehydrate();
    expect(useMergeDefaultsStore.getState().bySlug).toEqual({ "o/s": "merge" });
    localStorage.setItem("code-foundry.mergeMethods", "null");
    await useMergeDefaultsStore.persist.rehydrate();
    expect(useMergeDefaultsStore.getState().bySlug).toEqual({});
  });
});
