import { describe, expect, it } from "vitest";
import type { TaskKind } from "./readiness";
import { buttonLabel, isProjectRepo, linksPullRequest, menuHint, menuLabel, prTaskArgs, taskRouting, taskVerb, type TaskThread } from "./taskRouting";

const REF = { slug: "alexwaumann/code-foundry", number: 145 };

function thread(id: string, o: { name?: string; links?: boolean; activity?: number; archived?: boolean; user?: boolean } = {}): TaskThread {
  return { id, name: o.name ?? `Thread ${id}`, archived: o.archived ?? false, activity: o.activity ?? 0, links: o.links ?? false, user: o.user ?? true };
}

const linked = (id: string, o: Parameters<typeof thread>[1] = {}) => thread(id, { links: true, ...o });

/** The routing as "kind:id" strings: the default, then the menu in order. */
function route(selection: string | null, threads: TaskThread[], isProject = true) {
  const r = taskRouting({ selection, ref: REF, threads, isProject });
  const s = (t: (typeof r.targets)[number]) => (t.kind === "new" ? `new${t.clones ? `(${t.clones})` : ""}` : `${t.kind}:${t.threadId}`);
  return { default: s(r.default), menu: r.targets.map(s) };
}

describe("taskRouting", () => {
  it.each([
    {
      name: "the selected thread links the pull request: first and the default, then the others, then a new thread",
      selection: "a",
      threads: [linked("a"), linked("b", { activity: 5 })],
      want: { default: "this:a", menu: ["this:a", "other:b", "new"] },
    },
    {
      name: "the selected thread does not link it: a new thread by default, listed last, and no this thread",
      selection: "a",
      threads: [thread("a"), linked("b")],
      want: { default: "new", menu: ["other:b", "new"] },
    },
    {
      name: "no thread selected (a page): the linking threads, then a new thread (the default)",
      selection: null,
      threads: [linked("b")],
      want: { default: "new", menu: ["other:b", "new"] },
    },
    {
      name: "a selection the store does not know: no this thread",
      selection: "gone",
      threads: [linked("b")],
      want: { default: "new", menu: ["other:b", "new"] },
    },
    {
      name: "archived threads are left out of the others",
      selection: null,
      threads: [linked("b", { archived: true }), linked("c")],
      want: { default: "new", menu: ["other:c", "new"] },
    },
    {
      name: "an archived selected thread that links it is still this thread",
      selection: "a",
      threads: [linked("a", { archived: true })],
      want: { default: "this:a", menu: ["this:a", "new"] },
    },
    {
      name: "others: most recently active first, no cap",
      selection: null,
      threads: [linked("b", { activity: 10 }), linked("c", { activity: 40 }), linked("d", { activity: 30 }), linked("e", { activity: 20 }), linked("f", { activity: 1 })],
      want: { default: "new", menu: ["other:c", "other:d", "other:e", "other:b", "other:f", "new"] },
    },
    {
      name: "the same activity: by id",
      selection: null,
      threads: [linked("c"), linked("b")],
      want: { default: "new", menu: ["other:b", "other:c", "new"] },
    },
    {
      name: "a child thread whose creator is alive is never a target, however recent",
      selection: null,
      threads: [linked("child", { user: false, activity: 99 }), linked("parent", { activity: 1 })],
      want: { default: "new", menu: ["other:parent", "new"] },
    },
    {
      name: "a child thread selected (opened from its creator): not this thread",
      selection: "child",
      threads: [linked("child", { user: false }), linked("parent")],
      want: { default: "new", menu: ["other:parent", "new"] },
    },
    {
      name: "unrelated threads never show",
      selection: null,
      threads: [thread("b"), thread("c")],
      want: { default: "new", menu: ["new"] },
    },
    {
      name: "Ember's thread links it: among the others by activity",
      selection: "a",
      threads: [linked("a"), linked("ember", { activity: 99 }), linked("b", { activity: 5 })],
      want: { default: "this:a", menu: ["this:a", "other:ember", "other:b", "new"] },
    },
    {
      name: "Ember's chat selected and linking it: this thread",
      selection: "ember",
      threads: [linked("ember"), linked("b")],
      want: { default: "this:ember", menu: ["this:ember", "other:b", "new"] },
    },
    {
      name: "the repository is no project: the new thread clones it first",
      selection: "a",
      threads: [thread("a")],
      isProject: false,
      want: { default: `new(${REF.slug})`, menu: [`new(${REF.slug})`] },
    },
  ])("$name", ({ selection, threads, isProject, want }) => {
    expect(route(selection, threads, isProject)).toEqual(want);
  });

  it("labels: button, menu item, hint", () => {
    const r = taskRouting({ selection: "a", ref: REF, threads: [linked("a"), linked("b", { name: "Fix the resize race", activity: 2 }), linked("c", { name: "  ", activity: 1 })], isProject: false });
    expect(r.targets.map((t) => buttonLabel("Fix", t))).toEqual(["Fix in this thread", "Fix in Fix the resize race", "Fix in c", "Fix in new thread"]);
    expect(r.targets.map(menuLabel)).toEqual(["In this thread", "In Fix the resize race", "In c", "In a new thread"]);
    expect(r.targets.map(menuHint)).toEqual(["", "", "", `Clones ${REF.slug} first`]);
  });

  it("args: --thread for a thread, none for a new thread", () => {
    const r = taskRouting({ selection: "a", ref: REF, threads: [linked("a"), linked("b")], isProject: true });
    expect(r.targets.map((t) => prTaskArgs(REF, "checks", t))).toEqual([
      { "repo-slug": REF.slug, number: "145", kind: "checks", thread: "a" },
      { "repo-slug": REF.slug, number: "145", kind: "checks", thread: "b" },
      { "repo-slug": REF.slug, number: "145", kind: "checks" },
    ]);
  });
});

describe("linksPullRequest", () => {
  const l = (slug: string, number: number) => ({ slug, number });
  it.each([
    { name: "same slug and number", linked: [l(REF.slug, 145)], repoSlug: "", want: true },
    { name: "slug case aside", linked: [l("AlexWaumann/Code-Foundry", 145)], repoSlug: "", want: true },
    { name: "same slug, other number", linked: [l(REF.slug, 146)], repoSlug: "", want: false },
    { name: "other repository, same number", linked: [l("other/repo", 145)], repoSlug: "", want: false },
    // The thread linked it under the repository's new name; the panel was opened on the old one.
    { name: "renamed: GitHub's current name", linked: [l("alexwaumann/foundry", 145)], repoSlug: "AlexWaumann/Foundry", want: true },
    { name: "renamed: current name, other number", linked: [l("alexwaumann/foundry", 7)], repoSlug: "alexwaumann/foundry", want: false },
    { name: "none", linked: [], repoSlug: REF.slug, want: false },
  ])("$name", ({ linked, repoSlug, want }) => {
    expect(linksPullRequest(linked, REF, repoSlug)).toBe(want);
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
