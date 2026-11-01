import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { HEAD_142, seedPrWorld, SLUG } = await import("@/test/prWorld");
const { openPr, pick, press, prTabs, renderPrPanel, resetPrStores, settle, texts, toastTexts, PR_PAGE } = await import("@/test/prPanelHarness");
const { seedWorld, CF } = await import("@/test/projectsWorld");
const { tooltipText } = await import("@/test/tooltip");
const { runCommandForResult } = await import("@/stores/commands");
const { closePanelTab, usePanelStore } = await import("@/stores/panel");
const { mergePullRequest } = await import("@/stores/prPanel");
const { useUiStore } = await import("@/stores/ui");
const { PREPARING_TOAST_DELAY_MS } = await import("@/stores/prThreads");

/**
 * The Pull request surface (components/pr) in the real side panel, against the mock's pull
 * requests (src/test/prWorld.ts): #145 open with failing checks, threads and reviewers; #138
 * merged; #131 closed; #140 read-only; #142 mergeable; #146 from a fork; #139 a teammate's.
 * e2e/pr-panel.spec.ts keeps what needs the browser: widths, overflow and popups inside the
 * panel, virtualized scrolling, chords through the keymap, and flows across routes (the
 * daemon's FocusThread selecting a new thread, the dashboard moving a merged row).
 */

let world: ReturnType<typeof seedPrWorld>;

beforeEach(() => {
  resetDaemon();
  world = seedPrWorld();
  resetPrStores();
});

afterEach(() => {
  act(() => {
    toast.dismiss();
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

async function expectToast(text: string | RegExp): Promise<void> {
  await vi.waitFor(() => {
    expect(toastTexts().some((t) => (typeof text === "string" ? t.includes(text) : text.test(t)))).toBe(true);
  });
}

function toastCount(text: string): number {
  return toastTexts().filter((t) => t.includes(text)).length;
}

/** Clicks a panel tab by its title. */
function selectPanelTab(title: string): void {
  fireEvent.click(within(byTestId("panel-tabs")).getByRole("tab", { name: title }));
}

/** Opens the ⋯ menu. */
function openMenu(): HTMLElement {
  press(byTestId("pr-menu-button"));
  return byTestId("pr-menu");
}

/** Which region holds focus ([data-region]). */
const focusedRegion = () => document.activeElement?.closest("[data-region]")?.getAttribute("data-region");

describe("Summary", () => {
  it("#145: header, reviewers, description, checks failed first, comments newest first with threads; links open through view.open.url", async () => {
    renderPrPanel();
    await openPr(145);
    expect(prTabs()).toEqual(["#145"]);
    expect(byTestId("pr-repo-link").textContent).toBe(`${SLUG}#145`);
    expect(byTestId("pr-title").textContent).toBe("fix(terminal): resize race between attach and first output");
    expect(byTestId("pr-author").textContent).toBe("alexwaumann");
    expect(byTestId("pr-updated").textContent).toBe("updated 5h ago");
    expect(byTestId("pr-branches").textContent).toMatch(/main\s*fix\/resize/);
    expect(byTestId("pr-diffstat").textContent).toContain("3 files");
    expect(byTestId("pr-diffstat").textContent).toContain("+1,450");
    expect(byTestId("pr-state").textContent).toBe("Draft");
    expect(byTestId("pr-checks-summary").textContent).toBe("2 failing");
    expect(byTestId("pr-checks-summary").dataset.tone).toBe("failure");

    const reviewers = screen.getAllByTestId("pr-reviewer");
    expect(reviewers).toHaveLength(4);
    expect(reviewers[0]?.dataset).toMatchObject({ login: "teammate-kim", status: "changes_requested", stale: "true" });
    expect(byTestId("pr-reviewers").textContent).toContain("and more on GitHub");

    // The description renders markdown: a heading and a task list.
    expect(within(byTestId("pr-description")).getByRole("heading", { name: "Test plan" })).toBeTruthy();
    expect(byTestId("pr-description").querySelectorAll('input[type="checkbox"]')).toHaveLength(2);

    // Every check, failed first, with its tone.
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

    // The header link opens the pull request on GitHub.
    fireEvent.click(byTestId("pr-repo-link"));
    await settle();
    expect(urlsOpened().at(-1)).toBe(`https://github.com/${SLUG}/pull/145`);
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
    expect(byTestId("pr-state").textContent).toBe("Closed");
    const menu = openMenu();
    expect(within(menu).getByTestId("pr-menu-open")).toBeTruthy();
    expect(within(menu).queryByTestId("pr-menu-revert")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.click(byTestId("pr-tab-timeline"));
    expect(screen.getAllByTestId("pr-timeline-entry")[0]?.dataset.kind).toBe("closed");

    await openPr(9999);
    expect(byTestId("pr-not-found").textContent).toContain("Pull request not found");
  });
});

describe("Timeline", () => {
  it("lists commits, reviews and the end state; the order toggles; a commit opens on GitHub; inner tabs stay per panel tab", async () => {
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-timeline"));
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

    // Another tab starts on Summary; coming back finds Timeline still selected.
    await openPr(138);
    expect(prTabs()).toEqual(["#145", "#138"]);
    expect(byTestId("pr-tab-summary").getAttribute("aria-selected")).toBe("true");
    // Merged: the timeline starts with the merge.
    fireEvent.click(byTestId("pr-tab-timeline"));
    expect(entries()[0]?.dataset.kind).toBe("merged");
    fireEvent.click(byTestId("pr-tab-summary"));
    selectPanelTab("#145");
    await settle();
    expect(byTestId("pr-tab-timeline").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("pr-timeline").dataset.order).toBe("oldest");
    expect((byTestId("pr-tab-code") as HTMLButtonElement).disabled).toBe(false);
  });

  it("closing a tab drops its inner state: reopened, it starts on Summary with the timeline newest first", async () => {
    renderPrPanel();
    await openPr(145);
    fireEvent.click(byTestId("pr-tab-timeline"));
    fireEvent.click(byTestId("pr-timeline-order"));
    expect(byTestId("pr-timeline").dataset.order).toBe("oldest");
    const key = Object.keys(usePanelStore.getState().byKey)[0] ?? "";
    const tab = usePanelStore.getState().byKey[key]?.groups[0]?.tabs[0];
    act(() => {
      closePanelTab(key, tab?.id ?? "");
    });
    expect(queryTestId("pr-surface")).toBeNull();
    await openPr(145);
    expect(byTestId("pr-tab-summary").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(byTestId("pr-tab-timeline"));
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
  it("Refresh (and a failed one), the thread actions, Open on GitHub, Copy link", async () => {
    renderPrPanel();
    await openPr(145);
    let menu = openMenu();
    const items = menuItems(menu);
    expect(items).toHaveLength(6);
    [/^Refresh/, /^Ask a question/, /^Explain this PR/, /^Fix findings in a thread/, /^Open on GitHub/, /^Copy link⇧⌘C$/].forEach((re, i) => {
      expect(items[i]).toMatch(re);
    });
    for (const id of ["pr-menu-ask", "pr-menu-explain", "pr-menu-fix"]) {
      expect(byTestId(id).hasAttribute("data-disabled")).toBe(false);
      expect(byTestId(id).hasAttribute("title")).toBe(false);
    }
    expect(byTestId("pr-menu-ask").textContent).toContain("Starts a thread that knows which pull request you mean.");
    expect(byTestId("pr-menu-explain").textContent).toContain("A walk through the diff and what to read closely.");
    // No revert for an open pull request.
    expect(queryTestId("pr-menu-revert")).toBeNull();
    expect(byTestId("pr-menu-refresh-hint").textContent).toMatch(/^Updated \d+s ago$/);

    // Refresh runs pr.refresh and stays open with the new time; quiet: no toast.
    await pick(byTestId("pr-menu-refresh"));
    await settle();
    expect(invocationsOf("pr.refresh").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
    expect(byTestId("pr-menu")).toBeTruthy();
    expect(byTestId("pr-menu-refresh-hint").textContent).toMatch(/^Updated [0-5]s ago$/);
    expect(toastTexts().filter((t) => t.startsWith("Refreshed #145"))).toEqual([]);
    // A failure is toasted and reported over the copy, which stays.
    world.failNext.add("pr.refresh");
    await pick(byTestId("pr-menu-refresh"));
    await expectToast("Refresh Pull Request failed");
    expect(byTestId("pr-refresh-error").textContent).toContain("502 Bad Gateway");
    expect(screen.getAllByTestId("pr-check")).toHaveLength(7);

    await pick(byTestId("pr-menu-copy"));
    expect(queryTestId("pr-menu")).toBeNull();
    expect(copyText).toHaveBeenCalledExactlyOnceWith(`https://github.com/${SLUG}/pull/145`);
    await expectToast("Link copied");

    menu = openMenu();
    await pick(within(menu).getByTestId("pr-menu-open"));
    expect(urlsOpened().at(-1)).toBe(`https://github.com/${SLUG}/pull/145`);
  });

  it("#138 (merged) offers Revert: it confirms, runs pr.revert and opens the new pull request as a tab", async () => {
    renderPrPanel();
    await openPr(138);
    expect(byTestId("pr-state").textContent).toBe("Merged");
    expect(byTestId("pr-checks-summary").textContent).toBe("All checks passed");
    openMenu();
    await pick(byTestId("pr-menu-revert"));
    expect(byTestId("confirm-dialog").textContent).toContain("This opens a new pull request that reverses the changes merged by #138.");
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    expect(invocationsOf("pr.revert").map((i) => [i.args.number, i.confirmed])).toEqual([
      ["138", false],
      ["138", true],
    ]);
    expect(prTabs()).toEqual(["#138", "#151"]);
    expect(byTestId("pr-title").textContent).toBe('Revert "chore(gh): pace requests through one worker"');
    await expectToast("Opened #151 to revert #138");
  });

  it("declining the revert's confirmation sends nothing", async () => {
    renderPrPanel();
    await openPr(138);
    openMenu();
    await pick(byTestId("pr-menu-revert"));
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
    await expectToast(/^Started thread s-new-\d+ for PR #145/);
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
    await expectToast(/^Started thread s-new-\d+ for PR #145/);
    await vi.waitFor(() => {
      expect(toastCount("Preparing worktree for #145…")).toBe(0);
    });
    expect(invocationsOf("pr.fix.findings").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([
      { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
      { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
    ]);
  });

  it("Ask a question from a thread: a composer under the header; Escape cancels into the panel; Enter sends pr.ask with the thread's worktree", async () => {
    seedWorld();
    resetPrStores({ kind: "thread", id: "s-1" });
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
    // Escape stays in the composer: the panel keeps its tab and has focus.
    expect(prTabs()).toEqual(["#145"]);
    expect(focusedRegion()).toBe("panel");

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
    await expectToast(/^Started thread s-new-\d+ for PR #145/);
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
    await expectToast(/^Started thread s-new-\d+ for PR #145/);
  });

  it("a pull request's running threads show on every surface that shows it (a thread's panel and the Pull Requests page)", async () => {
    seedWorld();
    resetPrStores({ kind: "thread", id: "s-1" });
    renderPrPanel();
    // Ask from thread s-1's panel.
    await openPr(145);
    const releaseAsk = world.hold("pr.ask");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    fireEvent.change(input("pr-ask-input"), { target: { value: "From s-1" } });
    fireEvent.keyDown(input("pr-ask-input"), { key: "Enter" });
    await settle();
    expect(byTestId("pr-ask-send").getAttribute("aria-busy")).toBe("true");

    // Meanwhile #145 on the Pull Requests page: its composer says so and sends nothing.
    act(() => {
      useUiStore.setState({ selection: PR_PAGE });
    });
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
    await expectToast(/^Started thread s-new-\d+ for PR #145/);
    await settle();
    // s-1's question starts its thread; this one was never sent.
    expect(invocationsOf("pr.ask").map((i) => ({ args: i.args, worktree: i.context.activeWorktreePath }))).toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "From s-1" }, worktree: CF }]);

    // Explain from the Pull Requests page; s-1's menu shows it running and disabled.
    const releaseExplain = world.hold("pr.explain");
    openMenu();
    await pick(byTestId("pr-menu-explain"));
    expect(byTestId("pr-menu-explain").getAttribute("aria-busy")).toBe("true");
    expect(byTestId("pr-menu-explain").getAttribute("aria-disabled")).toBe("true");
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
    });
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
      expect(toastTexts().filter((t) => /^Started thread s-new-\d+ for PR #145/.test(t))).toHaveLength(2);
    });
  });
});

describe("the merge button", () => {
  const button = () => byTestId("pr-merge-button");
  const merges = () => invocationsOf("pr.merge").map((i) => [i.args, i.confirmed]);

  it("#142 merges: Squash and merge confirms, runs pr.merge with squash, the head and the branch deleted; the state turns Merged", async () => {
    renderPrPanel();
    await openPr(142);
    expect(byTestId("pr-state").textContent).toBe("Open");
    expect(button().textContent).toBe("Merge");
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    press(button());
    const menu = byTestId("pr-merge-menu");
    const items = menuItems(menu);
    expect(items).toHaveLength(3);
    [/^Create a merge commit/, /^Squash and merge/, /^Rebase and merge/].forEach((re, i) => {
      expect(items[i]).toMatch(re);
    });
    expect(byTestId("pr-merge-delete-branch").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("pr-merge-delete-branch-note").textContent).toBe("Deletes origin/feat/sidebar; local branches and worktrees are untouched");

    await pick(byTestId("pr-merge-method-squash"));
    expect(byTestId("confirm-dialog").textContent).toContain(`Merge #142 “feat(gui): virtualized sidebar tree with thread rows” into main in ${SLUG} with squash? Branch origin/feat/sidebar is deleted afterwards.`);
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    // With the head the panel shows: the daemon refuses if GitHub's moved since.
    const args = { "repo-slug": SLUG, number: "142", method: "squash", "delete-branch": "true", "head-sha": HEAD_142 };
    expect(merges()).toEqual([
      [args, false],
      [args, true],
    ]);
    await vi.waitFor(() => {
      expect(byTestId("pr-state").textContent).toBe("Merged");
    });
    expect(queryTestId("pr-merge-button")).toBeNull();
    await expectToast("Merged #142 (e2e0142)");
    await expectToast("deleted origin/feat/sidebar");
  });

  it("draft, read-only and merged pull requests; unchecking the branch, declining, a spinner, a refusal", async () => {
    renderPrPanel();
    // #145 is a draft: disabled with the reason, and a press opens nothing.
    await openPr(145);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(tooltipText(button())).toBe("Draft pull requests cannot be merged");
    expect(document.getElementById(button().getAttribute("aria-describedby") ?? "")?.textContent).toBe("Draft pull requests cannot be merged");
    press(button());
    expect(queryTestId("pr-merge-menu")).toBeNull();
    // #138 is merged: no button.
    await openPr(138);
    expect(byTestId("pr-state").textContent).toBe("Merged");
    expect(queryTestId("pr-merge-button")).toBeNull();
    // #140: read access only.
    await openPr(140);
    expect(tooltipText(button())).toBe("Merging needs write access");

    // #142: keep the branch, then decline: nothing is sent.
    await openPr(142);
    press(button());
    fireEvent.click(byTestId("pr-merge-delete-branch"));
    expect(byTestId("pr-merge-delete-branch").getAttribute("aria-checked")).toBe("false");
    expect(byTestId("pr-merge-menu")).toBeTruthy();
    await pick(byTestId("pr-merge-method-merge"));
    expect(byTestId("confirm-dialog").textContent).toContain(`Merge #142 “feat(gui): virtualized sidebar tree with thread rows” into main in ${SLUG} with a merge commit?`);
    expect(byTestId("confirm-dialog").textContent).not.toContain("deleted afterwards");
    fireEvent.click(byTestId("confirm-cancel"));
    await settle();
    expect(queryTestId("confirm-dialog")).toBeNull();
    // Declined: the button is idle again and its menu does not come back by itself.
    expect(button().hasAttribute("aria-busy")).toBe(false);
    expect(queryTestId("pr-merge-menu")).toBeNull();
    expect(merges().filter(([, confirmed]) => confirmed)).toEqual([]);

    // GitHub refuses (the head moved): toasted, still open, the button usable again.
    world.failNext.add("pr.merge");
    const release = world.hold("pr.merge");
    press(button());
    expect(byTestId("pr-merge-delete-branch").getAttribute("aria-checked")).toBe("false");
    await pick(byTestId("pr-merge-method-rebase"));
    fireEvent.click(byTestId("confirm-ok"));
    await settle();
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().getAttribute("aria-disabled")).toBe("true");
    release();
    await expectToast("Merge Pull Request failed");
    await expectToast(/changed on GitHub since it was loaded/);
    await vi.waitFor(() => {
      expect(button().hasAttribute("aria-busy")).toBe(false);
    });
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    expect(byTestId("pr-state").textContent).toBe("Open");
    expect(merges().filter(([, confirmed]) => confirmed)).toEqual([[{ "repo-slug": SLUG, number: "142", method: "rebase", "delete-branch": "false", "head-sha": HEAD_142 }, true]]);
  });

  it("#146 from a fork: the branch cannot be deleted, and a merge asking anyway toasts that it was kept", async () => {
    renderPrPanel();
    await openPr(146);
    expect(byTestId("pr-state").textContent).toBe("Open");
    press(button());
    expect(byTestId("pr-merge-delete-branch").getAttribute("aria-checked")).toBe("false");
    expect(byTestId("pr-merge-delete-branch").getAttribute("data-disabled")).toBe("");
    expect(byTestId("pr-merge-delete-branch-note").textContent).toBe("The branch is in a fork");
    fireEvent.keyDown(byTestId("pr-merge-menu"), { key: "Escape" });
    expect(queryTestId("pr-merge-menu")).toBeNull();

    // pr.merge with delete-branch on (as the CLI can): the daemon's answer says it kept the branch.
    void mergePullRequest({ slug: SLUG, number: 146 }, "squash", true, "f04c146000000000000000000000000000000000");
    await settle();
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-state").textContent).toBe("Merged");
    });
    await expectToast("kept patch-1: it is in a fork");
  });
});

describe("Review ▾", () => {
  const reviews = () => invocationsOf("pr.review").map((i) => i.args);
  const reviewInput = () => input("pr-review-input");

  async function chooseVerdict(verdict: "approve" | "request-changes" | "comment"): Promise<void> {
    // The Review button, or the chip once the viewer has reviewed.
    press(queryTestId("pr-review-button") ?? byTestId("pr-your-review"));
    expect(byTestId("pr-review-menu")).toBeTruthy();
    await pick(byTestId(`pr-review-${verdict}`));
    expect(queryTestId("pr-review-menu")).toBeNull();
    expect(byTestId("pr-review-composer").dataset.verdict).toBe(verdict);
  }

  it("on #139: the menu, Approve with cmd+Enter runs pr.review; the header says You approved and Comments has the review", async () => {
    renderPrPanel();
    await openPr(139);
    expect(byTestId("pr-author").textContent).toBe("teammate-kim");
    expect(byTestId("pr-review-button").textContent).toBe("Review");
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "alexwaumann")?.dataset.status).toBe("requested");

    press(byTestId("pr-review-button"));
    const menu = byTestId("pr-review-menu");
    expect(menu.textContent).toContain("Review #139");
    expect(byTestId("pr-review-approve").textContent).toContain("Submit an approving review, with an optional note.");
    expect(byTestId("pr-review-request-changes").textContent).toContain("Block merging until your points are addressed.");
    expect(byTestId("pr-review-comment").textContent).toContain("General feedback without a verdict.");
    for (const v of ["approve", "request-changes", "comment"]) expect(byTestId(`pr-review-${v}`).hasAttribute("data-disabled")).toBe(false);

    await pick(byTestId("pr-review-approve"));
    expect(byTestId("pr-review-composer").dataset.verdict).toBe("approve");
    expect(byTestId("pr-review-label").textContent).toBe("Approve #139");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(reviewInput());
    });
    expect(reviewInput().placeholder).toBe("Say why, or leave it empty…");
    expect(byTestId("pr-review-hint").textContent).toBe("⌘⏎ submit · esc cancel");
    // An approval needs no text.
    expect((byTestId("pr-review-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(byTestId("pr-review-submit").textContent).toBe("Approve");
    // Enter is a newline; only cmd+Enter submits.
    fireEvent.change(reviewInput(), { target: { value: "Read it through." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter" });
    expect(reviews()).toEqual([]);
    fireEvent.change(reviewInput(), { target: { value: "Read it through.\nShip it." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(queryTestId("pr-review-composer")).toBeNull();
    });
    expect(reviews()).toEqual([{ "repo-slug": SLUG, number: "139", verdict: "approve", body: "Read it through.\nShip it." }]);
    await expectToast("Approved #139");
    expect(focusedRegion()).toBe("panel");

    // The refreshed detail: the chip in place of Review, the reviewer entry, the review in Comments.
    const chip = byTestId("pr-your-review");
    expect(chip.textContent).toBe("You approved");
    expect(chip.dataset.review).toBe("approved");
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(screen.getAllByTestId("pr-reviewer").find((r) => r.dataset.login === "alexwaumann")?.dataset.status).toBe("approved");
    const mine = screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("Ship it."));
    expect(mine).toHaveLength(1);
    expect(within(mine[0] as HTMLElement).getByTestId("pr-review-verdict").textContent).toBe("approved");

    // The chip still opens the menu: GitHub takes another review.
    press(chip);
    expect(byTestId("pr-review-menu")).toBeTruthy();
    fireEvent.keyDown(byTestId("pr-review-menu"), { key: "Escape" });
    expect(queryTestId("pr-review-menu")).toBeNull();
  });

  it("the composer: Request changes waits for text, verdicts switch keeping it, Escape cancels, one composer at a time", async () => {
    renderPrPanel();
    await openPr(139);
    await chooseVerdict("request-changes");
    expect(byTestId("pr-review-label").textContent).toBe("Request changes on #139");
    const submit = () => byTestId("pr-review-submit") as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe("Request changes");
    expect(byTestId("pr-review-hint").textContent).toBe("Say what should change");
    // Blank (spaces only) cannot be submitted, by key or button.
    fireEvent.change(reviewInput(), { target: { value: "   " } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    expect(byTestId("pr-review-composer")).toBeTruthy();
    expect(submit().disabled).toBe(true);
    fireEvent.change(reviewInput(), { target: { value: "Rename the flag." } });
    expect(byTestId("pr-review-hint").textContent).toBe("⌘⏎ submit · esc cancel");
    expect(submit().disabled).toBe(false);

    // Another verdict: same text, new label and button.
    await chooseVerdict("comment");
    expect(byTestId("pr-review-label").textContent).toBe("Comment on #139");
    expect(submit().textContent).toBe("Comment");
    expect(reviewInput().value).toBe("Rename the flag.");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(reviewInput());
    });
    fireEvent.change(reviewInput(), { target: { value: "" } });
    expect(byTestId("pr-review-hint").textContent).toBe("Write a comment");

    // Escape cancels and hands focus to the panel; nothing was sent.
    fireEvent.keyDown(reviewInput(), { key: "Escape" });
    expect(queryTestId("pr-review-composer")).toBeNull();
    expect(prTabs()).toEqual(["#139"]);
    expect(focusedRegion()).toBe("panel");
    expect(reviews()).toEqual([]);

    // Ask and Review share the slot: opening one closes the other.
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    expect(byTestId("pr-ask")).toBeTruthy();
    await chooseVerdict("approve");
    expect(queryTestId("pr-ask")).toBeNull();
    fireEvent.click(byTestId("pr-review-cancel"));
    expect(queryTestId("pr-review-composer")).toBeNull();
    await chooseVerdict("comment");
    openMenu();
    await pick(byTestId("pr-menu-ask"));
    expect(byTestId("pr-ask")).toBeTruthy();
    expect(queryTestId("pr-review-composer")).toBeNull();
  });

  it("a review GitHub did not confirm is toasted and keeps the text; the same answer again is toasted again; while it runs the field is read-only", async () => {
    renderPrPanel();
    await openPr(139);
    await chooseVerdict("request-changes");
    fireEvent.change(reviewInput(), { target: { value: "The retry loop never backs off." } });
    world.failNext.add("pr.review");
    const release = world.hold("pr.review");
    fireEvent.click(byTestId("pr-review-submit"));
    await settle();
    expect(byTestId("pr-review-submit").getAttribute("aria-busy")).toBe("true");
    expect(reviewInput().readOnly).toBe(true);
    expect(byTestId("pr-review-hint").textContent).toBe("Submitting…");
    expect((byTestId("pr-review-cancel") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("pr-review-button").getAttribute("aria-busy")).toBe("true");
    release();
    await expectToast("Review Pull Request failed");
    await expectToast(/GitHub did not confirm the review/);
    await vi.waitFor(() => {
      expect(byTestId("pr-review-submit").hasAttribute("aria-busy")).toBe(false);
    });
    expect(reviewInput().readOnly).toBe(false);
    expect(reviewInput().value).toBe("The retry loop never backs off.");
    expect(byTestId("pr-review-button").textContent).toBe("Review");

    // The daemon answers the same text the same way (Go-tested): toasted again, the composer stays.
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await vi.waitFor(() => {
      expect(toastCount("Review Pull Request failed")).toBe(2);
    });
    expect(byTestId("pr-review-composer")).toBeTruthy();
    expect(byTestId("pr-review-button").textContent).toBe("Review");
    // Other text posts.
    fireEvent.change(reviewInput(), { target: { value: "The retry loop never backs off; add a jittered delay." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(queryTestId("pr-review-composer")).toBeNull();
    });
    expect(byTestId("pr-your-review").textContent).toBe("You requested changes");
    expect(byTestId("pr-your-review").dataset.review).toBe("changes_requested");
    expect(screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("jittered delay"))).toHaveLength(1);
    expect(reviews().map((a) => a.body)).toEqual(["The retry loop never backs off.", "The retry loop never backs off.", "The retry loop never backs off; add a jittered delay."]);
  });

  it("#145 (the viewer's own): Approve and Request changes are disabled with the reason; Comment posts a review; #140 and #138 have no Review", async () => {
    renderPrPanel();
    await openPr(145);
    expect(byTestId("pr-author").textContent).toBe("alexwaumann");
    press(byTestId("pr-review-button"));
    expect(byTestId("pr-review-approve").getAttribute("data-disabled")).toBe("");
    expect(byTestId("pr-review-request-changes").getAttribute("data-disabled")).toBe("");
    expect(byTestId("pr-review-comment").hasAttribute("data-disabled")).toBe(false);
    expect(await hoverTip(byTestId("pr-review-approve-reason"))).toBe("You cannot approve your own pull request.");
    expect(await hoverTip(byTestId("pr-review-request-changes-reason"))).toBe("Not on your own pull request.");
    // A disabled item opens nothing.
    await pick(byTestId("pr-review-approve"));
    expect(queryTestId("pr-review-composer")).toBeNull();
    await pick(byTestId("pr-review-comment"));
    expect(byTestId("pr-review-composer").dataset.verdict).toBe("comment");
    fireEvent.change(reviewInput(), { target: { value: "Rebased on main." } });
    fireEvent.keyDown(reviewInput(), { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(queryTestId("pr-review-composer")).toBeNull();
    });
    expect(byTestId("pr-your-review").textContent).toBe("You commented");
    expect(screen.getAllByTestId("pr-comment").filter((c) => c.textContent.includes("Rebased on main."))).toHaveLength(1);
    expect(reviews()).toEqual([{ "repo-slug": SLUG, number: "145", verdict: "comment", body: "Rebased on main." }]);

    // GitHub's refusal from the palette or CLI (the menu never sends it) comes back as its message.
    await act(async () => {
      await runCommandForResult("pr.review", { "repo-slug": SLUG, number: "145", verdict: "approve" });
    });
    await expectToast("Review Can not approve your own pull request");

    // Read access only: no Review. Merged: none either.
    await openPr(140);
    expect(byTestId("pr-author").textContent).toBe("outside-contrib");
    expect(byTestId("pr-merge-button")).toBeTruthy();
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(queryTestId("pr-your-review")).toBeNull();
    await openPr(138);
    expect(byTestId("pr-state").textContent).toBe("Merged");
    expect(queryTestId("pr-review-button")).toBeNull();
  });

  it("the composer closes when the pull request stops taking reviews (merged meanwhile)", async () => {
    renderPrPanel();
    await openPr(142);
    await chooseVerdict("comment");
    fireEvent.change(reviewInput(), { target: { value: "Looks done." } });
    press(byTestId("pr-merge-button"));
    await pick(byTestId("pr-merge-method-squash"));
    fireEvent.click(byTestId("confirm-ok"));
    await settle(3);
    await vi.waitFor(() => {
      expect(byTestId("pr-state").textContent).toBe("Merged");
    });
    expect(queryTestId("pr-review-button")).toBeNull();
    expect(queryTestId("pr-review-composer")).toBeNull();
    expect(reviews()).toEqual([]);
  });
});

/** A hover tooltip's text: Radix opens it on pointer move after the provider's delay. */
async function hoverTip(el: HTMLElement): Promise<string | null> {
  fireEvent.pointerMove(el, { pointerType: "mouse" });
  let text: string | null = null;
  await vi.waitFor(() => {
    text = screen.queryByRole("tooltip")?.textContent ?? null;
    expect(text).not.toBeNull();
  });
  fireEvent.pointerLeave(el, { pointerType: "mouse" });
  return text;
}
