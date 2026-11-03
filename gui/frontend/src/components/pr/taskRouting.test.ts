import { describe, expect, it } from "vitest";
import type { TaskKind } from "./readiness";
import { buttonLabel, isProjectRepo, linksPullRequest, menuHint, menuLabel, prTaskArgs, taskRouting, taskVerb, type TaskThread } from "./taskRouting";

const REF = { slug: "alexwaumann/code-foundry", number: 145 };

function thread(id: string, o: { name?: string; links?: boolean; activity?: number; archived?: boolean; onHead?: boolean; ember?: boolean } = {}): TaskThread {
  return { id, name: o.name ?? `Thread ${id}`, archived: o.archived ?? false, activity: o.activity ?? 0, links: o.links ?? false, onHead: o.onHead ?? false, ember: o.ember ?? false };
}

const linked = (id: string, o: Parameters<typeof thread>[1] = {}) => thread(id, { links: true, ...o });

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
      name: "others: most recently active first, at most three",
      selection: null,
      threads: [linked("b", { activity: 10 }), linked("c", { activity: 40 }), linked("d", { activity: 30 }), linked("e", { activity: 20 }), linked("f", { activity: 1 })],
      want: { default: "new", menu: ["new", "other:c", "other:d", "other:e"] },
    },
    {
      name: "others: the head branch checked out first, then the most recently active",
      selection: null,
      threads: [linked("b", { activity: 50 }), linked("c", { activity: 10, onHead: true }), linked("d", { activity: 40 }), linked("e", { activity: 20, onHead: true }), linked("f", { activity: 30 })],
      want: { default: "new", menu: ["new", "other:e", "other:c", "other:b"] },
    },
    {
      name: "the head branch alone does not make a thread a target",
      selection: null,
      threads: [thread("b", { onHead: true }), linked("c")],
      want: { default: "new", menu: ["new", "other:c"] },
    },
    {
      name: "unrelated threads never show",
      selection: null,
      threads: [thread("b"), thread("c")],
      want: { default: "new", menu: ["new"] },
    },
    {
      name: "Ember is never among the others, however recent",
      selection: "a",
      threads: [linked("a"), linked("ember", { ember: true, activity: 99, onHead: true }), linked("b", { activity: 5 })],
      want: { default: "this:a", menu: ["this:a", "new", "other:b"] },
    },
    {
      name: "Ember's chat selected and linking it: a new thread, no this thread",
      selection: "ember",
      threads: [linked("ember", { ember: true }), linked("b")],
      want: { default: "new", menu: ["new", "other:b"] },
    },
    {
      name: "Ember's chat selected, not linking it: a new thread, no this thread",
      selection: "ember",
      threads: [thread("ember", { ember: true })],
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

describe("linksPullRequest", () => {
  const l = (slug: string, number: number) => ({ slug, number });
  it.each([
    { name: "same slug and number", linked: [l(REF.slug, 145)], want: true },
    { name: "slug case aside", linked: [l("AlexWaumann/Code-Foundry", 145)], want: true },
    { name: "same slug, other number", linked: [l(REF.slug, 146)], want: false },
    { name: "other repository, same number", linked: [l("other/repo", 145)], want: false },
    { name: "none", linked: [], repoSlug: REF.slug, want: false },
  ])("$name", ({ linked, want }) => {
    expect(linksPullRequest(linked, REF)).toBe(want);
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
