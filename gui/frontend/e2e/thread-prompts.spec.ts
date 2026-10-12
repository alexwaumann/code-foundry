import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Answering a rendered thread (rendered threads PR 3, docs/notes/rendered-threads-3-interaction.md):
 * the docked permission and question prompts over the mock's scripted thread
 * (mock/thread.ts), their keyboard, the Escape interrupt and effort changes. Set SHOTS=<dir>
 * to save screenshots of the panels in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

type State = "permission" | "question" | "streaming" | "idle" | "parallel" | "multi";

async function openThread(page: Page, state: State, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

async function responds(): Promise<string[]> {
  return (await calls()).filter((c) => c.startsWith("respond"));
}

/** A crop of the composer card (where the prompts dock). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (!dir) return;
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${dir}/${name}.png` });
  await page.getByTestId("thread-composer").screenshot({ path: `${dir}/${name}-card.png` });
}

const composer = (page: Page) => page.getByTestId("thread-composer");
const editor = (page: Page) => composer(page).locator('[contenteditable="true"]');
const lastText = (page: Page) => page.getByTestId("thread-pane").locator('[data-testid="thread-text"]').last();

async function editorFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable);
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(scheme, () => {
    test("the permission panel and deny with a reason", async ({ page }) => {
      await openThread(page, "permission", scheme);
      const prompt = composer(page).getByTestId("thread-permission");
      await expect(prompt).toContainText("Allow Claude to run this command?");
      // The mode hint (the thread runs accept-edits) and the CLI's own reason.
      await expect(prompt.getByTestId("thread-permission-hint")).toHaveText("Accept edits asks before commands");
      await expect(prompt.getByTestId("thread-permission-why")).toHaveText("Accept edits asks before commands");
      await expect(prompt.locator("kbd")).toHaveText(["1", "2", "3"]);
      await shot(page, `permission-${scheme}`);

      await prompt.getByTestId("thread-permission-deny").click();
      const reason = prompt.getByTestId("thread-deny-reason");
      await expect(reason).toBeFocused();
      await reason.fill("Use the staging branch instead");
      await shot(page, `deny-reason-${scheme}`);
      await page.keyboard.press("Enter");
      await expect.poll(responds).toEqual(["respond s-r1 deny req-push message=Use the staging branch instead"]);
      await expect(composer(page).getByTestId("thread-permission")).toHaveCount(0);
      await expect(lastText(page)).toContainText("You said: Use the staging branch instead");
      await expect(page.getByTestId("thread-pane").locator('[data-tool="Bash"]').last()).toContainText("denied");
    });

    test("the question panel: single-select with Other, then a multi-select", async ({ page }) => {
      await openThread(page, "question", scheme);
      const q = composer(page).getByTestId("thread-question");
      await q.getByRole("radio").nth(0).click();
      await shot(page, `question-${scheme}`);
      await q.getByTestId("thread-question-next").click();
      await expect(q).toContainText("2 of 2");
      await q.getByLabel("Other answer").fill("Only the title");
      await expect(q.getByTestId("thread-question-other")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Enter");
      await expect.poll(responds).toHaveLength(1);
      const sent = (await invocations()).find((i) => i.name === "thread.respond");
      expect(sent?.args).toMatchObject({ id: "s-r1", decision: "allow", request: "req-push-q" });
      expect(JSON.parse(sent?.args.answer ?? "{}")).toEqual({
        "The branch was rebased onto main, so a plain push will be rejected. How should I push?": "Force with lease (Recommended)",
        "Should I also update the PR description?": "Only the title",
      });
      await expect(lastText(page)).toContainText("Thanks: Force with lease (Recommended); Only the title.");

      await openThread(page, "multi", scheme);
      const m = composer(page).getByTestId("thread-question");
      await expect(m.getByRole("checkbox")).toHaveCount(4);
      await m.getByRole("checkbox").nth(0).click();
      await m.getByRole("checkbox").nth(2).click();
      await expect(m.getByRole("checkbox").nth(0)).toHaveAttribute("aria-checked", "true");
      await shot(page, `question-multi-${scheme}`);
      await m.getByTestId("thread-question-next").click();
      await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.respond").length).toBe(2);
      const multi = (await invocations()).filter((i) => i.name === "thread.respond")[1];
      expect(JSON.parse(multi?.args.answer ?? "{}")).toEqual({ "Which checks should I run before pushing?": "go test ./..., staticcheck" });
    });
  });
}

test("Allow answers at once; the sidebar and the bell stop asking", async ({ page }) => {
  await openThread(page, "permission");
  await expect(row(page, "s:s-r1")).toContainText("Needs input · Bash git push");
  // s-2 (a terminal thread) and the rendered thread need the user.
  await expect(page.getByTestId("attention-badge")).toHaveText("2");
  await composer(page).getByTestId("thread-permission-allow").click();
  await expect(composer(page).getByTestId("thread-permission")).toHaveCount(0);
  await expect.poll(responds).toEqual(["respond s-r1 allow req-push"]);
  await expect(page.getByTestId("attention-badge")).toHaveText("1");
  await expect(row(page, "s:s-r1")).not.toContainText("Needs input");
  await expect(lastText(page)).toContainText("Pushed. PR #63 now has the fix.");
  await expect(page.getByTestId("thread-pane").locator('[data-tool="Bash"]').last()).toContainText("Ran git push");
  await expect(page.getByTestId("thread-footer").last()).toBeVisible();
});

test("keyboard: an empty editor's digits answer, a typed message keeps them, Escape hands focus back", async ({ page }) => {
  await openThread(page, "permission");
  await editor(page).click();
  await page.keyboard.type("x1");
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "x1");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect(await responds()).toEqual([]);

  // The prompt focused: Escape returns to the editor.
  await composer(page).getByTestId("thread-permission").focus();
  await page.keyboard.press("Escape");
  expect(await editorFocused(page)).toBe(true);

  // 3 opens the reason; Escape cancels it and nothing is sent.
  await page.keyboard.press("3");
  await expect(composer(page).getByTestId("thread-deny-reason")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer(page).getByTestId("thread-deny-reason")).toHaveCount(0);
  await expect(composer(page).getByTestId("thread-permission")).toBeFocused();
  expect(await responds()).toEqual([]);

  // 2 from the (empty) editor: allow for the session.
  await editor(page).click();
  await page.keyboard.press("2");
  await expect.poll(responds).toEqual(["respond s-r1 allow-session req-push"]);
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "");
  expect(await editorFocused(page)).toBe(true);
});

test("a failed answer brings the prompt back", async ({ page }) => {
  await openThread(page, "permission");
  await mockPost("thread/fail-respond");
  await composer(page).getByTestId("thread-permission-allow").click();
  await expect(page.getByText("Answer Thread Request failed")).toBeVisible();
  await expect(composer(page).getByTestId("thread-permission")).toBeVisible();
  await composer(page).getByTestId("thread-permission-allow").click();
  await expect(composer(page).getByTestId("thread-permission")).toHaveCount(0);
});

test("parallel requests stack oldest first; each is answerable; an Edit shows its change", async ({ page }) => {
  await openThread(page, "parallel");
  const prompts = composer(page).getByTestId("thread-prompts");
  await expect(prompts).toHaveAttribute("data-count", "2");
  const edit = prompts.getByTestId("thread-permission").nth(0);
  const push = prompts.getByTestId("thread-permission").nth(1);
  await expect(edit).toContainText("Allow Claude to edit internal/store/pr/poller.go?");
  await expect(edit).toContainText("Allow for session switches the thread to Accept edits.");
  await expect(edit.getByTestId("thread-permission-hint")).toHaveText("Accept edits asks for files outside the project");
  await expect(push).toContainText("git push --force-with-lease");
  await expect(row(page, "s:s-r1")).toContainText("Needs input · Edit poller.go");

  const diff = edit.getByTestId("thread-permission-diff");
  await expect(diff).toContainText("+1");
  await diff.getByRole("button", { name: /Show the change/ }).click();
  await expect(diff.getByTestId("thread-diff").locator('[data-kind="add"]')).toContainText("!force");

  // The newer one first, by click: the older stays.
  await push.getByTestId("thread-permission-allow").click();
  await expect(prompts).toHaveAttribute("data-count", "1");
  await expect.poll(responds).toEqual(["respond s-r1 allow req-push"]);
  await expect(row(page, "s:s-r1")).toContainText("Needs input · Edit poller.go");
  // Then the older by key from the editor.
  await editor(page).click();
  await page.keyboard.press("1");
  await expect.poll(responds).toEqual(["respond s-r1 allow req-push", "respond s-r1 allow req-edit"]);
  await expect(composer(page).getByTestId("thread-prompts")).toHaveCount(0);
  await expect(lastText(page)).toContainText("Done: Edit ran.");
});

test("question keyboard: digits pick, Enter moves on and submits, Escape skips", async ({ page }) => {
  await openThread(page, "question");
  const q = composer(page).getByTestId("thread-question");
  await editor(page).click();
  // Nothing picked: Enter does nothing yet.
  await page.keyboard.press("Enter");
  await expect(q).toContainText("1 of 2");
  await page.keyboard.press("2");
  await expect(q.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(q).toContainText("2 of 2");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect.poll(responds).toHaveLength(1);
  const sent = (await invocations()).find((i) => i.name === "thread.respond");
  expect(Object.values(JSON.parse(sent?.args.answer ?? "{}") as Record<string, string>)).toEqual(["Push to a new branch", "Yes"]);

  await openThread(page, "question");
  await composer(page).getByTestId("thread-question").focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await responds()).at(-1)).toBe("respond s-r1 deny req-push-q");
  await expect(lastText(page)).toContainText("No problem, I'll leave those for later.");
});

test("Escape interrupts a running turn from the empty editor or the timeline, never typed text", async ({ page }) => {
  await openThread(page, "streaming");
  await editor(page).click();
  await page.keyboard.type("wait");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  expect((await calls()).filter((c) => c.startsWith("interrupt"))).toEqual([]);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Escape");
  await expect.poll(calls).toContain("interrupt s-r1");
  await expect(page.getByTestId("thread-footer").last()).toContainText("Interrupted");
  // No success toast for an interrupt: the footer says it.
  await expect(page.getByText("interrupted thread s-r1")).toHaveCount(0);

  // From the timeline (the pane focused), via the thread.interrupt keybinding.
  await openThread(page, "streaming");
  await expect(page.getByTestId("thread-interrupt")).toBeVisible();
  await page.getByTestId("thread-timeline").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls()).filter((c) => c.startsWith("interrupt")).length).toBe(2);
  await expect(page.getByTestId("thread-interrupt")).toHaveCount(0);

  // Idle: Escape does nothing.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  expect((await calls()).filter((c) => c.startsWith("interrupt")).length).toBe(2);
});

test("the Shortcuts list has Escape for Interrupt Thread", async ({ page }) => {
  await openThread(page, "idle");
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Interrupt Thread");
  await expect(page.getByRole("option", { name: /Interrupt Thread/ })).toContainText(/esc/i);
});

test("an effort change while busy waits for the turn; when idle it applies at once", async ({ page }) => {
  await openThread(page, "streaming");
  await composer(page).getByTestId("thread-effort").click();
  await page.getByRole("option", { name: "Max" }).click();
  await expect.poll(calls).toContain("set-effort s-r1 max");
  await expect(composer(page).getByTestId("thread-effort")).toContainText("Max");
  await expect(composer(page).getByTestId("thread-effort-pending")).toHaveText("Effort changes to Max after this turn");
  await mockPost("thread/finish?id=s-r1");
  await expect(composer(page).getByTestId("thread-effort-pending")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toContainText("Set effort to max");

  await composer(page).getByTestId("thread-effort").click();
  await page.getByRole("option", { name: "Low" }).click();
  await expect(page.getByTestId("thread-pane")).toContainText("Set effort to low");
  await expect(composer(page).getByTestId("thread-effort-pending")).toHaveCount(0);
});
