import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiffView } from "@/api/prDiff";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
const getPullRequestDiff = vi.hoisted(() => vi.fn());
vi.mock("@/api/prDiff", async (orig) => ({ ...(await orig<typeof import("@/api/prDiff")>()), getPullRequestDiff }));
// The diff renderer needs a real browser (shadow roots, layout): e2e/pr-code.spec.ts covers it.
vi.mock("@pierre/diffs/react", () => ({ CodeView: () => <div data-testid="code-view-stub" /> }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { seedPrWorld, SLUG } = await import("@/test/prWorld");
const { openPr, renderPrPanel, resetPrStores, settle } = await import("@/test/prPanelHarness");
const { applyGhEvent } = await import("@/stores/gh");
const { pullRequestDiffResource } = await import("@/stores/prDiff");

/**
 * The Code tab (PrCode) in the side panel: the file list's fold, when the diff is read again
 * (the head moved, the refresh button), and GitHub's too-large refusal. The diff itself (the
 * library's CodeView) is e2e/pr-code.spec.ts's.
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

function diffFor(headSha: string): PullRequestDiffView {
  return { diff: DIFF, headSha, baseSha: "b".repeat(40), truncated: false, fetchedAtMs: Date.now() };
}

beforeEach(() => {
  resetDaemon();
  world = seedPrWorld();
  resetPrStores();
  pullRequestDiffResource.store.setState({ entries: {} });
  getPullRequestDiff.mockImplementation((slug: string, number: number) => {
    if (number === 140) return Promise.reject(new Error("too large: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead."));
    return Promise.resolve(diffFor(world.detail(number, slug)?.pullRequest.headSha ?? ""));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openCode(number: number): Promise<void> {
  renderPrPanel();
  await openPr(number);
  fireEvent.click(screen.getByTestId("pr-tab-code"));
  await settle();
}

const diffReads = (refresh: boolean) => getPullRequestDiff.mock.calls.filter((c) => c[2] === refresh).length;

describe("the Code tab", () => {
  it("lists the files; the list folds; the diff is read again when the head moves and on refresh", async () => {
    world.update(145, (d) => ({ ...d, pullRequest: { ...d.pullRequest, headSha: "a".repeat(40) } }));
    await openCode(145);
    expect(screen.getByTestId("pr-code-totals").textContent).toBe("3 files · +3 −3");
    expect(screen.getAllByTestId("pr-code-file").map((r) => r.querySelector("[data-status]")?.textContent)).toEqual(["R", "A", "M"]);
    fireEvent.click(screen.getByTestId("pr-code-files-toggle"));
    expect(screen.queryByTestId("pr-code-files")).toBeNull();
    fireEvent.click(screen.getByTestId("pr-code-files-toggle"));
    expect(screen.getAllByTestId("pr-code-file")).toHaveLength(3);

    // A push the poll saw: the detail is announced, read again with the new head, and the diff follows once.
    const reads = diffReads(false);
    world.update(145, (d) => ({ ...d, pullRequest: { ...d.pullRequest, headSha: "c0de".padEnd(40, "0") } }));
    act(() => {
      applyGhEvent({ kind: "pullRequestDetail", repoSlug: SLUG, number: 145 });
    });
    await settle(3);
    expect(diffReads(false)).toBe(reads + 1);
    expect(getPullRequestDiff).toHaveBeenLastCalledWith(SLUG.toLowerCase(), 145, false, undefined, expect.anything());

    // The refresh button fetches from GitHub.
    fireEvent.click(screen.getByTestId("pr-code-refresh"));
    await settle();
    expect(diffReads(true)).toBe(1);
    expect(screen.getAllByTestId("pr-code-file")).toHaveLength(3);
  });

  it("a diff GitHub refuses as too large shows its message and the way to GitHub", async () => {
    await openCode(140);
    const notice = screen.getByTestId("pr-code-too-large");
    expect(notice.textContent).toContain("exceeded the maximum number of files");
    expect(screen.queryByTestId("pr-code-diff")).toBeNull();
    fireEvent.click(screen.getByTestId("pr-code-too-large-open"));
    await settle();
    expect(invocationsOf("view.open.url").at(-1)?.args.url).toBe(`https://github.com/${SLUG}/pull/140/files`);
  });
});
