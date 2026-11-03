import { describe, expect, it } from "vitest";
import type { TaskKind } from "./readiness";
import { buttonLabel, isProjectRepo, menuHint, menuLabel, prTaskArgs, taskRouting, taskVerb, type TaskThread } from "./taskRouting";

const REF = { slug: "alexwaumann/code-foundry", number: 145 };

function thread(id: string, o: { name?: string; links?: [string, number][]; activity?: number | null; created?: number | null; archived?: boolean } = {}): TaskThread {
  return {
    id,
    name: o.name ?? `Thread ${id}`,
    archivedAtMs: o.archived ? 1 : null,
    lastActivityAtMs: o.activity === undefined ? 0 : o.activity,
    createdAtMs: o.created ?? null,
    linkedPullRequests: (o.links ?? []).map(([slug, number]) => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt: null })),
  };
}

const linked = (id: string, o: Parameters<typeof thread>[1] = {}) => thread(id, { links: [[REF.slug, REF.number]], ...o });

/** The routing as "kind:id" strings: the default, then the menu in order. */
function route(selection: string | null, threads: TaskThread[], isProject = true) {
  const r = taskRouting({ selection, ref: REF, threads, isProject });
  const s = (t: (typeof r.targets)[number]) => (t.kind === "new" ? `new${t.clones ? `(${t.clones})` : ""}` : `${t.kind}:${t.threadId}`);
  return { default: s(r.default), menu: r.targets.map(s), defaultFirst: r.targets[0] === r.default };
}

describe("taskRouting", () => {
  it.each([
    {
      name: "rule 1: the selected thread links the pull request → this thread, then new, then others",
      selection: "a",
      threads: [linked("a"), linked("b", { activity: 5 })],
      want: { default: "this:a", menu: ["this:a", "new", "other:b"] },
    },
    {
      name: "rule 1 compares slug case-insensitively",
      selection: "a",
      threads: [thread("a", { links: [["AlexWaumann/Code-Foundry", 145]] })],
      want: { default: "this:a", menu: ["this:a", "new"] },
    },
    {
      name: "same slug, other number: not linked",
      selection: "a",
      threads: [thread("a", { links: [[REF.slug, 146]] })],
      want: { default: "new", menu: ["new", "this:a"] },
    },
    {
      name: "rule 2: another thread links it → new thread by default, that thread in the menu, this thread offered",
      selection: "a",
      threads: [thread("a"), linked("b")],
      want: { default: "new", menu: ["new", "this:a", "other:b"] },
    },
    {
      name: "no thread selected (a page): new thread and the linking threads",
      selection: null,
      threads: [linked("b")],
      want: { default: "new", menu: ["new", "other:b"] },
    },
    {
      name: "a selection the store does not know: no this thread",
      selection: "gone",
      threads: [linked("b")],
      want: { default: "new", menu: ["new", "other:b"] },
    },
    {
      name: "archived threads are left out of the others",
      selection: null,
      threads: [linked("b", { archived: true }), linked("c")],
      want: { default: "new", menu: ["new", "other:c"] },
    },
    {
      name: "an archived selected thread that links it is still this thread",
      selection: "a",
      threads: [linked("a", { archived: true })],
      want: { default: "this:a", menu: ["this:a", "new"] },
    },
    {
      name: "others: most recently active first (created when never active), at most three",
      selection: null,
      threads: [linked("b", { activity: 10 }), linked("c", { activity: 40 }), linked("d", { activity: null, created: 30 }), linked("e", { activity: 20 }), linked("f", { activity: 1 })],
      want: { default: "new", menu: ["new", "other:c", "other:d", "other:e"] },
    },
    {
      name: "unrelated threads never show",
      selection: null,
      threads: [thread("b"), thread("c", { links: [["other/repo", 145]] })],
      want: { default: "new", menu: ["new"] },
    },
    {
      name: "rule 4: the repository is no project → the new thread clones it first",
      selection: "a",
      threads: [thread("a")],
      isProject: false,
      want: { default: `new(${REF.slug})`, menu: [`new(${REF.slug})`, "this:a"] },
    },
  ])("$name", ({ selection, threads, isProject, want }) => {
    expect(route(selection, threads, isProject)).toEqual({ ...want, defaultFirst: true });
  });

  it("labels: button, menu item, hint", () => {
    const r = taskRouting({ selection: "a", ref: REF, threads: [thread("a"), linked("b", { name: "Fix the resize race" }), linked("c", { name: "  " })], isProject: false });
    expect(r.targets.map((t) => buttonLabel("Fix", t))).toEqual(["Fix in new thread", "Fix in this thread", "Fix in Fix the resize race", "Fix in c"]);
    expect(r.targets.map(menuLabel)).toEqual(["In a new thread", "In this thread", "In Fix the resize race", "In c"]);
    expect(r.targets.map(menuHint)).toEqual([`Clones ${REF.slug} first`, "", "", ""]);
  });

  it("args: --thread for a thread, none for a new thread", () => {
    const r = taskRouting({ selection: "a", ref: REF, threads: [linked("a"), linked("b")], isProject: true });
    expect(r.targets.map((t) => prTaskArgs(REF, "checks", t))).toEqual([
      { "repo-slug": REF.slug, number: "145", kind: "checks", thread: "a" },
      { "repo-slug": REF.slug, number: "145", kind: "checks" },
      { "repo-slug": REF.slug, number: "145", kind: "checks", thread: "b" },
    ]);
  });
});

describe("isProjectRepo", () => {
  it.each([
    { slugs: ["alexwaumann/code-foundry"], want: true },
    { slugs: ["AlexWaumann/Code-Foundry"], want: true },
    { slugs: ["", "acme/api"], want: false },
    // GitHub's current name for a renamed repository finds the old clone.
    { slugs: ["alexwaumann/old-name"], repoSlug: "alexwaumann/old-name", want: true },
    { slugs: [], want: false },
  ])("$slugs → $want", ({ slugs, repoSlug, want }) => {
    expect(isProjectRepo(slugs, REF.slug, repoSlug ?? "")).toBe(want);
  });
});

describe("taskVerb", () => {
  const detail = (o: { state?: string; author?: string; write?: boolean } = {}) => ({ viewerCanUpdate: o.write ?? true, pullRequest: { state: o.state ?? "open", author: o.author ?? "someone" } });
  const kinds: TaskKind[] = ["checks", "review", "conversations", "conflicts", "behind", "review-request"];

  it("each kind's verb for a writer", () => {
    expect(kinds.map((k) => taskVerb(k, detail(), "me"))).toEqual(["Fix", "Address", "Address", "Resolve", "Update", "Review"]);
  });

  it.each([
    { name: "no task", task: null, d: detail(), want: null },
    { name: "merged", task: "checks", d: detail({ state: "merged" }), want: null },
    { name: "closed", task: "conflicts", d: detail({ state: "closed" }), want: null },
    { name: "closed review request", task: "review-request", d: detail({ state: "closed" }), want: null },
    { name: "read access: no push task", task: "checks", d: detail({ write: false }), want: null },
    { name: "read access: behind needs a push too", task: "behind", d: detail({ write: false }), want: null },
    { name: "read access: a review needs no push", task: "review-request", d: detail({ write: false }), want: "Review" },
    { name: "read access, the author: may push", task: "review", d: detail({ write: false, author: "Me" }), want: "Address" },
  ] as const)("$name", ({ task, d, want }) => {
    expect(taskVerb(task, d, "me")).toBe(want);
  });
});
