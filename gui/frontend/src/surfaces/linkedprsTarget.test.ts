import { describe, expect, it } from "vitest";
import type { LinkedPullRequestView, ThreadView } from "@/api/threads";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { linkedCount, linkedPrsTab, newestFirst, prBadge, selectionLinkedThread, selectionThread, spansRepos, urlHost } from "./linkedprsTarget";

const WEB = "/src/web";
const link = (slug: string, number: number, linkedAt: number | null = number): LinkedPullRequestView => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt });

function thread(id: string, o: Partial<ThreadView> = {}): ThreadView {
  return { id, projectId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", terminalId: "", linkedPullRequests: [], ...o } as ThreadView;
}

const repos: ProjectsData = { byId: {}, order: [] };

function threads(...list: ThreadView[]): ThreadsData {
  return { byId: Object.fromEntries(list.map((s) => [s.id, s])), order: list.map((s) => s.id) };
}

const s = {
  repos,
  threads: threads(thread("s-linked", { linkedPullRequests: [link("o/web", 5)], workspaceId: "w1" }), thread("s-bare")),
};

describe("selectionThread / selectionLinkedThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null, string | null]>([
    ["a thread with links", { kind: "thread", id: "s-linked" }, "s-linked", "s-linked"],
    ["a thread without links", { kind: "thread", id: "s-bare" }, "s-bare", null],
    ["an unknown thread", { kind: "thread", id: "s-404" }, null, null],
    ["a composer", { kind: "compose", projectId: "web" }, null, null],
    ["a page", { kind: "view", name: "pullrequests" }, null, null],
    ["nothing", { kind: "none" }, null, null],
  ])("%s", (_name, sel, want, linked) => {
    expect(selectionThread(sel, s)).toBe(want);
    expect(selectionLinkedThread(sel, s)).toBe(linked);
  });
});

describe("the list", () => {
  it("is newest linked first: the stored first-seen order reversed, without touching the input", () => {
    const stored = [link("o/web", 5), link("o/web", 7), link("o/web", 6)];
    expect(newestFirst(stored).map((l) => l.number)).toEqual([6, 7, 5]);
    expect(stored.map((l) => l.number)).toEqual([5, 7, 6]);
    expect(newestFirst([])).toEqual([]);
  });

  it.each<[string, LinkedPullRequestView[], boolean]>([
    ["none", [], false],
    ["one repository", [link("o/web", 1), link("o/web", 2)], false],
    ["one repository, different case", [link("O/Web", 1), link("o/web", 2)], false],
    ["two repositories", [link("o/web", 1), link("o/api", 2)], true],
  ])("names the repository only across repositories: %s", (_name, links, want) => {
    expect(spansRepos(links)).toBe(want);
  });

  it("has one tab per panel, without params", () => {
    expect(linkedPrsTab()).toEqual({ id: "linkedprs", kind: "linkedprs", title: "Linked PRs", params: {} });
  });

  it.each([
    ["https://github.com/o/web/pull/5", "github.com"],
    ["https://ghe.example.com:8443/o/web/pull/5", "ghe.example.com:8443"],
    ["not a url", "not a url"],
  ])("urlHost(%s) = %s", (url, want) => {
    expect(urlHost(url)).toBe(want);
  });

  it("counts", () => {
    expect([linkedCount(1), linkedCount(3), prBadge(1), prBadge(2)]).toEqual(["1 linked PR", "3 linked PRs", "1 PR", "2 PRs"]);
  });
});
