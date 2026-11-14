import { expect, test, type Page } from "@playwright/test";
import { appPath, mockUrl, resetMock, threadPrompt } from "./fixtures";
import { openShellApp, paneNode, paneOf, rowNode, seedLayout, threadTab } from "./shell";
import { diffTab, keyboardPane, stripTabs } from "./shell-surfaces";

/**
 * The owner's keys and sidebar changes (docs/notes/shell-25c-keys-drafts.md), what only a browser
 * shows: cmd+shift+t through the keymap brings back the tab cmd+w closed with the keyboard in it,
 * from the pane or a thread's prompt; cmd+t where no thread is focused opens a free terminal with
 * the keyboard in it. Where a reopened tab goes is Go's (internal/layout testdata/ops
 * reopen_closed-*), which sections a thread is in vitest's (lib/shellSections.test.ts).
 * SHOTS=<dir> for the PR's screenshots of the sidebar (WebKit, dark and light); they run on the
 * tree before the change as well, for the "before".
 */

const prs = { id: "t-prs", kind: "prs", title: "Pull Requests" };

test.beforeEach(async () => {
  await resetMock();
});

test("cmd+shift+t brings back the tab cmd+w closed, where it was, with the keyboard in it", async ({ page }) => {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [diffTab("s-1"), prs], "t-prs")]), "p-2");
  await openShellApp(page);
  await paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="prs"] [role="tab"]').click();
  await expect(paneOf(page, "p-2")).toHaveAttribute("data-focused", "true");
  await expect.poll(() => keyboardPane(page)).toBe("p-2");

  await page.keyboard.press("Meta+w");
  await expect(stripTabs(paneOf(page, "p-2"))).toHaveCount(1);
  await page.keyboard.press("Meta+Shift+t");
  await expect(stripTabs(paneOf(page, "p-2"))).toHaveCount(2);
  await expect(paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="prs"][data-active]')).toHaveCount(1);
  await expect(paneOf(page, "p-2")).toHaveAttribute("data-focused", "true");
  await expect.poll(() => keyboardPane(page)).toBe("p-2");

  // From a thread's prompt too: the chord is the window's, not the text's.
  await paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="prs"] [role="tab"]').click();
  await page.keyboard.press("Meta+w");
  await expect(stripTabs(paneOf(page, "p-2"))).toHaveCount(1);
  await threadPrompt(page).click();
  await page.keyboard.press("Meta+Shift+t");
  await expect(stripTabs(paneOf(page, "p-2"))).toHaveCount(2);
  await expect.poll(() => keyboardPane(page)).toBe("p-2");
});

test("cmd+t on a tab of no thread opens a free terminal, the keyboard in it", async ({ page }) => {
  await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1")]), paneNode("p-2", [prs])]), "p-2");
  await openShellApp(page);
  await paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="prs"] [role="tab"]').click();
  await expect.poll(() => keyboardPane(page)).toBe("p-2");
  await page.keyboard.press("Meta+t");
  const term = paneOf(page, "p-2").locator('[data-testid="shell-tab"][data-kind="terminal"]');
  await expect(term).toHaveCount(1);
  // Linked to no thread: no row under the strip names one.
  await expect(paneOf(page, "p-2").getByTestId("shell-terminal-host")).toBeVisible();
  await expect(paneOf(page, "p-2").getByTestId("shell-linked-row")).toHaveCount(0);
  await expect.poll(() => keyboardPane(page)).toBe("p-2");
});

/** Sets threads' status in the window's store, as their events would (the mock's own are fixed). */
async function setStatuses(page: Page, statuses: Record<string, string>): Promise<void> {
  await page.evaluate(
    (all) =>
      (window as unknown as { __cfModule: (p: string) => Promise<{ useThreadsStore: { getState: () => { byId: Record<string, object> }; setState: (s: object) => void } }> })
        .__cfModule("/src/stores/threads.ts")
        .then((m) => {
          const s = m.useThreadsStore.getState();
          const byId = { ...s.byId };
          let at = Date.now();
          for (const [id, reason] of Object.entries(all)) {
            at -= 60_000;
            byId[id] = { ...byId[id], state: "connected", snoozedUntilMs: null, archivedAtMs: null, status: "attention", statusReason: reason, statusChangedAtMs: at };
          }
          m.useThreadsStore.setState({ byId });
        }),
    statuses,
  );
}

/** SHOTS=<dir>: Needs you and Active with every kind of call, and the draft rows; dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`keys and drafts screenshots (${scheme})`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const at = (name: string) => `${shots ?? ""}/${name}${scheme === "light" ? "-light" : ""}.png`;
    await page.emulateMedia({ colorScheme: scheme });
    const state = {
      v: 1,
      spaces: [
        {
          id: "sp-main",
          name: "Main",
          root: { t: "pane", id: "p-1", tabs: [threadTab("s-1"), { id: "t-c", kind: "compose", params: { draft: "d-notes", project: "repo-cf" } }], active: "t-s-1" },
          focus: "p-1",
          mru: ["t-s-1"],
          drafts: [
            { id: "d-notes", label: "Write up the shell's sidebar for the release notes", params: { project: "repo-cf" } },
            { id: "d-empty", label: "", params: {} },
          ],
        },
      ],
      current_space: "sp-main",
      default_space: "sp-main",
    };
    const res = await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) });
    expect(res.ok).toBe(true);
    await page.setViewportSize({ width: 1400, height: 960 });
    await page.goto(`${appPath}&shell=1`);
    await expect(page.getByTestId("shell-grid")).toBeVisible();
    // An actionable ask of each kind (s-2's permission is the mock's own), and each call that does not block.
    await setStatuses(page, {
      "s-1": "question: Which charting library?",
      "s-3": "plan: Ready to code?",
      "s-4": "notification: Build finished",
      "s-8": "snooze ended",
      "s-5": "error: overloaded_error",
      "s-6": "bell",
    });
    await page.mouse.move(5, 5);
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
    );
    await page.screenshot({ path: at("keys-drafts-sidebar"), clip: { x: 0, y: 0, width: 420, height: 960 } });
  });
}
