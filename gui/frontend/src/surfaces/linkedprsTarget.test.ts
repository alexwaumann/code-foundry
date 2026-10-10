import { describe, expect, it } from "vitest";
import type { LinkedPullRequestView, SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import type { ReposData } from "@/stores/repos";
import type { SessionsData } from "@/stores/sessions";
import type { TerminalsData } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";
import { linkedCount, linkedPrsTab, newestFirst, prBadge, selectionLinkedThread, selectionThread, spansRepos, urlHost } from "./linkedprsTarget";

const WEB = "/src/web";
const link = (slug: string, number: number, linkedAt: number | null = number): LinkedPullRequestView => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt });

function session(id: string, o: Partial<SessionView> = {}): SessionView {
  return { id, repoId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", state: "connected", terminalId: "", linkedPullRequests: [], ...o } as SessionView;
}

const repos: ReposData = { byId: {}, order: [] };

function sessions(...list: SessionView[]): SessionsData {
  return { byId: Object.fromEntries(list.map((s) => [s.id, s])), order: list.map((s) => s.id) };
}

const terminals: TerminalsData = {
  byId: {
    "t-linked": { id: "t-linked", cwd: WEB, labels: { session: "s-linked" } } as unknown as TerminalView,
    "t-bare": { id: "t-bare", cwd: WEB, labels: { session: "s-bare" } } as unknown as TerminalView,
    "t-plain": { id: "t-plain", cwd: WEB, labels: {} } as unknown as TerminalView,
    "t-gone": { id: "t-gone", cwd: WEB, labels: { session: "s-404" } } as unknown as TerminalView,
  },
  order: [],
};

const s = {
  repos,
  sessions: sessions(session("s-linked", { linkedPullRequests: [link("o/web", 5)], workspaceId: "w1" }), session("s-bare")),
  terminals,
};

describe("selectionThread / selectionLinkedThread (the surface's availability)", () => {
  it.each<[string, Selection, string | null, string | null]>([
    ["a thread with links", { kind: "session", id: "s-linked" }, "s-linked", "s-linked"],
    ["a thread without links", { kind: "session", id: "s-bare" }, "s-bare", null],
    ["a linked thread's terminal", { kind: "terminal", id: "t-linked" }, "s-linked", "s-linked"],
    ["an unlinked thread's terminal", { kind: "terminal", id: "t-bare" }, "s-bare", null],
    ["a plain terminal", { kind: "terminal", id: "t-plain" }, null, null],
    ["a terminal of an unknown thread", { kind: "terminal", id: "t-gone" }, null, null],
    ["an unknown thread", { kind: "session", id: "s-404" }, null, null],
    ["a composer", { kind: "compose", repoId: "web" }, null, null],
    ["a page", { kind: "view", name: "pullrequests" }, null, null],
    ["nothing", { kind: "none" }, null, null],
  ])("%s", (_name, sel, thread, linked) => {
    expect(selectionThread(sel, s)).toBe(thread);
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
