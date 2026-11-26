import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiffView } from "@/api/prDiff";
import { dropToasterTimers } from "@/test/toaster";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
const getPullRequestDiff = vi.hoisted(() => vi.fn());
vi.mock("@/api/prDiff", async (orig) => ({ ...(await orig<typeof import("@/api/prDiff")>()), getPullRequestDiff }));
// The diff renderer needs a real browser (shadow roots, layout): e2e/pr-diff-tab.spec.ts draws it.
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => <div data-testid="file-diff-stub" data-name={fileDiff.name} />,
  MultiFileDiff: () => null,
  PatchDiff: () => null,
  CodeView: () => null,
  Virtualizer: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
// The tab's width decides the file list column (jsdom lays nothing out).
const width = vi.hoisted(() => ({ px: 900 }));
vi.mock("@/lib/useWidth", () => ({
  useWidth: () => [useRef(null), width.px],
  useHeight: () => 700,
}));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { seedPrWorld, SLUG } = await import("@/test/prWorld");
const { renderPrPanel, resetPrStores, settle } = await import("@/test/prPanelHarness");
const { layoutSettled } = await import("@/test/fakeLayout");
const { applyGhEvent } = await import("@/stores/gh");
const { pullRequestDiffResource } = await import("@/stores/prDiff");
const { openPullRequestDiff } = await import("@/stores/prDiffPanel");
const { tabPlace } = await import("@/shell/host");

/**
 * A pull request's diff tab (PrDiffView): the bar, the list as a column or as the files menu, the
 * file shown kept in the tab, when the diff is read again, and every state before there is a diff.
 * The code itself (the library) is e2e/pr-diff-tab.spec.ts's.
 */

const DIFF = `diff --git a/docs/notes/greeting.md b/docs/notes/welcome-greeting.md
similarity index 86%
rename from docs/notes/greeting.md
rename to docs/notes/welcome-greeting.md
index 9b3fdc6..c849c77 100644
--- a/docs/notes/greeting.md
+++ b/docs/notes/welcome-greeting.md
@@ -1,3 +1,3 @@
 # Greeting
-Hello.
+Hello there.
 Bye.
diff --git a/gui/frontend/public/logo.png b/gui/frontend/public/logo.png
new file mode 100644
index 0000000..1d2c3b4
Binary files /dev/null and b/gui/frontend/public/logo.png differ
diff --git a/gui/frontend/src/lib/greeting.ts b/gui/frontend/src/lib/greeting.ts
index 1111111..2222222 100644
--- a/gui/frontend/src/lib/greeting.ts
+++ b/gui/frontend/src/lib/greeting.ts
@@ -1,4 +1,4 @@
-export const hi = "hi";
+export const hi = "hello";
 export function greet(name: string): string {
-  return hi + name;
+  return \`\${hi} \${name}\`;
 }
`;

let world: ReturnType<typeof seedPrWorld>;
let answer: (number: number, headSha: string, signal?: AbortSignal) => Promise<PullRequestDiffView>;

const diffFor = (headSha: string, diff = DIFF, truncated = false): PullRequestDiffView => ({ diff, headSha, truncated, fetchedAtMs: Date.now() });

dropToasterTimers(); // before the file's hooks: the Toaster mounts on fake timers

beforeEach(async () => {
  resetDaemon();
  world = seedPrWorld();
  await resetPrStores();
  pullRequestDiffResource.store.setState({ entries: {} });
  width.px = 900;
  answer = (_n, head) => Promise.resolve(diffFor(head));
  getPullRequestDiff.mockImplementation((slug: string, number: number, _refresh: boolean, _opts: unknown, signal?: AbortSignal) => answer(number, world.detail(number, slug)?.pullRequest.headSha ?? "", signal));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openDiff(number = 145): Promise<void> {
  renderPrPanel();
  await act(async () => {
    openPullRequestDiff({ slug: SLUG, number });
    await layoutSettled();
  });
  await settle(3);
}

const diffTab = () => tabPlace("current").tabs.find((t) => t.kind === "prdiff");
const rows = () => within(screen.getByTestId("diff-file-rows")).getAllByRole("option");
const diffReads = (refresh: boolean) => getPullRequestDiff.mock.calls.filter((c) => c[2] === refresh).length;

describe("a pull request's diff tab", () => {
  it("names its sides, counts the files, lists them in a column and shows the first, which the tab keeps", async () => {
    await openDiff();
    const pr = world.detail(145)?.pullRequest;
    expect(screen.getByTestId("pr-diff-refs").textContent).toBe(`${pr?.baseRef ?? ""} ← ${pr?.headRef ?? ""}`);
    expect(screen.getByTestId("pr-diff-totals").textContent).toBe("3 files+3−3");
    expect(screen.getByTestId("pr-diff").getAttribute("data-layout")).toBe("rail");
    expect(rows().map((r) => r.querySelector("[data-status]")?.textContent)).toEqual(["R", "A", "M"]);
    // The column's head has no counts of its own: the bar shows them.
    expect(screen.getByTestId("diff-totals").textContent).toBe("1 of 3");
    expect(screen.getByTestId("pr-diff-file").getAttribute("data-path")).toBe("docs/notes/welcome-greeting.md");
    expect(screen.getByTestId("file-diff-stub").getAttribute("data-name")).toBe("docs/notes/welcome-greeting.md");
    expect(diffTab()?.params.path).toBe("docs/notes/welcome-greeting.md");
    expect(diffTab()?.title).toBe("Diff #145");
  });

  it("the bar's Review is the pull request's: small, at the right end, opening the same review dialog, whose submit reviews that pull request", async () => {
    await openDiff(139);
    const slot = screen.getByTestId("pr-diff-review-slot");
    const button = within(slot).getByTestId("pr-review-button");
    expect(button.dataset.size).toBe("sm");
    // #139 asks for the viewer's review, as the header's Review says.
    expect(button.dataset.primary).toBe("true");
    fireEvent.click(button);
    await settle();
    expect(screen.getByTestId("pr-review-dialog-title").textContent).toBe("Review");
    expect(screen.getByTestId("pr-review-dialog-repo").textContent).toBe(`${SLUG} #139`);
    expect(screen.getByTestId("pr-review-dialog").dataset.verdict).toBe("approve");
    const input = screen.getByTestId("pr-review-dialog-input");
    fireEvent.change(input, { target: { value: "Read the diff." } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await settle(3);
    await vi.waitFor(() => {
      expect(within(screen.getByTestId("pr-diff-review-slot")).getByTestId("pr-your-review").textContent).toBe("You approved");
    });
    expect(invocationsOf("pr.review").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "139", verdict: "approve", body: "Read the diff." }]);
  });

  it("a file picked in the column shows and is the tab's; a binary says so; Next steps on", async () => {
    await openDiff();
    fireEvent.click(rows()[1] as HTMLElement);
    await settle();
    expect(diffTab()?.params.path).toBe("gui/frontend/public/logo.png");
    expect(screen.getByTestId("pr-diff-binary").textContent).toContain("Added");
    fireEvent.click(screen.getByTestId("diff-next"));
    await settle();
    expect(screen.getByTestId("pr-diff-file").getAttribute("data-path")).toBe("gui/frontend/src/lib/greeting.ts");
    expect(screen.getByTestId("file-diff-stub").getAttribute("data-name")).toBe("gui/frontend/src/lib/greeting.ts");
  });

  it("narrower than the column needs, the files control is the list; picking closes it", async () => {
    width.px = 600;
    await openDiff();
    expect(screen.getByTestId("pr-diff").getAttribute("data-layout")).toBe("menu");
    expect(screen.queryByTestId("diff-list-column")).toBeNull();
    fireEvent.click(screen.getByTestId("pr-diff-files"));
    await settle();
    const menu = screen.getByTestId("pr-diff-files-menu");
    expect(within(menu).getAllByRole("option")).toHaveLength(3);
    fireEvent.click(within(menu).getAllByRole("option")[2] as HTMLElement);
    await settle();
    expect(screen.queryByTestId("pr-diff-files-menu")).toBeNull();
    expect(diffTab()?.params.path).toBe("gui/frontend/src/lib/greeting.ts");
  });

  it("a file no longer in the diff stays, saying so", async () => {
    await openDiff();
    const id = diffTab()?.id ?? "";
    const { setTabParams } = await import("@/shell/host");
    await act(async () => {
      setTabParams("current", id, (p) => ({ ...p, path: "gone.ts" }));
      await layoutSettled();
    });
    await settle();
    expect(screen.getByTestId("pr-diff-unlisted").textContent).toContain("gone.ts is no longer in this pull request's diff");
    expect(screen.getByTestId("diff-totals").textContent).toBe("");
  });

  it("reads the diff again when the head moves, once, and from GitHub on Refresh", async () => {
    world.update(145, (d) => ({ ...d, pullRequest: { ...d.pullRequest, headSha: "a".repeat(40) } }));
    await openDiff();
    const reads = diffReads(false);
    world.update(145, (d) => ({ ...d, pullRequest: { ...d.pullRequest, headSha: "c0de".padEnd(40, "0") } }));
    act(() => {
      applyGhEvent({ kind: "pullRequestDetail", repoSlug: SLUG, number: 145 });
    });
    await settle(3);
    expect(diffReads(false)).toBe(reads + 1);
    fireEvent.click(screen.getByTestId("pr-diff-refresh"));
    await settle();
    expect(diffReads(true)).toBe(1);
    expect(rows()).toHaveLength(3);
  });

  it("a refresh that fails keeps the diff and says so", async () => {
    await openDiff();
    answer = () => Promise.reject(new Error("rate limited"));
    fireEvent.click(screen.getByTestId("pr-diff-refresh"));
    await settle(3);
    expect(screen.getByTestId("pr-diff-refresh-error").textContent).toContain("Could not refresh: rate limited");
    expect(rows()).toHaveLength(3);
  });
});

describe("before there is a diff to show", () => {
  it("loading: the sides, no files control", async () => {
    // Never answers, but lets go when the tab does: a read left in flight would hold the next test's.
    answer = (_n, _head, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await openDiff();
    expect(screen.getByTestId("file-loading")).toBeTruthy();
    expect(screen.getByTestId("pr-diff-refs").textContent).toContain("←");
    expect(screen.queryByTestId("pr-diff-files")).toBeNull();
  });

  it("GitHub refusing it as too large: its message and the way to GitHub", async () => {
    answer = () => Promise.reject(new Error("too large: Sorry, the diff exceeded the maximum number of files (300)."));
    await openDiff(140);
    expect(screen.getByTestId("pr-diff-too-large").textContent).toContain("exceeded the maximum number of files");
    fireEvent.click(screen.getByTestId("pr-diff-too-large-open"));
    await settle();
    expect(invocationsOf("view.open.url").at(-1)?.args.url).toBe(`https://github.com/${SLUG}/pull/140/files`);
  });

  it("a failed read says why, and Retry reads again", async () => {
    answer = () => Promise.reject(new Error("network down"));
    await openDiff();
    expect(screen.getByTestId("pr-diff-error").textContent).toContain("network down");
    answer = (_n, head) => Promise.resolve(diffFor(head));
    fireEvent.click(screen.getByTestId("pr-diff-retry"));
    await settle(3);
    expect(rows()).toHaveLength(3);
  });

  it("no files: No changes", async () => {
    answer = (_n, head) => Promise.resolve(diffFor(head, ""));
    await openDiff();
    expect(screen.getByTestId("pr-diff-empty")).toBeTruthy();
    expect(screen.queryByTestId("pr-diff-files")).toBeNull();
  });

  it("cut at 4 MiB: the files it has, and the way to the rest", async () => {
    answer = (_n, head) => Promise.resolve(diffFor(head, DIFF, true));
    await openDiff();
    expect(screen.getByTestId("pr-diff-truncated").textContent).toContain("showing its first 3 files");
    fireEvent.click(screen.getByTestId("pr-diff-truncated-open"));
    await settle();
    expect(invocationsOf("view.open.url").at(-1)?.args.url).toBe(`https://github.com/${SLUG}/pull/145/files`);
  });
});
