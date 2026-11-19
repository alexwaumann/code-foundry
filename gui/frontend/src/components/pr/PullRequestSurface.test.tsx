import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { dismissNotice } from "@/lib/notify";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { bodyDone, it, trackTests } from "@/test/isolate";
import type { PullRequestDetailView } from "@/api/gh";
import type { Selection } from "@/stores/ui";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { daemon, invocationsOf, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { HEAD_142, seedPrWorld, SLUG } = await import("@/test/prWorld");
const { closePrTab, openPr, pick, press, prTabs, renderPrPanel, resetPrStores, selectPrTab, settle, texts, toastTexts, PR_PAGE } = await import("@/test/prPanelHarness");
const { seedWorld, CF } = await import("@/test/projectsWorld");
const { tooltipText } = await import("@/test/tooltip");
const { runCommandForResult } = await import("@/stores/commands");
const { mergePullRequest, usePrPanelStore } = await import("@/stores/prPanel");
const { useUiStore } = await import("@/stores/ui");
const { applyLayoutOp } = await import("@/api/layout");
const { layoutSettled } = await import("@/test/fakeLayout");
const { applyGhEvent, pullRequestDetailResource, pullRequestKey } = await import("@/stores/gh");
const { UPDATING_AFTER_MS } = await import("./PullRequestSurface");
const { useThreadsStore } = await import("@/stores/threads");
const { PREPARING_TOAST_DELAY_MS, focusGrace } = await import("@/stores/prThreads");

/**
 * The Pull request surface (components/pr) in a pane's tab, against the mock's pull
 * requests (src/test/prWorld.ts): #145 open with failing checks, threads and reviewers; #138
 * merged; #131 closed; #140 read-only; #142 mergeable; #146 from a fork; #139 a teammate's.
 * e2e/pr-panel.spec.ts keeps what needs the browser: widths, overflow and popups inside the
 * panel, virtualized scrolling, chords through the keymap, and flows across routes (the
 * daemon's FocusThread selecting a new thread, the dashboard moving a merged row).
 */

let world: ReturnType<typeof seedPrWorld>;

trackTests();

beforeEach(async () => {
  // No FocusThread here (e2e/pr-panel.spec.ts has the daemon's): a started thread's toast
  // shows as soon as the answer is in, not after its wait for one.
  focusGrace.ms = 0;
  resetDaemon();
  world = seedPrWorld();
  await resetPrStores();
});

afterEach(async () => {
  // A body that timed out ends first, against its own world (src/test/isolate.ts).
  await bodyDone();
  act(() => {
    dismissNotice();
  });
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const byTestId = (id: string) => screen.getByTestId(id);
const queryTestId = (id: string) => screen.queryByTestId(id);
const urlsOpened = () => invocationsOf("view.open.url").map((i) => i.args.url);
const children = (id: string) => [...byTestId(id).children] as HTMLElement[];
const input = (id: string) => byTestId(id) as HTMLTextAreaElement;
const menuItems = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((i) => i.textContent);
/** A merge menu's methods: one-pick items (the default has the tick). */
const methodItems = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio").map((i) => i.textContent);

async function expectToast(text: string | RegExp): Promise<void> {
  await vi.waitFor(() => {
    expect(toastTexts().some((t) => (typeof text === "string" ? t.includes(text) : text.test(t)))).toBe(true);
  });
}

function toastCount(text: string): number {
  return toastTexts().filter((t) => t.includes(text)).length;
}

/** Switches to a space (switch_space) and selects what it shows. */
async function showSpace(space: string, selection: Selection): Promise<void> {
  await act(async () => {
    useUiStore.setState({ selection });
    await applyLayoutOp({ op: "switch_space", space });
    await layoutSettled();
  });
}

/** Opens the ⋯ menu. */
function openMenu(): HTMLElement {
  press(byTestId("pr-menu-button"));
  return byTestId("pr-menu");
}

describe("Overview", () => {
  it("#145: header, details, requirement cards, description, checks unfold on their card, comments newest first with threads; links open through view.open.url", async () => {
    renderPrPanel();
    await openPr(145);
    expect(prTabs()).toEqual(["#145"]);
    expect(byTestId("pr-repo").textContent).toBe(`${SLUG} #145`);
    expect(byTestId("pr-title").textContent).toBe("fix(terminal): resize race between attach and first output");
    expect(byTestId("pr-branches").textContent).toMatch(/main\s*fix\/resize/);
    expect(byTestId("pr-header").dataset.state).toBe("draft");
    // One block, in this order: owner/repo #number with the ⋯ menu at its right end, the
    // title, the branches, the status; the ⋯ never sits beside the title.
    const block = byTestId("pr-title").parentElement as HTMLElement;
    expect([...block.children].map((c) => (c as HTMLElement).dataset.testid)).toEqual(["pr-top-line", "pr-title", "pr-branches", "pr-status-section"]);
    expect([...byTestId("pr-top-line").children].map((c) => (c as HTMLElement).dataset.testid)).toEqual(["pr-repo", "pr-actions"]);
    expect(within(byTestId("pr-actions")).getByTestId("pr-menu-button")).toBeTruthy();
    expect(byTestId("pr-branches").querySelector("svg")).toBeTruthy();
    // No divider between the lines and the status.
    expect(byTestId("pr-status-section").className).not.toMatch(/border/);
    // The details: the author, the ages (Updated for an open one) and the commits.
    expect(byTestId("pr-author").textContent).toBe("alexwaumann");
    expect(byTestId("pr-age-opened").textContent).toMatch(/^Opened\d+[a-z]+ ago$/);
    expect(byTestId("pr-age-updated").textContent).toBe("Updated5h ago");
    expect(byTestId("pr-commits").textContent).toMatch(/^Commits4/);
    // A draft: the state in words with no wash, its own action; Merge is not offered.
    expect(byTestId("pr-ready-headline").textContent).toBe("Draft");
    expect(byTestId("pr-header").dataset.tone).toBe("neutral");
    expect(within(byTestId("pr-header")).getByTestId("pr-ready-for-review")).toBeTruthy();
    expect(queryTestId("pr-merge-button")).toBeNull();

    // The cards: every blocker, in order, then what passed.
    expect(screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["draft", "checks", "review", "conversations", "mergeable"]);
    expect(within(byTestId("pr-ready-passed")).getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["mergeable"]);
    expect(texts("pr-ready-title")[1]).toBe("2 checks failing · 2 running · 2 passed · 1 skipped");
    // The checks card lists the failing ones.
    expect(texts("pr-check")).toEqual([expect.stringContaining("test (macos-15)") as string, expect.stringContaining("lint") as string]);
    // The issue rows carry pr.task's kind for the thread buttons.
    expect(screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.task ?? "")).toEqual(["", "checks", "review", "conversations", ""]);

    const reviewers = screen.getAllByTestId("pr-reviewer");
    expect(reviewers).toHaveLength(4);
    expect(reviewers[0]?.dataset).toMatchObject({ login: "teammate-kim", status: "changes_requested", stale: "true" });
    expect(byTestId("pr-reviewers").textContent).toContain("and more on GitHub");
    expect(texts("pr-label")).toEqual(["bug", "terminal"]);

    // The description renders markdown: a heading and a task list.
    expect(within(byTestId("pr-description")).getByRole("heading", { name: "Test plan" })).toBeTruthy();
    expect(within(byTestId("pr-description")).getAllByRole("checkbox")).toHaveLength(2);

    // The checks card unfolds every check, failed first, with its tone.
    expect(byTestId("pr-ready-checks-toggle").textContent).toBe("All 7 checks");
    fireEvent.click(byTestId("pr-ready-checks-toggle"));
    expect(byTestId("pr-ready-checks-toggle").textContent).toBe("Failing only");
    const checks = screen.getAllByTestId("pr-check");
    expect(checks).toHaveLength(7);
    expect(checks[0]?.textContent).toContain("test (macos-15)");
    expect(checks.slice(0, 2).map((c) => c.dataset.tone)).toEqual(["failure", "failure"]);
    expect(checks.find((c) => c.textContent.includes("e2e (chromium)"))?.dataset.tone).toBe("pending");
    expect(checks.find((c) => c.textContent.includes("release-notes"))?.dataset.tone).toBe("skipped");
    // A check opens its log.
    fireEvent.click(checks[0] as HTMLElement);
    await settle();
    expect(urlsOpened().at(-1)).toBe("https://github.com/alexwaumann/code-foundry/actions/runs/1/job/11");
    fireEvent.click(byTestId("pr-ready-checks-toggle"));
    expect(screen.getAllByTestId("pr-check")).toHaveLength(2);

    // Comments: newest first; threads grouped with their location and badges.
    expect(byTestId("pr-comments").textContent).toContain("Comments(9)");
    const threads = screen.getAllByTestId("pr-thread");
    expect(threads).toHaveLength(3);
    expect(texts("pr-thread-location")[0]).toBe("internal/store/terminal/actor.go:214");
    const outdated = threads.find((t) => t.textContent.includes("terminal.go:40"));
    expect(outdated?.dataset.outdated).toBe("true");
    expect(outdated?.textContent).toContain("Resolved");
    expect(children("pr-comments-list")[0]?.textContent).toContain("requested changes");
    fireEvent.click(byTestId("pr-comment-order"));
    expect(byTestId("pr-comment-order").textContent).toBe("Oldest first");
    // Oldest first: the outdated thread from 8 hours ago, then the bot's review.
    expect(children("pr-comments-list")[0]?.textContent).toContain("Why remove the size check?");
    expect(children("pr-comments-list")[1]?.textContent).toContain("Walkthrough");

  });

  it("#140 (read access) explains the picker and has no revert; #131 is closed and its timeline ends closed; an unknown number says not found", async () => {
    renderPrPanel();
    await openPr(140);
    expect(prTabs()).toEqual(["#140"]);
    expect(byTestId("pr-author").textContent).toBe("outside-contrib");
    fireEvent.click(byTestId("pr-add-reviewer"));
    expect(byTestId("pr-reviewer-readonly").textContent).toBe("Asking someone to review needs write access on this repository.");
    expect(queryTestId("pr-reviewer-candidate")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(queryTestId("pr-reviewer-picker")).toBeNull();

    await openPr(131);
    expect(byTestId("pr-header").dataset.state).toBe("closed");
    const menu = openMenu();
    expect(within(menu).getByTestId("pr-menu-open")).toBeTruthy();
    expect(within(menu).queryByTestId("pr-menu-revert")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(screen.getAllByTestId("pr-timeline-entry")[0]?.dataset.kind).toBe("closed");

    await openPr(9999);
    expect(byTestId("pr-not-found").textContent).toContain("Pull request not found");
  });
});

describe("the inner tab row", () => {
  it("Overview | Activity, then the Diff button alone at the right end with the files and lines; it opens the diff beside the pull request's tab, and again shows that one", async () => {
    renderPrPanel();
    await openPr(142);
    const bar = byTestId("pr-inner-bar");
    expect(within(bar).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Activity"]);
    const pr = world.detail(142)?.pullRequest;
    if (!pr) throw new Error("no #142");
    const button = byTestId("pr-diff-button");
    expect(button.textContent).toBe(`Diff${String(pr.changedFiles)} files+${pr.additions.toLocaleString()} −${pr.deletions.toLocaleString()}`);
    expect(children("pr-inner-bar-end")).toEqual([button]);
    // The page's one diffstat.
    expect(byTestId("pr-surface").textContent.match(/ files/g)).toHaveLength(1);

    fireEvent.click(button);
    await act(async () => {
      await layoutSettled();
    });
    const strip = () => screen.queryAllByTestId("shell-tab").map((t) => t.dataset.kind);
    expect(strip()).toEqual(["pullrequest", "prdiff"]);
    await selectPrTab("#142");
    fireEvent.click(byTestId("pr-diff-button"));
    await act(async () => {
      await layoutSettled();
    });
    expect(strip()).toEqual(["pullrequest", "prdiff"]);
  });

  it("a tab left on the Code tab (gone) shows Overview", async () => {
    renderPrPanel();
    await openPr(142);
    const tab = screen.getAllByTestId("shell-tab").find((t) => t.dataset.kind === "pullrequest")?.dataset.tabId ?? "";
    expect(tab).not.toBe("");
    act(() => {
      usePrPanelStore.setState((s) => ({ byTab: { ...s.byTab, [tab]: { inner: "code" as never, commentOrder: "newest", timelineOrder: "newest", open: {} } } }));
    });
    expect(byTestId("pr-tab-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByTestId("pr-ready-row").length).toBeGreaterThan(0);
  });
});

describe("Activity", () => {
  it("lists commits, reviews and the end state; the order toggles; a commit opens on GitHub; another tab starts on Overview", async () => {
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-activity"));
    const entries = () => screen.getAllByTestId("pr-timeline-entry");
    // 4 commits, 3 issue comments, 2 reviews, opened.
    expect(entries()).toHaveLength(10);
    expect(entries()[0]?.dataset.kind).toBe("commit");
    expect(entries()[0]?.textContent).toContain("fix(terminal): replay resize after snapshot");
    expect(entries()[0]?.textContent).toContain("8d4b3f6");
    expect(entries()[1]?.dataset.kind).toBe("review");
    expect(entries()[1]?.textContent).toContain("teammate-kim");
    expect(entries()[1]?.textContent).toContain("requested changes");
    expect(entries().at(-1)?.dataset.kind).toBe("opened");
    // The bar counts timeline entries (not the header's comments, which include thread replies) and commits.
    expect(byTestId("pr-timeline-counts").textContent).toMatch(/10 entries\s*·\s*4/);
    fireEvent.click(byTestId("pr-timeline-order"));
    expect(entries()[0]?.dataset.kind).toBe("opened");
    // A commit opens on GitHub.
    const commit = entries().find((e) => e.textContent.includes("8d4b3f6"));
    fireEvent.click(within(commit as HTMLElement).getByRole("button"));
    await settle();
    expect(urlsOpened().at(-1)).toMatch(/\/commit\/8d4b3f6/);

    // Another tab starts on Overview; coming back finds Activity still selected.
    await openPr(138);
    expect(prTabs()).toEqual(["#145", "#138"]);
    expect(byTestId("pr-tab-overview").getAttribute("aria-selected")).toBe("true");
    // Merged: the timeline starts with the merge.
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(entries()[0]?.dataset.kind).toBe("merged");
    fireEvent.click(byTestId("pr-tab-overview"));
    await selectPrTab("#145");
    await settle();
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
  });

  it("inner tabs stay per tab: coming back to a thread's tab finds Activity still selected", async () => {
    seedWorld();
    await resetPrStores({ kind: "thread", id: "s-1" });
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-activity"));
    fireEvent.click(byTestId("pr-timeline-order"));
    await openPr(138);
    expect(prTabs()).toEqual(["#145", "#138"]);
    expect(byTestId("pr-tab-overview").getAttribute("aria-selected")).toBe("true");
    await selectPrTab("#145");
    await settle();
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("pr-timeline").dataset.order).toBe("oldest");
  });

  it("inner tabs stay per tab on the Pull Requests page too (an unlinked tab)", async () => {
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-activity"));
    await openPr(138);
    await selectPrTab("#145");
    await settle();
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
  });

  it("closing a tab drops its inner state: reopened, it starts on Overview with the activity newest first", async () => {
    seedWorld();
    await resetPrStores({ kind: "thread", id: "s-1" });
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-activity"));
    fireEvent.click(byTestId("pr-timeline-order"));
    expect(byTestId("pr-timeline").dataset.order).toBe("oldest");
    await closePrTab("#145");
    expect(queryTestId("pr-surface")).toBeNull();
    await openPr(145);
    expect(byTestId("pr-tab-overview").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(byTestId("pr-timeline").dataset.order).toBe("newest");
  });
});

describe("the reviewer picker", () => {
  const candidates = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-testid="pr-reviewer-candidate"]')];
  const rows = (root: ParentNode = document) => candidates(root).map((e) => [e.dataset.login, e.dataset.requested]);
  const group = (id: string) => queryTestId(id);
  const inGroup = (id: string) => {
    const g = group(id);
    return g ? candidates(g) : [];
  };
  const search = () => byTestId("pr-reviewer-search") as HTMLInputElement;

  /** Types into the search and waits out its pause (fake timers), then lets the read land. */
  async function type(text: string): Promise<void> {
    fireEvent.change(search(), { target: { value: text } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260);
    });
    await settle();
  }

  /** Selects a candidate row (cmdk selects on click) and lets the request and the re-read land. */
  async function choose(row: HTMLElement): Promise<void> {
    fireEvent.click(row);
    await settle(4);
  }

  /** Opens the picker as a pointer does (a press on the trigger keeps its tooltip shut, then the click). */
  async function openPicker(): Promise<void> {
    const trigger = byTestId("pr-add-reviewer");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("shows the requests and recents, searches from 2 characters, and toggles requests through pr.review.request", async () => {
    renderPrPanel();
    await openPr(145);
    await openPicker();
    expect(byTestId("pr-reviewer-picker")).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(search().placeholder).toBe("Search people with access");
    // Under 2 characters: the pending requests (with a check); nobody recent yet.
    expect(byTestId("pr-reviewer-requested").textContent).toContain("Requested");
    expect(rows()).toEqual([
      ["acme/core", "true"],
      ["teammate-ana", "true"],
      ["teammate-kim", "true"],
    ]);
    expect(group("pr-reviewer-recent")).toBeNull();

    // Two or more search: someone past GitHub's first 100 is found under Matches; the pending
    // requests that do not match stay below under Requested; no match says so.
    await type("zoe-zim");
    expect(rows()).toEqual([
      ["zoe-zimmerman", "false"],
      ["acme/core", "true"],
      ["teammate-ana", "true"],
      ["teammate-kim", "true"],
    ]);
    expect(inGroup("pr-reviewer-matches")).toHaveLength(1);
    expect(inGroup("pr-reviewer-requested")).toHaveLength(3);
    expect(queryTestId("pr-reviewer-searching")).toBeNull();
    await type("nobody-at-all");
    expect(byTestId("pr-reviewer-nomatch").textContent).toBe("No one matches.");

    // Choosing a result requests a review; the candidates and the detail are read again.
    await type("lee");
    expect(inGroup("pr-reviewer-matches").map((e) => e.dataset.login)).toEqual(["teammate-lee"]);
    await choose(inGroup("pr-reviewer-matches")[0] as HTMLElement);
    expect(invocationsOf("pr.review.request").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145", login: "teammate-lee", kind: "user", requested: "true" }]);
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "teammate-lee")?.dataset.status).toBe("requested");
    // Read again, it stays under Matches with its check, once.
    expect(candidates().filter((e) => e.dataset.login === "teammate-lee")).toHaveLength(1);
    expect(inGroup("pr-reviewer-matches")[0]?.dataset.requested).toBe("true");

    // Requested now, so not in Recent; withdrawn, it stays in Recent with a ×.
    await type("");
    expect(inGroup("pr-reviewer-requested").filter((e) => e.dataset.login === "teammate-lee")).toHaveLength(1);
    expect(group("pr-reviewer-recent")).toBeNull();
    await choose(inGroup("pr-reviewer-requested").find((e) => e.dataset.login === "teammate-lee") as HTMLElement);
    expect(inGroup("pr-reviewer-recent").map((e) => [e.dataset.login, e.dataset.requested])).toEqual([["teammate-lee", "false"]]);

    // Recents survive closing the picker.
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(queryTestId("pr-reviewer-picker")).toBeNull();
    await openPicker();
    expect(inGroup("pr-reviewer-recent")).toHaveLength(1);

    // × drops the row from Recent without requesting anything.
    const before = invocationsOf("pr.review.request").length;
    fireEvent.click(within(inGroup("pr-reviewer-recent")[0] as HTMLElement).getByTestId("pr-reviewer-recent-remove"));
    expect(group("pr-reviewer-recent")).toBeNull();
    expect(invocationsOf("pr.review.request")).toHaveLength(before);

    // Choosing a requested team withdraws it; it is the only request since the ×.
    await choose(candidates().find((e) => e.dataset.login === "acme/core") as HTMLElement);
    expect(invocationsOf("pr.review.request").slice(before).map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145", login: "acme/core", kind: "team", requested: "false" }]);
    expect(screen.getAllByTestId("pr-reviewer").filter((r) => r.dataset.login === "acme/core")).toHaveLength(0);

    // Escape closes the picker; the panel keeps its tab.
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(queryTestId("pr-reviewer-picker")).toBeNull();
    expect(prTabs()).toEqual(["#145"]);
  });

  it('matches every word ("jane doe" finds "Doe, Jane"), keeps a requested row checked, and toasts a request GitHub did not take', async () => {
    renderPrPanel();
    await openPr(145);
    await openPicker();
    const matches = () => inGroup("pr-reviewer-matches").map((e) => [e.dataset.login, e.dataset.requested]);

    // First last against names stored "Last, First"; the word order does not matter.
    await type("doe, jane");
    expect(matches()).toEqual([
      ["jdoe", "false"],
      ["zdoe", "false"],
    ]);
    await type("jane doe");
    expect(matches()).toEqual([
      ["jdoe", "false"],
      ["zdoe", "false"],
    ]);

    // Choosing one requests a review; the row stays, checked, once the candidates are read
    // again (requested now, it must match "jane doe" word by word to stay among the results).
    await choose(inGroup("pr-reviewer-matches")[0] as HTMLElement);
    expect(invocationsOf("pr.review.request").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145", login: "jdoe", kind: "user", requested: "true" }]);
    expect(within(inGroup("pr-reviewer-matches")[0] as HTMLElement).getByLabelText("Requested")).toBeTruthy();
    expect(matches()).toEqual([
      ["jdoe", "true"],
      ["zdoe", "false"],
    ]);
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "jdoe")?.dataset.status).toBe("requested");
    // The other requests sit below under Requested; jdoe is not repeated there.
    expect(inGroup("pr-reviewer-requested").map((e) => e.dataset.login)).toEqual(["acme/core", "teammate-ana", "teammate-kim"]);
    expect(candidates().filter((e) => e.dataset.login === "jdoe")).toHaveLength(1);

    // Someone without access: the daemon refuses, the toast says why; the row stays unchecked.
    await type("olga outside");
    expect(matches()).toEqual([["outside-olga", "false"]]);
    await choose(inGroup("pr-reviewer-matches")[0] as HTMLElement);
    await expectToast("Request Review failed");
    await expectToast("GitHub did not add outside-olga as a reviewer (they may lack access to the repository)");
    expect(inGroup("pr-reviewer-matches")[0]?.dataset.requested).toBe("false");
    expect(within(inGroup("pr-reviewer-matches")[0] as HTMLElement).queryByLabelText("Updating")).toBeNull();
  });
});

describe("the ⋯ menu", () => {
  it("Start a thread, This pull request, then Open on GitHub, Copy link and Copy branch name, then Refresh (and a failed one)", async () => {
    renderPrPanel();
    await openPr(145);
    let menu = openMenu();
    expect([...menu.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((l) => l.textContent)).toEqual(["Start a thread", "This pull request"]);
    // A draft: no Convert to draft.
    const items = menuItems(menu);
    expect(items).toEqual(["Ask a question", "Explain this PR", "Fix findings", "Close pull request", "Link to thread", "Open on GitHub", "Copy link⇧⌘C", "Copy branch name", expect.stringMatching(/^RefreshUpdated \d+s ago$/) as string]);
    for (const id of ["pr-menu-ask", "pr-menu-explain", "pr-menu-fix"]) {
      expect(byTestId(id).hasAttribute("data-disabled")).toBe(false);
      expect(byTestId(id).hasAttribute("title")).toBe(false);
    }
    // Revert is the merged header's button, never a menu item.
    expect(queryTestId("pr-menu-revert")).toBeNull();
    expect(byTestId("pr-menu-refresh-hint").textContent).toMatch(/^Updated \d+s ago$/);

    // Refresh runs pr.refresh and stays open with the new time; quiet: no toast.
    await pick(byTestId("pr-menu-refresh"));
    await settle();
    expect(invocationsOf("pr.refresh").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
    expect(byTestId("pr-menu")).toBeTruthy();
    expect(byTestId("pr-menu-refresh-hint").textContent).toMatch(/^Updated (just now|[0-5]s ago)$/);
    expect(toastTexts().filter((t) => t.includes("Refreshed #145"))).toEqual([]);
    // A failure is toasted and reported over the copy, which stays.
    world.failNext.add("pr.refresh");
    await pick(byTestId("pr-menu-refresh"));
    await expectToast("Refresh Pull Request failed");
    expect(byTestId("pr-refresh-error").textContent).toContain("502 Bad Gateway");
    expect(screen.getAllByTestId("pr-ready-row")).toHaveLength(5);

    await pick(byTestId("pr-menu-copy"));
    expect(queryTestId("pr-menu")).toBeNull();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`https://github.com/${SLUG}/pull/145`);
    await expectToast("Link copied");

    menu = openMenu();
    await pick(within(menu).getByTestId("pr-menu-open"));
    expect(urlsOpened().at(-1)).toBe(`https://github.com/${SLUG}/pull/145`);
  });

  const START = ["Ask a question", "Explain this PR", "Fix findings"];
  const END = ["Link to thread", "Open on GitHub", "Copy link⇧⌘C", "Copy branch name", expect.stringMatching(/^Refresh/) as string];
  for (const { name, number, change, mine } of [
    { name: "open", number: 142, mine: ["Convert to draft", "Close pull request"] },
    { name: "draft", number: 145, mine: ["Close pull request"] },
    { name: "merged", number: 138, mine: [] },
    { name: "closed", number: 131, mine: ["Reopen pull request"] },
    { name: "no permission (read access, not the author)", number: 140, change: (d: PullRequestDetailView) => ({ ...d, viewerCanClose: false }), mine: [] },
    { name: "closed, no permission", number: 131, change: (d: PullRequestDetailView) => ({ ...d, viewerCanReopen: false }), mine: [] },
  ] as { name: string; number: number; change?: (d: PullRequestDetailView) => PullRequestDetailView; mine: string[] }[]) {
    it(`${name} (#${String(number)}): This pull request has ${mine.join(", ") || "only Link to thread"}`, async () => {
      if (change) world.update(number, change);
      renderPrPanel();
      await openPr(number);
      expect(menuItems(openMenu())).toEqual([...START, ...mine, ...END]);
    });
  }

  it("Copy branch name copies the head branch", async () => {
    renderPrPanel();
    await openPr(142);
    openMenu();
    await pick(byTestId("pr-menu-copy-branch"));
    expect(queryTestId("pr-menu")).toBeNull();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(world.detail(142)?.pullRequest.headRef);
    await expectToast("Branch name copied");
  });

  it("Close pull request: pr.close asks; a spinner and Closing… until the detail shows it closed, then the menu closes and offers Reopen", async () => {
    renderPrPanel();
    await openPr(142);
    openMenu();
    await pick(byTestId("pr-menu-close"));
    expect(byTestId("confirm-dialog").textContent).toContain("without merging it?");
    const release = world.hold("pr.close");
    fireEvent.click(byTestId("confirm-ok"));
    await settle();
    expect(invocationsOf("pr.close").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "142" }, { "repo-slug": SLUG, number: "142" }]);
    expect(byTestId("pr-menu-button-busy")).toBeTruthy();
    release();
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("closed");
    });
    await vi.waitFor(() => {
      expect(queryTestId("pr-menu-button-busy")).toBeNull();
    });
    await expectToast("Closed #142");
    expect(menuItems(openMenu())).toEqual([...START, "Reopen pull request", ...END]);
  });

  it("Reopen pull request: no question; spins in the open menu until the detail shows it open", async () => {
    renderPrPanel();
    await openPr(131);
    const release = world.hold("pr.reopen");
    openMenu();
    await pick(byTestId("pr-menu-reopen"));
    expect(queryTestId("confirm-dialog")).toBeNull();
    const item = byTestId("pr-menu-reopen");
    expect(item.textContent).toContain("Reopening…");
    expect(within(item).getByTestId("pr-menu-busy")).toBeTruthy();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await pick(item);
    expect(invocationsOf("pr.reopen")).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(queryTestId("pr-menu")).toBeNull();
    });
    expect(byTestId("pr-header").dataset.state).toBe("open");
  });

  it("the pane dispatches the surface's own key: shift+cmd+c copies the link, not from a text field", async () => {
    renderPrPanel();
    await openPr(145);
    fireEvent.keyDown(byTestId("pr-title"), { key: "c", code: "KeyC", metaKey: true, shiftKey: true });
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`https://github.com/${SLUG}/pull/145`);
    await expectToast("Link copied");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    fireEvent.keyDown(input("pr-ask-input"), { key: "c", code: "KeyC", metaKey: true, shiftKey: true });
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("#138 (merged) offers Revert: it confirms, runs pr.revert and opens the new pull request as a tab", async () => {
    renderPrPanel();
    await openPr(138);
    expect(byTestId("pr-header").dataset.state).toBe("merged");
    expect(byTestId("pr-ready-headline").textContent).toBe("Merged");
    expect(byTestId("pr-ready-meta").textContent).toBe("3c3c465 into main 1d ago");
    expect(byTestId("pr-header").dataset.tone).toBe("merged");
    // No requirement cards once merged; Revert is the header's one action and left the menu.
    expect(queryTestId("pr-readiness")).toBeNull();
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(within(byTestId("pr-ready-footer")).getByTestId("pr-revert").textContent).toBe("Revert");
    openMenu();
    expect(queryTestId("pr-menu-revert")).toBeNull();
    fireEvent.keyDown(byTestId("pr-menu"), { key: "Escape" });
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    expect(byTestId("confirm-dialog").textContent).toContain("This opens a new pull request that reverses the changes merged by #138.");
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    expect(invocationsOf("pr.revert").map((i) => [i.args.number, i.confirmed])).toEqual([
      ["138", false],
      ["138", true],
    ]);
    expect(prTabs()).toEqual(["#138", "#151"]);
    await expectToast("Opened #151 to revert #138");
    await selectPrTab("#151");
    expect(byTestId("pr-title").textContent).toBe('Revert "chore(gh): pace requests through one worker"');
  });

  it("the revert's new pull request is shown at once", async () => {
    renderPrPanel();
    await openPr(138);
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    expect(byTestId("pr-title").textContent).toBe('Revert "chore(gh): pace requests through one worker"');
  });

  it("declining the revert's confirmation sends nothing", async () => {
    renderPrPanel();
    await openPr(138);
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    fireEvent.click(byTestId("confirm-cancel"));
    await settle();
    expect(queryTestId("confirm-dialog")).toBeNull();
    expect(invocationsOf("pr.revert").filter((i) => i.confirmed)).toEqual([]);
    expect(prTabs()).toEqual(["#138"]);
  });
});

describe("threads about a pull request", () => {
  it("Explain this PR: the menu stays open with a spinner until pr.explain answers (no worktree from the Pull Requests page), then the started toast", async () => {
    renderPrPanel();
    await openPr(145);
    const release = world.hold("pr.explain");
    openMenu();
    await pick(byTestId("pr-menu-explain"));
    expect(byTestId("pr-menu-explain").getAttribute("aria-busy")).toBe("true");
    expect(byTestId("pr-menu")).toBeTruthy();
    // No worktree, model or effort args: the daemon picks them.
    expect(invocationsOf("pr.explain").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([{ args: { "repo-slug": SLUG, number: "145" }, worktree: "" }]);
    release();
    await settle();
    await expectToast(/Started thread s-new-\d+ for PR #145/);
    expect(queryTestId("pr-menu")).toBeNull();
    expect(toastCount("Preparing worktree")).toBe(0);
  });

  it("Fix findings: a failure toasts the daemon's hint and keeps the menu; a retry shows Preparing while it runs", async () => {
    renderPrPanel();
    await openPr(145);
    world.failNext.add("pr.fix.findings");
    openMenu();
    await pick(byTestId("pr-menu-fix"));
    await expectToast("Fix Pull Request Findings failed");
    await expectToast(/gh pr checkout 145/);
    // A quick answer leaves no "Preparing" toast behind; the menu stays open for a retry.
    expect(toastCount("Preparing worktree for #145…")).toBe(0);
    expect(byTestId("pr-menu")).toBeTruthy();
    expect(byTestId("pr-menu-fix").hasAttribute("aria-busy")).toBe(false);

    const release = world.hold("pr.fix.findings");
    await pick(byTestId("pr-menu-fix"));
    expect(byTestId("pr-menu-fix").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      await new Promise((r) => setTimeout(r, PREPARING_TOAST_DELAY_MS + 20));
    });
    await expectToast("Preparing worktree for #145…");
    release();
    await settle(3);
    await expectToast(/Started thread s-new-\d+ for PR #145/);
    await vi.waitFor(() => {
      expect(toastCount("Preparing worktree for #145…")).toBe(0);
    });
    expect(invocationsOf("pr.fix.findings").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([
      { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
      { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
    ]);
  });

  it("Ask a question from a thread: a composer under the header; Escape cancels; Enter sends pr.ask with the thread's worktree", async () => {
    seedWorld();
    await resetPrStores({ kind: "thread", id: "s-1" });
    renderPrPanel();
    await openPr(145);
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    expect(queryTestId("pr-menu")).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input("pr-ask-input"));
    });
    expect(input("pr-ask-input").placeholder).toBe("Ask about this pull request…");
    fireEvent.change(input("pr-ask-input"), { target: { value: "never mind" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Escape" });
    expect(queryTestId("pr-ask")).toBeNull();
    // Escape stays in the composer: the tab stays.
    expect(prTabs()).toEqual(["#145"]);

    openMenu();
    await pick(byTestId("pr-menu-ask"));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input("pr-ask-input"));
    });
    expect(input("pr-ask-input").value).toBe(""); // a fresh composer
    fireEvent.change(input("pr-ask-input"), { target: { value: "Why does attach race the first output?\nAnd is the fix covered by a test?" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter", shiftKey: true });
    expect(invocationsOf("pr.ask")).toEqual([]);
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await settle();
    // The daemon prefers the caller's worktree: the context carries it, not an arg.
    expect(invocationsOf("pr.ask").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([
      { args: { "repo-slug": SLUG, number: "145", question: "Why does attach race the first output?\nAnd is the fix covered by a test?" }, worktree: CF },
    ]);
    expect(queryTestId("pr-ask")).toBeNull();
  });

  it("Escape from the Ask composer hands focus back to the tab's pane, so its keys keep working", async () => {
    renderPrPanel();
    await openPr(145);
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input("pr-ask-input"));
    });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Escape" });
    expect(document.activeElement?.closest('[data-testid="shell-pane"]')).toBeTruthy();
  });

  it("Ask from the Pull Requests page sends no worktree; while it starts, Cancel is disabled, the field read-only and Escape does nothing", async () => {
    renderPrPanel();
    await openPr(145);
    const release = world.hold("pr.ask");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    expect(byTestId("pr-ask-hint").textContent).toBe("⏎ send · ⇧⏎ newline");
    fireEvent.change(input("pr-ask-input"), { target: { value: "What changed?" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await settle();
    expect(byTestId("pr-ask-hint").textContent).toBe("Starting a thread…");
    expect(byTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");
    expect((byTestId("pr-ask-cancel") as HTMLButtonElement).disabled).toBe(true);
    expect(input("pr-ask-input").readOnly).toBe(true);
    fireEvent.keyDown(input("pr-ask-input"), { key: "Escape" });
    expect(byTestId("pr-ask")).toBeTruthy();
    expect(prTabs()).toEqual(["#145"]);

    release();
    await settle();
    expect(invocationsOf("pr.ask").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "What changed?" }, worktree: "" }]);
    await expectToast(/Started thread s-new-\d+ for PR #145/);
    expect(queryTestId("pr-ask")).toBeNull();
  });

  it("a failed pr.ask is toasted and keeps the question for a retry with the send button", async () => {
    renderPrPanel();
    await openPr(145);
    world.failNext.add("pr.ask");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    fireEvent.change(input("pr-ask-input"), { target: { value: "Is the retry bounded?" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await expectToast("Ask About Pull Request failed");
    await expectToast("read #145: github graphql: 502 Bad Gateway");
    expect(byTestId("pr-ask")).toBeTruthy();
    expect(input("pr-ask-input").value).toBe("Is the retry bounded?");
    expect(input("pr-ask-input").readOnly).toBe(false);
    expect(byTestId("pr-ask-hint").textContent).toBe("⏎ send · ⇧⏎ newline");
    expect((byTestId("pr-ask-cancel") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(byTestId("pr-ask-send"));
    await settle();
    expect(invocationsOf("pr.ask").map((i) => i.args.question)).toEqual(["Is the retry bounded?", "Is the retry bounded?"]);
    await expectToast(/Started thread s-new-\d+ for PR #145/);
  });

  it("a pull request's running threads show on every surface that shows it (a thread's tab and the Pull Requests page's, in another space)", async () => {
    seedWorld();
    // One pull request tab per space: thread s-1 in Main, the page's tab in Review.
    await resetPrStores({ kind: "thread", id: "s-1" }, "spaces");
    renderPrPanel();
    // Ask from thread s-1's tab.
    await openPr(145);
    const releaseAsk = world.hold("pr.ask");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    fireEvent.change(input("pr-ask-input"), { target: { value: "From s-1" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await settle();
    expect(byTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");

    // Meanwhile #145 on the Pull Requests page: its composer says so and sends nothing.
    await showSpace("sp-review", PR_PAGE);
    await openPr(145);
    expect(prTabs()).toEqual(["#145"]);
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    expect(byTestId("pr-ask-hint").textContent).toBe("Already starting a thread for this pull request");
    expect(byTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");
    expect((byTestId("pr-ask-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input("pr-ask-input"), { target: { value: "From the page" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await settle();
    expect(byTestId("pr-ask-hint").textContent).toBe("Already starting a thread for this pull request");
    expect(input("pr-ask-input").value).toBe("From the page");
    releaseAsk();
    await expectToast(/Started thread s-new-\d+ for PR #145/);
    await settle();
    // s-1's question starts its thread; this one was never sent.
    expect(invocationsOf("pr.ask").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "From s-1" }, worktree: CF }]);

    // Explain from the Pull Requests page; s-1's menu shows it running and disabled.
    const releaseExplain = world.hold("pr.explain");
    openMenu();
    await pick(byTestId("pr-menu-explain"));
    expect(byTestId("pr-menu-explain").getAttribute("aria-busy")).toBe("true");
    expect(byTestId("pr-menu-explain").getAttribute("aria-disabled")).toBe("true");
    await showSpace("sp-main", { kind: "thread", id: "s-1" });
    await settle();
    expect(prTabs()).toEqual(["#145"]);
    openMenu();
    expect(byTestId("pr-menu-explain").getAttribute("aria-busy")).toBe("true");
    expect(byTestId("pr-menu-explain").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("pr-menu-fix").hasAttribute("aria-disabled")).toBe(false);
    // aria-disabled keeps it focusable; a select sends nothing.
    await pick(byTestId("pr-menu-explain"));
    expect(invocationsOf("pr.explain")).toHaveLength(1);
    releaseExplain();
    await settle();
    await vi.waitFor(() => {
      expect(toastTexts().filter((t) => /Started thread s-new-\d+ for PR #145/.test(t))).toHaveLength(2);
    });
  });
});

describe("the header's status and the Overview's cards", () => {
  it("#139 (your review requested): headline, the row, and Review as the primary button", async () => {
    renderPrPanel();
    await openPr(139);
    expect(byTestId("pr-ready-headline").textContent).toBe("Waiting on your review");
    const row = byTestId("pr-readiness").querySelector<HTMLElement>('[data-row="review-request"]');
    expect(row?.textContent).toContain("teammate-kim asked for your review");
    expect(row?.dataset.task).toBe("review-request");
    expect(byTestId("pr-review-button").dataset.primary).toBe("true");
    // #142: nobody asked the viewer; Review is the plain button.
    await openPr(142);
    expect(byTestId("pr-review-button").dataset.primary).toBeUndefined();
  });

  it("#140: a workflow waiting for approval has its own row whose Approve on GitHub leaves the app", async () => {
    renderPrPanel();
    await openPr(140);
    expect(screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["workflow-approval", "review", "mergeable"]);
    expect(texts("pr-ready-title")[0]).toBe("1 workflow waiting for approval");
    fireEvent.click(byTestId("pr-approve-workflow"));
    await settle();
    expect(urlsOpened().at(-1)).toBe(`https://github.com/${SLUG}/pull/140`);
  });

  it("#160: a conversation's file name takes focus and its tooltip has the full path", async () => {
    renderPrPanel();
    await openPr(160);
    const locations = screen.getAllByTestId("pr-ready-location");
    expect(locations.map((l) => l.textContent)).toEqual(["dashboard.go:88", "dashboard.go:140", "fingerprint.go:12"]);
    expect(locations[0]?.tabIndex).toBe(0);
    expect(tooltipText(locations[0] as HTMLElement)).toBe("internal/store/gh/dashboard.go:88");
  });

  it("a long description fades out behind Show all, which shows it whole in place (Show less folds it again); a short one shows whole", async () => {
    const tall = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "pr-description-content" ? 600 : 0;
    });
    try {
      renderPrPanel();
      await openPr(145);
      const body = () => byTestId("pr-description-body");
      expect(body().dataset.folded).toBe("true");
      // Twice the app's fold, so a summary reads without unfolding.
      expect(body().style.maxHeight).toBe("340px");
      expect(byTestId("pr-description-toggle").textContent).toBe("Show all");
      fireEvent.click(byTestId("pr-description-toggle"));
      expect(body().dataset.folded).toBe("false");
      expect(body().style.maxHeight).toBe("");
      expect(byTestId("pr-description-toggle").textContent).toBe("Show less");
      expect(byTestId("pr-description-toggle").getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(byTestId("pr-description-toggle"));
      expect(body().dataset.folded).toBe("true");
      tall.mockReturnValue(0);
      // Another tab whose description fits: no fade, no button.
      await openPr(138);
      expect(body().dataset.folded).toBe("false");
      expect(queryTestId("pr-description-toggle")).toBeNull();
    } finally {
      tall.mockRestore();
    }
  });

  it("a folded description that shrinks under the fold (an edited body) unfolds: its content is measured, not the clipped box", async () => {
    let height = 600;
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe(el: Element): void {
          if ((el as HTMLElement).dataset.testid === "pr-description-content") observed.push(this.cb);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const tall = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "pr-description-content" ? height : 0;
    });
    try {
      renderPrPanel();
      await openPr(145);
      expect(byTestId("pr-description-body").dataset.folded).toBe("true");
      // 350px: over the 340px fold, under the 364px that is worth a Show all.
      height = 350;
      act(() => {
        for (const cb of observed) cb();
      });
      expect(byTestId("pr-description-body").dataset.folded).toBe("false");
      expect(queryTestId("pr-description-toggle")).toBeNull();
    } finally {
      tall.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("the header is the same on every tab: the state and its buttons on Activity too; the cards are Overview's only", async () => {
    renderPrPanel();
    await openPr(142);
    for (const tab of ["pr-tab-activity", "pr-tab-overview"]) {
      fireEvent.click(byTestId(tab));
      await settle();
      expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
      const footer = byTestId("pr-ready-footer");
      expect(within(footer).getAllByRole("button").map((b) => b.dataset.testid)).toEqual(["pr-review-button", "pr-merge-button", "pr-merge-button-menu-button"]);
      expect(screen.queryAllByTestId("pr-ready-row").length > 0).toBe(tab === "pr-tab-overview");
    }
    // Review opens the review dialog, from any tab (#142 is the viewer's own: on Comment).
    fireEvent.click(byTestId("pr-tab-activity"));
    fireEvent.click(byTestId("pr-review-button"));
    await settle();
    expect(byTestId("pr-review-dialog").dataset.verdict).toBe("comment");
  });

  for (const { number, words, tone } of [
    { number: 142, words: "Ready to merge", tone: "success" },
    { number: 160, words: "Not ready to merge", tone: "warning" },
    { number: 161, words: "Not ready to merge", tone: "warning" },
    { number: 163, words: "Waiting on checks", tone: "warning" },
    { number: 164, words: "Auto-merge on", tone: "warning" },
    { number: 145, words: "Draft", tone: "neutral" },
    { number: 138, words: "Merged", tone: "merged" },
    { number: 131, words: "Closed", tone: "failure" },
  ]) {
    it(`#${String(number)}: ${words}, washed ${tone}`, async () => {
      renderPrPanel();
      await openPr(number);
      expect(byTestId("pr-ready-headline").textContent).toBe(words);
      expect(byTestId("pr-ready-headline").dataset.tone).toBe(tone);
      expect(byTestId("pr-header").dataset.tone).toBe(tone);
      // Quiet text after the words only for an end state; an open one's detail is on the cards.
      expect(queryTestId("pr-ready-meta") !== null).toBe(number === 138 || number === 131);
    });
  }

  it("#142: only what passed, on one quiet card; #160: its Show unfolds every check and Hide folds them", async () => {
    renderPrPanel();
    await openPr(142);
    const passed = byTestId("pr-ready-passed");
    expect(within(passed).getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["checks", "review", "mergeable"]);
    expect(texts("pr-ready-title")).toEqual(["All 31 checks passed · 2 skipped", "Approved", "No conflicts with main"]);
    // The rollup alone (no list of checks): nothing to unfold.
    expect(queryTestId("pr-ready-checks-toggle")).toBeNull();
    await openPr(160);
    expect(within(byTestId("pr-ready-passed")).getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["checks", "mergeable"]);
    expect(byTestId("pr-ready-checks-toggle").textContent).toBe("Show");
    expect(queryTestId("pr-check")).toBeNull();
    fireEvent.click(byTestId("pr-ready-checks-toggle"));
    expect(byTestId("pr-ready-checks-toggle").textContent).toBe("Hide");
    expect(byTestId("pr-checks-list").dataset.all).toBe("true");
    fireEvent.click(byTestId("pr-ready-checks-toggle"));
    expect(byTestId("pr-ready-checks-toggle").textContent).toBe("Show");
    expect(queryTestId("pr-check")).toBeNull();
  });

  it("#163: the running checks' card leads with the turning working circle and lists them, each with its dot, queued or ticking, and All N checks unfolds the rest", async () => {
    renderPrPanel();
    await openPr(163);
    const card = byTestId("pr-readiness").querySelector<HTMLElement>('[data-row="checks"]') as HTMLElement;
    expect(card.dataset.tone).toBe("pending");
    // The card leads with the app's running mark (the sidebar's Working icon), turning, in the
    // warning tone; no spinner.
    const icon = within(card).getByTestId("pr-ready-icon");
    expect(icon.getAttribute("class")).toContain("lucide-circle-dashed");
    expect(icon.getAttribute("class")).toContain("animate-status-working");
    expect(icon.getAttribute("class")).toContain("text-cf-warning-text");
    expect(icon.getAttribute("class")).not.toMatch(/animate-spin|lucide-loader/);
    const running = within(card).getAllByTestId("pr-check");
    // A single running or queued check keeps its own dot, unlike the card's mark.
    for (const c of running) expect(c.querySelector("svg")?.getAttribute("class")).toContain("lucide-circle-dot");
    expect(running.map((c) => c.dataset.tone)).toEqual(running.map(() => "pending"));
    expect(within(card).getAllByTestId("pr-check-meta").map((m) => m.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/^(queued|\d+[ms].*)$/) as string]));
    fireEvent.click(within(card).getByTestId("pr-ready-checks-toggle"));
    expect(within(card).getByTestId("pr-ready-checks-toggle").textContent).toBe("Running only");
    expect(within(card).getAllByTestId("pr-check").length).toBeGreaterThan(running.length);
  });

  it("merged and closed pull requests have no cards; their details keep the reviewers (no picker) and the labels", async () => {
    renderPrPanel();
    await openPr(138);
    expect(queryTestId("pr-readiness")).toBeNull();
    expect(byTestId("pr-age-merged").textContent).toBe("Merged1d ago");
    expect(texts("pr-label")).toEqual(["chore"]);
    expect(queryTestId("pr-add-reviewer")).toBeNull();
    await openPr(142);
    expect(byTestId("pr-reviewers")).toBeTruthy();
    expect(byTestId("pr-add-reviewer")).toBeTruthy();
    // No labels: no block.
    expect(queryTestId("pr-labels")).toBeNull();
  });
});

describe("the merge button", () => {
  const button = () => byTestId("pr-merge-button");
  const chevron = () => byTestId("pr-merge-button-menu-button");
  const merges = () => invocationsOf("pr.merge").map((i) => [i.args, i.confirmed]);
  const checked = (id: string) => byTestId(id).getAttribute("aria-checked");

  it("#142: a method picked in the menu is the default at once: the label changes, the menu closes, nothing merges", async () => {
    renderPrPanel();
    await openPr(142);
    expect(byTestId("pr-header").dataset.state).toBe("open");
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
    expect(button().textContent).toBe("Squash and merge");
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    // The chevron is icon-only: its name is its tooltip.
    expect(chevron().getAttribute("aria-label")).toBe("Merge options");
    press(chevron());
    const menu = byTestId("pr-merge-button-menu");
    expect(byTestId("pr-merge-menu-heading").textContent).toBe("Merge into main · your pick becomes the default here");
    const items = methodItems(menu);
    expect(items).toHaveLength(3);
    [/^Create a merge commit/, /^Squash and merge/, /^Rebase and merge/].forEach((re, i) => {
      expect(items[i]).toMatch(re);
    });
    // The default has the tick.
    expect(["merge", "squash", "rebase"].map((m) => checked(`pr-merge-method-${m}`))).toEqual(["false", "true", "false"]);
    expect(checked("pr-merge-delete-branch")).toBe("true");
    expect(byTestId("pr-merge-delete-branch-note").textContent).toBe("Deletes origin/feat/sidebar; local branches and worktrees are untouched");

    await pick(byTestId("pr-merge-method-rebase"));
    expect(queryTestId("pr-merge-button-menu")).toBeNull();
    expect(button().textContent).toBe("Rebase and merge");
    expect(queryTestId("pr-merge-dialog")).toBeNull();
    expect(merges()).toEqual([]);
    press(chevron());
    expect(checked("pr-merge-method-rebase")).toBe("true");
  });

  it("#142 merges: the main part opens the merge dialog, its Merge is the one question; busy in the method's words until the box turns Merged", async () => {
    renderPrPanel();
    await openPr(142);
    fireEvent.click(button());
    await settle();
    // The merge's own dialog, not the warning-looking confirm; nothing sent yet.
    expect(queryTestId("confirm-dialog")).toBeNull();
    expect(merges()).toEqual([]);
    expect(byTestId("pr-merge-dialog-title").textContent).toBe("Squash and merge");
    // owner/repo #number as the page header says it, then the title.
    expect(byTestId("pr-merge-dialog-repo").textContent).toBe(`${SLUG} #142`);
    expect(byTestId("pr-merge-dialog-pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    expect(byTestId("pr-merge-dialog-into").textContent).toBe("IntomainIts commits become 1");
    expect(byTestId("pr-merge-dialog-from").textContent).toBe("Fromfeat/sidebar");
    expect(["merge", "squash", "rebase"].map((m) => checked(`pr-merge-dialog-method-${m}`))).toEqual(["false", "true", "false"]);
    expect(byTestId("pr-merge-dialog-branch").textContent).toBe("BranchDelete it on origin after merging");
    expect(byTestId("pr-merge-dialog-delete-branch").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("pr-merge-dialog-confirm").textContent).toBe("Squash and merge");
    expect(document.activeElement).toBe(byTestId("pr-merge-dialog-confirm"));

    const release = world.hold("pr.merge");
    fireEvent.click(byTestId("pr-merge-dialog-confirm"));
    await settle();
    expect(queryTestId("pr-merge-dialog")).toBeNull();
    expect(queryTestId("confirm-dialog")).toBeNull();
    // Sent once, already confirmed, with the head the panel shows.
    expect(merges()).toEqual([[{ "repo-slug": SLUG, number: "142", method: "squash", "delete-branch": "true", "head-sha": HEAD_142 }, true]]);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent).toBe("Squashing and merging…");
    release();
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("merged");
    });
    expect(queryTestId("pr-merge-button")).toBeNull();
    // Merged: Revert is the one button left.
    expect(within(byTestId("pr-ready-footer")).getAllByRole("button").map((b) => b.dataset.testid)).toEqual(["pr-revert"]);
    await expectToast("Merged #142 (e2e0142)");
    await expectToast("deleted origin/feat/sidebar");
  });

  it("#142: while the merge runs the status says Merging into main… in the state's tone; Merged once the detail shows it", async () => {
    renderPrPanel();
    await openPr(142);
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
    const release = world.hold("pr.merge");
    fireEvent.click(button());
    await settle();
    fireEvent.click(byTestId("pr-merge-dialog-confirm"));
    await settle();
    expect(byTestId("pr-ready-headline").textContent).toBe("Merging into main…");
    expect(byTestId("pr-ready-headline").dataset.tone).toBe("success");
    expect(byTestId("pr-header").dataset.tone).toBe("success");
    expect(queryTestId("pr-ready-meta")).toBeNull();
    release();
    await vi.waitFor(() => {
      expect(byTestId("pr-ready-headline").textContent).toBe("Merged");
    });
    expect(byTestId("pr-header").dataset.tone).toBe("merged");
    expect(byTestId("pr-ready-meta").textContent).toMatch(/ into main just now$/);
  });

  it("#142: the dialog's Method changes its words and the repository's default; its branch box and Cancel", async () => {
    renderPrPanel();
    await openPr(142);
    fireEvent.click(button());
    await settle();
    fireEvent.click(byTestId("pr-merge-dialog-method-merge"));
    await settle();
    expect(byTestId("pr-merge-dialog-title").textContent).toBe("Merge");
    expect(byTestId("pr-merge-dialog-outcome").textContent).toBe("Its commits and a merge commit");
    expect(byTestId("pr-merge-dialog-confirm").textContent).toBe("Merge");
    // The default moved with it: the button behind the dialog says so too.
    expect(button().textContent).toBe("Merge");
    fireEvent.click(byTestId("pr-merge-dialog-delete-branch"));
    expect(byTestId("pr-merge-dialog-delete-branch").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(byTestId("pr-merge-dialog-cancel"));
    await settle();
    expect(queryTestId("pr-merge-dialog")).toBeNull();
    expect(merges()).toEqual([]);
    expect(button().hasAttribute("aria-busy")).toBe(false);
    // The branch box is the menu's too: unchecked for the next merge of this pull request.
    press(chevron());
    expect(checked("pr-merge-delete-branch")).toBe("false");
    fireEvent.keyDown(byTestId("pr-merge-button-menu"), { key: "Escape" });
    fireEvent.click(button());
    await settle();
    fireEvent.click(byTestId("pr-merge-dialog-method-rebase"));
    fireEvent.click(byTestId("pr-merge-dialog-confirm"));
    await settle(3);
    expect(merges()).toEqual([[{ "repo-slug": SLUG, number: "142", method: "rebase", "delete-branch": "false", "head-sha": HEAD_142 }, true]]);
  });

  // Four cases that were one test: each opens only what it needs, so none nears the timeout under load.
  it("#161 (conflicts): disabled with the reason; a click opens nothing; the menu says why", async () => {
    renderPrPanel();
    await openPr(161);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    // Visibly disabled, both parts (the app's disabled opacity), never like Review beside it.
    expect(byTestId("pr-merge-button-split").dataset.blocked).toBe("true");
    for (const part of [button(), chevron()]) expect(part.classList.contains("opacity-50")).toBe(true);
    expect(tooltipText(button())).toBe("Resolve conflicts first");
    expect(document.getElementById(button().getAttribute("aria-describedby") ?? "")?.textContent).toBe("Resolve conflicts first");
    fireEvent.click(button());
    await settle();
    expect(queryTestId("pr-merge-dialog")).toBeNull();
    press(chevron());
    expect(texts("pr-merge-note")).toEqual(["Resolve conflicts first"]);
    expect(merges()).toEqual([]);
  });

  it("#138 (merged) has no merge button; #140 (read access) no merge controls at all", async () => {
    renderPrPanel();
    await openPr(138);
    expect(byTestId("pr-header").dataset.state).toBe("merged");
    expect(queryTestId("pr-merge-button")).toBeNull();
    await openPr(140);
    expect(queryTestId("pr-merge-button")).toBeNull();
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
  });

  it("#142: GitHub refuses (the head moved): busy in the method's words while it runs, then toasted, still open, the button usable again", async () => {
    renderPrPanel();
    await openPr(142);
    world.failNext.add("pr.merge");
    const release = world.hold("pr.merge");
    press(chevron());
    await pick(byTestId("pr-merge-method-rebase"));
    fireEvent.click(button());
    await settle();
    fireEvent.click(byTestId("pr-merge-dialog-confirm"));
    await settle();
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().textContent).toBe("Rebasing and merging…");
    release();
    await expectToast("Merge Pull Request failed");
    await expectToast(/changed on GitHub since it was loaded/);
    await vi.waitFor(() => {
      expect(button().hasAttribute("aria-busy")).toBe(false);
    });
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    expect(byTestId("pr-header").dataset.state).toBe("open");
    expect(button().textContent).toBe("Rebase and merge");
  });

  it("#146 from a fork: no branch to delete in the menu or the dialog; pr.merge asked elsewhere confirms calmly and toasts that the branch was kept", async () => {
    renderPrPanel();
    await openPr(146);
    expect(byTestId("pr-header").dataset.state).toBe("open");
    press(chevron());
    expect(checked("pr-merge-delete-branch")).toBe("false");
    expect(byTestId("pr-merge-delete-branch").getAttribute("data-disabled")).toBe("");
    expect(byTestId("pr-merge-delete-branch-note").textContent).toBe("The branch is in a fork");
    fireEvent.keyDown(byTestId("pr-merge-button-menu"), { key: "Escape" });
    expect(queryTestId("pr-merge-button-menu")).toBeNull();
    fireEvent.click(button());
    await settle();
    expect(queryTestId("pr-merge-dialog-branch")).toBeNull();
    fireEvent.click(byTestId("pr-merge-dialog-cancel"));
    await settle();

    // pr.merge not from the dialog, with delete-branch on (as the CLI can): the command's own
    // question, in the success tone; the daemon's answer says it kept the branch.
    void mergePullRequest({ slug: SLUG, number: 146 }, "squash", true, "f04c146000000000000000000000000000000000");
    await settle();
    expect(byTestId("confirm-dialog").dataset.tone).toBe("success");
    expect(byTestId("confirm-icon").dataset.tone).toBe("success");
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("merged");
    });
    await expectToast("kept patch-1: it is in a fork");
  });

  it("#162 behind (GitHub reports BEHIND): the row says the repository wants it up to date; Merge is disabled and Auto-merge offered", async () => {
    renderPrPanel();
    await openPr(162);
    // The card for what blocks first, then the passed card.
    expect(screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).toEqual(["behind", "checks", "review", "mergeable"]);
    expect(texts("pr-ready-title")[0]).toBe("Behind main");
    const behind = byTestId("pr-readiness").querySelector<HTMLElement>('[data-row="behind"]');
    expect(behind?.textContent).toContain("This repository only merges branches that are up to date with main.");
    expect(behind?.dataset.task).toBe("behind");
    expect(queryTestId("pr-merge-button")).toBeNull();
    expect(byTestId("pr-auto-merge-button").textContent).toBe("Auto-merge");
  });
});

describe("auto-merge", () => {
  const autoMerges = () => invocationsOf("pr.auto-merge").map((i) => [i.args, i.confirmed]);
  const head163 = "163c0ffee".padEnd(40, "0");

  it("#163 (checks running, approved): Auto-merge confirms and runs pr.auto-merge with the method and the head; the box then says Auto-merge on and Cancel turns it off", async () => {
    renderPrPanel();
    await openPr(163);
    expect(byTestId("pr-ready-headline").textContent).toBe("Waiting on checks");
    expect(queryTestId("pr-ready-meta")).toBeNull();
    expect(queryTestId("pr-merge-button")).toBeNull();
    // The menu picks the repository's default, as Merge's does: the pick turns nothing on.
    press(byTestId("pr-auto-merge-button-menu-button"));
    expect(byTestId("pr-auto-merge-menu-heading").textContent).toBe("Merge once requirements pass · your pick becomes the default here");
    expect(methodItems(byTestId("pr-auto-merge-button-menu"))).toEqual([
      "Create a merge commitGitHub merges it with a merge commit once its required checks and reviews pass.",
      "Squash and mergeGitHub merges it as one commit once its required checks and reviews pass.",
      "Rebase and mergeGitHub merges it by rebasing once its required checks and reviews pass.",
    ]);
    expect(byTestId("pr-auto-merge-method-squash").getAttribute("aria-checked")).toBe("true");
    await pick(byTestId("pr-auto-merge-method-rebase"));
    expect(queryTestId("pr-auto-merge-button-menu")).toBeNull();
    expect(autoMerges()).toEqual([]);
    // The main part asks (calmly, the success tone); declining sends nothing more.
    fireEvent.click(byTestId("pr-auto-merge-button"));
    await settle();
    expect(byTestId("confirm-dialog").dataset.tone).toBe("success");
    expect(byTestId("confirm-dialog").textContent).toContain("Turn on auto-merge for #163 with rebase?");
    fireEvent.click(byTestId("confirm-cancel"));
    await settle();
    const args = { "repo-slug": SLUG, number: "163", method: "rebase", "head-sha": head163 };
    expect(autoMerges()).toEqual([[args, false]]);
    fireEvent.click(byTestId("pr-auto-merge-button"));
    await settle();
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    expect(autoMerges().slice(1)).toEqual([
      [args, false],
      [args, true],
    ]);
    await vi.waitFor(() => {
      expect(byTestId("pr-ready-headline").textContent).toBe("Auto-merge on");
    });
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
    fireEvent.click(byTestId("pr-cancel-auto-merge"));
    await settle(3);
    expect(autoMerges().at(-1)).toEqual([{ "repo-slug": SLUG, number: "163", off: "true" }, false]);
    await vi.waitFor(() => {
      expect(byTestId("pr-auto-merge-button")).toBeTruthy();
    });
    // The main part uses the method chosen last in this repository.
    fireEvent.click(byTestId("pr-auto-merge-button"));
    await settle();
    expect(autoMerges().at(-1)).toEqual([{ "repo-slug": SLUG, number: "163", method: "rebase", "head-sha": head163 }, false]);
  });

  it("#164 (auto-merge on): the words alone, Cancel auto-merge only", async () => {
    renderPrPanel();
    await openPr(164);
    expect(byTestId("pr-ready-headline").textContent).toBe("Auto-merge on");
    expect(queryTestId("pr-ready-meta")).toBeNull();
    expect(queryTestId("pr-merge-button")).toBeNull();
    expect(byTestId("pr-cancel-auto-merge").textContent).toBe("Cancel auto-merge");
  });

  it("a repository without auto-merge keeps Merge disabled with a note in its menu; a stale copy says nothing about auto-merge", async () => {
    world.update(163, (d) => ({ ...d, autoMergeAllowed: false }));
    renderPrPanel();
    await openPr(163);
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
    expect(byTestId("pr-merge-button").getAttribute("aria-disabled")).toBe("true");
    press(byTestId("pr-merge-button-menu-button"));
    expect(texts("pr-merge-note")).toEqual(["Blocked: required checks or reviews are missing", "Auto-merge is off for this repository"]);
    fireEvent.keyDown(byTestId("pr-merge-button-menu"), { key: "Escape" });

    // The copy served after a failed fetch may predate autoMergeAllowed: no note, no Auto-merge.
    world.update(162, (d) => ({ ...d, autoMergeAllowed: false, lastError: "github graphql: 502 Bad Gateway", fetchFailed: true }));
    await openPr(162);
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
    press(byTestId("pr-merge-button-menu-button"));
    expect(texts("pr-merge-note")).toEqual(["Behind main: this repository merges only up-to-date branches"]);
  });
});

describe("a stale copy refreshing behind the panel", () => {
  const landed = async (number: number) => {
    await act(async () => {
      applyGhEvent({ kind: "pullRequestDetail", repoSlug: SLUG, number });
      await Promise.resolve();
    });
    await settle(3);
  };

  it("says nothing on a normal open, says Updating… only once it runs long, and goes when the fetch lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      world.update(145, (d) => ({ ...d, refreshing: true }));
      renderPrPanel();
      await openPr(145);
      expect(queryTestId("pr-loading")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(UPDATING_AFTER_MS - 200);
      });
      expect(queryTestId("pr-updating")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(byTestId("pr-updating").textContent).toBe("Updating…");
      world.update(145, (d) => ({ ...d, refreshing: false }));
      await landed(145);
      expect(queryTestId("pr-updating")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the open tab and takes the new readiness and checks in place when the fetch lands", async () => {
    world.update(142, (d) => ({ ...d, refreshing: true }));
    renderPrPanel();
    await openPr(142);
    const surface = byTestId("pr-surface");
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
    const rows = () => screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row);
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");

    const [sample] = [...world.details.values()].flatMap((d) => d.checks);
    if (!sample) throw new Error("no check in the world");
    const failing = { ...sample, name: "go-test", status: "completed", conclusion: "failure" };
    world.update(142, (d) => ({ ...d, refreshing: false, checks: [failing], pullRequest: { ...d.pullRequest, draft: true } }));
    await landed(142);
    expect(byTestId("pr-surface")).toBe(surface); // updated, not remounted
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
    // The header took the new state on this tab; the cards have it on Overview.
    expect(byTestId("pr-ready-headline").textContent).toBe("Draft");
    fireEvent.click(byTestId("pr-tab-overview"));
    expect(rows()).toContain("draft");
    expect(texts("pr-ready-title").join(" ")).toContain("failing");
    expect(queryTestId("pr-loading")).toBeNull();
  });

  it("a failed refresh keeps the copy and adds the stale strip on every tab, the reason in its tooltip, Retry refreshing; never the error page", async () => {
    world.update(145, (d) => ({ ...d, refreshing: true }));
    renderPrPanel();
    await openPr(145);
    const title = byTestId("pr-title").textContent;
    world.update(145, (d) => ({ ...d, refreshing: false, fetchFailed: true, lastError: "github graphql: 502 Bad Gateway" }));
    await landed(145);
    expect(byTestId("pr-title").textContent).toBe(title);
    expect(byTestId("pr-stale-text").textContent).toBe("Showing the copy from just now. GitHub could not be reached.");
    // The reason is hidden text: the tooltip has it, and the text takes focus to show it.
    expect(tooltipText(byTestId("pr-stale-text"))).toBe("github graphql: 502 Bad Gateway");
    expect(byTestId("pr-stale-text").tabIndex).toBe(0);
    expect(queryTestId("pr-error")).toBeNull();
    expect(queryTestId("pr-updating")).toBeNull();
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(byTestId("pr-stale")).toBeTruthy();
    fireEvent.click(byTestId("pr-stale-retry"));
    await settle();
    expect(invocationsOf("pr.refresh").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
  });

  it("a copy that may predate autoMergeAllowed claims nothing about auto-merge until its fetch lands", async () => {
    world.update(162, (d) => ({ ...d, autoMergeAllowed: false, refreshing: true }));
    renderPrPanel();
    await openPr(162);
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
    press(byTestId("pr-merge-button-menu-button"));
    expect(texts("pr-merge-note")).not.toContain("Auto-merge is off for this repository");
    fireEvent.keyDown(byTestId("pr-merge-button-menu"), { key: "Escape" });

    world.update(162, (d) => ({ ...d, autoMergeAllowed: true, refreshing: false }));
    await landed(162);
    expect(queryTestId("pr-auto-merge-button")).not.toBeNull();
  });
});

describe("draft and links", () => {
  it("#145's Ready for review runs pr.ready; the draft row goes; ⋯ → Convert to draft runs pr.draft and it comes back", async () => {
    renderPrPanel();
    await openPr(145);
    // A draft is never offered Convert to draft.
    openMenu();
    expect(queryTestId("pr-menu-draft")).toBeNull();
    fireEvent.keyDown(byTestId("pr-menu"), { key: "Escape" });
    fireEvent.click(byTestId("pr-ready-for-review"));
    await settle(3);
    expect(invocationsOf("pr.ready").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("open");
    });
    expect(screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row)).not.toContain("draft");
    // The box shows the change: no success toast for its button.
    expect(toastCount("ready for review")).toBe(0);

    openMenu();
    await pick(byTestId("pr-menu-draft"));
    await settle(2);
    expect(invocationsOf("pr.draft").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("draft");
    });
    // The panel showing Draft (the menu waits for it) is the result: no success toast.
    expect(toastCount("draft")).toBe(0);
  });

  it("Convert to draft needs write access or authorship; merged pull requests have none", async () => {
    renderPrPanel();
    await openPr(140);
    openMenu();
    expect(queryTestId("pr-menu-draft")).toBeNull();
    fireEvent.keyDown(byTestId("pr-menu"), { key: "Escape" });
    await openPr(138);
    openMenu();
    expect(queryTestId("pr-menu-draft")).toBeNull();
  });

  const setLinks = (thread: string, links: { slug: string; number: number }[]) => {
    act(() => {
      useThreadsStore.setState((s) => {
        const t = s.byId[thread];
        if (!t) throw new Error(`no ${thread}`);
        return { byId: { ...s.byId, [thread]: { ...t, linkedPullRequests: links.map((l) => ({ ...l, url: `https://github.com/${l.slug}/pull/${String(l.number)}`, linkedAt: null })) } } };
      });
    });
  };
  /** Opens ⋯ → Link to thread: the app's shared submenu (ArrowRight on its trigger, as Radix opens one from the keyboard). */
  const openLinkMenu = async () => {
    openMenu();
    const trigger = byTestId("pr-menu-link");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    return vi.waitFor(() => {
      const sub = byTestId("pr-menu-link-threads");
      expect(sub.dataset.state).toBe("open");
      return sub;
    });
  };
  const linkRows = () => screen.getAllByTestId("pr-menu-link-thread").map((r) => ({ thread: r.dataset.thread, name: r.textContent.replace(/Linked$/, ""), linked: r.dataset.linked === "true" }));

  it("Link to thread lists the thread tabs open in this space by name, ticked when they link the pull request (any case); a pick runs thread.pr.link and spins until the tick", async () => {
    seedWorld();
    // s-1 and s-3 have tabs in this space (s-1's pane also holds the Pull Requests page's tab).
    await resetPrStores({ kind: "thread", id: "s-1" }, "grid");
    setLinks("s-3", [{ slug: SLUG.toUpperCase(), number: 142 }]);
    renderPrPanel();
    await openPr(142);
    const sub = await openLinkMenu();
    // A submenu of its own (a menu beside the ⋯ menu), headed, one row per thread tab.
    expect(sub.getAttribute("role")).toBe("menu");
    expect(byTestId("pr-menu").contains(sub)).toBe(false);
    expect(within(sub).getByText("Threads open in this space")).toBeTruthy();
    expect(linkRows()).toEqual([
      { thread: "s-1", name: "Refactor sidebar tree", linked: false },
      { thread: "s-3", name: "Fix resize race", linked: true },
    ]);
    expect(byTestId("pr-menu-link").hasAttribute("data-disabled")).toBe(false);
    expect(byTestId("pr-menu-link").getAttribute("aria-expanded")).toBe("true");

    // A ticked row is inert: there is no unlink.
    const ticked = screen.getAllByTestId("pr-menu-link-thread")[1] as HTMLElement;
    expect(ticked.getAttribute("aria-disabled")).toBe("true");
    await pick(ticked);
    expect(invocationsOf("thread.pr.link")).toEqual([]);
    expect(byTestId("pr-menu")).toBeTruthy();

    // An unticked one links: its row spins and the menu stays until the thread lists the link.
    const row = screen.getAllByTestId("pr-menu-link-thread")[0] as HTMLElement;
    await pick(row);
    expect(invocationsOf("thread.pr.link").map((i) => i.args)).toEqual([{ id: "s-1", pr: `${SLUG}#142` }]);
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(within(row).getByTestId("pr-menu-busy")).toBeTruthy();
    expect(byTestId("pr-menu")).toBeTruthy();
    // A second pick meanwhile sends nothing.
    await pick(row);
    expect(invocationsOf("thread.pr.link")).toHaveLength(1);
    // The daemon publishes the thread with the link: the menu closes; reopened, both are ticked.
    setLinks("s-1", [{ slug: SLUG, number: 142 }]);
    await vi.waitFor(() => {
      expect(queryTestId("pr-menu")).toBeNull();
    });
    await openLinkMenu();
    expect(linkRows().map((r) => r.linked)).toEqual([true, true]);
  });

  it("Link to thread lists only this space's thread tabs; a failed link frees its row", async () => {
    seedWorld();
    // s-3's tab is in the Review space.
    await resetPrStores({ kind: "thread", id: "s-1" }, "spaces");
    renderPrPanel();
    await openPr(142);
    await openLinkMenu();
    expect(linkRows().map((r) => r.thread)).toEqual(["s-1"]);
    daemon.handlers.set("thread.pr.link", () => {
      throw refuse("thread s-1 is archived");
    });
    const row = byTestId("pr-menu-link-thread");
    await pick(row);
    await settle(2);
    expect(invocationsOf("thread.pr.link")).toHaveLength(1);
    expect(row.hasAttribute("aria-busy")).toBe(false);
    expect(byTestId("pr-menu")).toBeTruthy();
  });

  it("Link to thread with no thread tab in this space: the trigger is disabled, like the app's other disabled submenu rows, and opens nothing", async () => {
    seedWorld();
    await resetPrStores();
    renderPrPanel();
    await openPr(142);
    openMenu();
    const trigger = byTestId("pr-menu-link");
    expect(trigger.hasAttribute("data-disabled")).toBe(true);
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    fireEvent.click(trigger);
    await settle();
    expect(queryTestId("pr-menu-link-threads")).toBeNull();
    expect(queryTestId("pr-menu-link-thread")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("busy feedback", () => {
  const busyMark = (id: string) => queryTestId(`${id}-busy`);

  it("Ready for review: a spinner and Marking ready… until it answers; a press meanwhile sends nothing", async () => {
    renderPrPanel();
    await openPr(145);
    expect(byTestId("pr-ready-for-review").textContent).toBe("Ready for review");
    expect(busyMark("pr-ready-for-review")).toBeNull();
    expect(byTestId("pr-ready-for-review").getAttribute("aria-disabled")).toBeNull();
    const release = world.hold("pr.ready");
    fireEvent.click(byTestId("pr-ready-for-review"));
    await settle();
    const button = byTestId("pr-ready-for-review");
    expect(button.textContent).toBe("Marking ready…");
    expect(busyMark("pr-ready-for-review")).toBeTruthy();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    await settle();
    expect(invocationsOf("pr.ready")).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("open");
    });
    expect(queryTestId("pr-ready-for-review")).toBeNull();
  });

  it("Ready for review that fails goes back to its label", async () => {
    renderPrPanel();
    await openPr(145);
    world.failNext.add("pr.ready");
    fireEvent.click(byTestId("pr-ready-for-review"));
    await settle(3);
    expect(byTestId("pr-ready-for-review").textContent).toBe("Ready for review");
    expect(busyMark("pr-ready-for-review")).toBeNull();
    expect(byTestId("pr-ready-for-review").getAttribute("aria-disabled")).toBeNull();
  });

  it("Convert to draft: the menu stays open with a spinner and Converting to draft… until it answers, then shuts", async () => {
    renderPrPanel();
    await openPr(142);
    const release = world.hold("pr.draft");
    openMenu();
    expect(byTestId("pr-menu-draft").textContent).toBe("Convert to draft");
    await pick(byTestId("pr-menu-draft"));
    const item = byTestId("pr-menu-draft");
    expect(item.textContent).toContain("Converting to draft…");
    expect(within(item).getByTestId("pr-menu-busy")).toBeTruthy();
    expect(item.getAttribute("aria-busy")).toBe("true");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await pick(item);
    expect(invocationsOf("pr.draft")).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("draft");
    });
    await vi.waitFor(() => {
      expect(queryTestId("pr-menu")).toBeNull();
    });
    expect(queryTestId("pr-menu-button-busy")).toBeNull();
  });

  it("Convert to draft that fails stays in the open menu, idle again", async () => {
    renderPrPanel();
    await openPr(142);
    world.failNext.add("pr.draft");
    openMenu();
    await pick(byTestId("pr-menu-draft"));
    await settle(3);
    const item = byTestId("pr-menu-draft");
    expect(item.textContent).toBe("Convert to draft");
    expect(item.getAttribute("aria-busy")).toBeNull();
    expect(within(item).queryByTestId("pr-menu-busy")).toBeNull();
  });

  it("Convert to draft with its menu closed: the ⋯ button spins", async () => {
    renderPrPanel();
    await openPr(142);
    expect(queryTestId("pr-menu-button-busy")).toBeNull();
    const release = world.hold("pr.draft");
    openMenu();
    await pick(byTestId("pr-menu-draft"));
    fireEvent.keyDown(byTestId("pr-menu"), { key: "Escape" });
    await settle();
    expect(queryTestId("pr-menu")).toBeNull();
    expect(byTestId("pr-menu-button-busy")).toBeTruthy();
    release();
    await vi.waitFor(() => {
      expect(queryTestId("pr-menu-button-busy")).toBeNull();
    });
  });

  it("Cancel auto-merge: a spinner and Cancelling… until it answers", async () => {
    renderPrPanel();
    await openPr(164);
    const release = world.hold("pr.auto-merge");
    fireEvent.click(byTestId("pr-cancel-auto-merge"));
    await settle();
    const button = byTestId("pr-cancel-auto-merge");
    expect(button.textContent).toBe("Cancelling…");
    expect(busyMark("pr-cancel-auto-merge")).toBeTruthy();
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    await settle();
    expect(invocationsOf("pr.auto-merge")).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(queryTestId("pr-cancel-auto-merge")).toBeNull();
    });
  });

  it("another change running: Cancel auto-merge waits, dimmed, without claiming to cancel", async () => {
    renderPrPanel();
    await openPr(164);
    const release = world.hold("pr.draft");
    openMenu();
    await pick(byTestId("pr-menu-draft"));
    const button = byTestId("pr-cancel-auto-merge");
    expect(button.textContent).toBe("Cancel auto-merge");
    expect(busyMark("pr-cancel-auto-merge")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    release();
    await settle(3);
  });

  it("Revert: the header's button shows it until it answers; a second press opens no second revert", async () => {
    renderPrPanel();
    await openPr(138);
    const release = world.hold("pr.revert");
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    const button = byTestId("pr-revert");
    expect(button.textContent).toBe("Reverting…");
    expect(busyMark("pr-revert")).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // One spinner, on the button: the ⋯ menu has no Revert now.
    expect(queryTestId("pr-menu-button-busy")).toBeNull();
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    expect(queryTestId("confirm-dialog")).toBeNull();
    expect(invocationsOf("pr.revert").filter((i) => i.confirmed)).toHaveLength(1);
    release();
    await vi.waitFor(() => {
      expect(prTabs()).toEqual(["#138", "#151"]);
    });
    expect(usePrPanelStore.getState().reverting).toEqual({});
  });

  it("a declined revert goes back to Revert", async () => {
    renderPrPanel();
    await openPr(138);
    fireEvent.click(byTestId("pr-revert"));
    await settle();
    fireEvent.click(byTestId("confirm-cancel"));
    await settle(3);
    expect(byTestId("pr-revert").textContent).toBe("Revert");
    expect(busyMark("pr-revert")).toBeNull();
    expect(queryTestId("pr-menu-button-busy")).toBeNull();
  });
});

describe("Review and its dialog", () => {
  const reviews = () => invocationsOf("pr.review").map((i) => i.args);
  const reviewInput = () => input("pr-review-dialog-input");

  /** Opens the dialog from the Review button (or the chip once the viewer has reviewed); picks a verdict when given. */
  async function openReview(verdict?: "approve" | "request-changes" | "comment"): Promise<void> {
    fireEvent.click(queryTestId("pr-review-button") ?? byTestId("pr-your-review"));
    await settle();
    expect(byTestId("pr-review-dialog")).toBeTruthy();
    if (verdict) fireEvent.click(byTestId(`pr-review-dialog-${verdict}`));
  }

  it("on #139: Review opens the dialog on Approve, cmd+Enter runs pr.review; the header says You approved and Comments has the review", async () => {
    renderPrPanel();
    await openPr(139);
    expect(byTestId("pr-author").textContent).toBe("teammate-kim");
    expect(byTestId("pr-review-button").textContent).toBe("Review");
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "alexwaumann")?.dataset.status).toBe("requested");

    await openReview();
    expect(byTestId("pr-review-dialog").dataset.verdict).toBe("approve");
    expect(byTestId("pr-review-dialog-title").textContent).toBe("Review");
    expect(byTestId("pr-review-dialog-repo").textContent).toBe(`${SLUG} #139`);
    expect(queryTestId("pr-review-dialog-own")).toBeNull();
    // No inline composer any more: the review is the dialog's.
    expect(queryTestId("pr-review-composer")).toBeNull();
    const release = world.hold("pr.review");
    fireEvent.change(reviewInput(), { target: { value: "Read it through.\nShip it." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle();
    // The dialog shut at once; the button is busy in the verdict's words until the detail shows the review.
    expect(queryTestId("pr-review-dialog")).toBeNull();
    expect(byTestId("pr-review-button").textContent).toBe("Approving…");
    expect(byTestId("pr-review-button").getAttribute("aria-busy")).toBe("true");
    release();
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-your-review").textContent).toBe("You approved");
    });
    expect(reviews()).toEqual([{ "repo-slug": SLUG, number: "139", verdict: "approve", body: "Read it through.\nShip it." }]);
    // The chip and the review in Comments show it: no success toast.
    expect(toastCount("Approved #139")).toBe(0);
    const chip = byTestId("pr-your-review");
    expect(chip.dataset.review).toBe("approved");
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "alexwaumann")?.dataset.status).toBe("approved");
    const mine = screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("Ship it."));
    expect(mine).toHaveLength(1);
    expect(within(mine[0] as HTMLElement).getByTestId("pr-review-verdict").textContent).toBe("approved");

    // The chip opens the dialog again, on the previous verdict, empty: GitHub takes another review.
    await openReview();
    expect(byTestId("pr-review-dialog").dataset.verdict).toBe("approve");
    expect(reviewInput().value).toBe("");
    fireEvent.keyDown(reviewInput(), { key: "Escape" });
    expect(queryTestId("pr-review-dialog")).toBeNull();
  });

  it("a review GitHub did not confirm is toasted, the button comes back, and the text is there on the next open; other text posts", async () => {
    renderPrPanel();
    await openPr(139);
    await openReview("request-changes");
    fireEvent.change(reviewInput(), { target: { value: "The retry loop never backs off." } });
    world.failNext.add("pr.review");
    const release = world.hold("pr.review");
    fireEvent.click(byTestId("pr-review-dialog-confirm"));
    await settle();
    expect(byTestId("pr-review-button").textContent).toBe("Requesting changes…");
    release();
    await expectToast("Review Pull Request failed");
    await expectToast(/GitHub did not confirm the review/);
    await vi.waitFor(() => {
      expect(byTestId("pr-review-button").textContent).toBe("Review");
    });
    expect(byTestId("pr-review-button").hasAttribute("aria-busy")).toBe(false);

    await openReview();
    expect(byTestId("pr-review-dialog").dataset.verdict).toBe("request-changes");
    expect(reviewInput().value).toBe("The retry loop never backs off.");
    fireEvent.change(reviewInput(), { target: { value: "The retry loop never backs off; add a jittered delay." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-your-review").textContent).toBe("You requested changes");
    });
    expect(byTestId("pr-your-review").dataset.review).toBe("changes_requested");
    expect(screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("jittered delay"))).toHaveLength(1);
    expect(reviews().map((a) => a.body)).toEqual(["The retry loop never backs off.", "The retry loop never backs off; add a jittered delay."]);
  });

  it("#145 (the viewer's own): the dialog opens on Comment with Approve and Request changes off and the reason; Comment posts a review; #140 and #138 have no Review", async () => {
    renderPrPanel();
    await openPr(145);
    expect(byTestId("pr-author").textContent).toBe("alexwaumann");
    await openReview();
    expect(byTestId("pr-review-dialog").dataset.verdict).toBe("comment");
    expect(byTestId("pr-review-dialog-approve").hasAttribute("disabled")).toBe(true);
    expect(byTestId("pr-review-dialog-request-changes").hasAttribute("disabled")).toBe(true);
    expect(byTestId("pr-review-dialog-own").textContent).toBe("You can’t approve or request changes on your own pull request.");
    fireEvent.change(reviewInput(), { target: { value: "Rebased on main." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-your-review").textContent).toBe("You commented");
    });
    expect(screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("Rebased on main."))).toHaveLength(1);
    expect(reviews()).toEqual([{ "repo-slug": SLUG, number: "145", verdict: "comment", body: "Rebased on main." }]);

    // GitHub's refusal from the palette or CLI (the dialog never sends it) comes back as its message.
    await act(async () => {
      await runCommandForResult("pr.review", { "repo-slug": SLUG, number: "145", verdict: "approve" });
    });
    await expectToast("Review Can not approve your own pull request");

    // Read access only: no Review (and no merge controls). Merged: none either.
    await openPr(140);
    expect(byTestId("pr-author").textContent).toBe("outside-contrib");
    expect(byTestId("pr-ready-headline").textContent).toBe("You can't merge this");
    expect(queryTestId("pr-ready-meta")).toBeNull();
    expect(queryTestId("pr-ready-footer")).toBeNull();
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(queryTestId("pr-your-review")).toBeNull();
    await openPr(138);
    expect(byTestId("pr-header").dataset.state).toBe("merged");
    expect(queryTestId("pr-review-button")).toBeNull();
  });

  it("read access with the viewer's review requested: Review (primary) and every verdict, no merge controls", async () => {
    world.update(140, (d) => ({ ...d, reviewers: [...d.reviewers, { login: "alexwaumann", isTeam: false, isBot: false, avatarUrl: "", state: "", submittedAtMs: null, requested: true, stale: false }] }));
    renderPrPanel();
    await openPr(140);
    expect(byTestId("pr-ready-headline").textContent).toBe("Waiting on your review");
    expect(byTestId("pr-review-button").dataset.primary).toBe("true");
    expect(queryTestId("pr-merge-button")).toBeNull();
    expect(queryTestId("pr-auto-merge-button")).toBeNull();
    await openReview();
    // Not the author: GitHub takes every verdict from a read-access reviewer.
    for (const v of ["approve", "request-changes", "comment"]) expect(byTestId(`pr-review-dialog-${v}`).hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    expect(reviews()).toEqual([{ "repo-slug": SLUG, number: "140", verdict: "approve" }]);
  });

  it("the dialog shuts when the pull request stops taking reviews (merged meanwhile)", async () => {
    renderPrPanel();
    await openPr(142);
    await openReview("comment");
    fireEvent.change(reviewInput(), { target: { value: "Looks done." } });
    // Merged elsewhere: the next read shows it.
    world.update(142, (d) => ({ ...d, pullRequest: { ...d.pullRequest, state: "merged" } }));
    act(() => {
      pullRequestDetailResource.invalidate(pullRequestKey(SLUG, 142));
    });
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-header").dataset.state).toBe("merged");
    });
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(queryTestId("pr-review-dialog")).toBeNull();
    expect(reviews()).toEqual([]);
  });
});
