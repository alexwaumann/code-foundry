import { expect, test, type Page } from "@playwright/test";
import { invocations, leaveSidebar, mockPost, mockUrl, openApp, openTooltip, resetMock, row } from "./fixtures";

/**
 * Answering a thread (rendered threads PR 3, docs/notes/rendered-threads-3-interaction.md):
 * the docked permission and question prompts over the mock's scripted thread
 * (mock/thread.ts), their keyboard, Escape not interrupting and effort changes. Set SHOTS=<dir>
 * to save screenshots of the panels in both schemes (the light pass runs only then: the panel
 * tests assert nothing theme-specific).
 */

test.beforeEach(async () => {
  await resetMock();
});

type State = "permission" | "question" | "streaming" | "idle" | "parallel" | "multi" | "subagent";

async function openThread(page: Page, state: State, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  await leaveSidebar(page, editor(page));
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

async function editorFocused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable);
}

// The permission panel, deny with a reason, the question panel (Other, a multi-select) and Allow
// answering at once: unit-tested in src/components/thread/PendingPrompt.test.tsx. What the
// thread does after the answer (Claude's reply, the denied or ran row) is the mock's script;
// the sidebar's Permission line and the window title's count: SidebarRow.test.tsx, threads.test.ts.

/** SHOTS=<dir>: the docked panels in both schemes. */
for (const scheme of ["dark", "light"] as const) {
  test(`panel screenshots (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
    await openThread(page, "permission", scheme);
    const prompt = composer(page).getByTestId("thread-permission");
    await expect(prompt).toContainText("Allow Claude to run this command?");
    await shot(page, `permission-${scheme}`);
    await prompt.getByTestId("thread-permission-deny").click();
    await expect(prompt.getByTestId("thread-deny-reason")).toBeFocused();
    await prompt.getByTestId("thread-deny-reason").fill("Use the staging branch instead");
    await shot(page, `deny-reason-${scheme}`);

    await openThread(page, "question", scheme);
    const q = composer(page).getByTestId("thread-question");
    await q.getByRole("radio").nth(0).click();
    await shot(page, `question-${scheme}`);

    await openThread(page, "multi", scheme);
    const m = composer(page).getByTestId("thread-question");
    await m.getByRole("checkbox").nth(0).click();
    await m.getByRole("checkbox").nth(2).click();
    await shot(page, `question-multi-${scheme}`);
  });
}

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
  await expect.poll(() => editorFocused(page)).toBe(true);

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
  await expect.poll(() => editorFocused(page)).toBe(true);
});

// A failed answer bringing the prompt back with an error toast: src/stores/threadActions.test.ts ("a failed answer brings the prompt back once…"), src/stores/openRequests.test.ts and src/stores/commands.test.ts (the failure toast).

// Parallel requests stacked oldest first, each answerable (the older by key from the editor), an
// Edit's change: unit-tested in src/components/thread/PendingPrompt.test.tsx.

// The agent's label and answering: unit-tested in src/components/thread/PendingPrompt.test.tsx.
// Left here: the tooltip only when the label is cut short (scrollWidth, a real layout).
test("a subagent's label cut short by a narrow prompt has a tooltip", async ({ page }) => {
  // The compact thread width keeps the prompt's header narrow enough to cut the label short.
  await mockPost("settings/external?appearance.thread_width=compact");
  await openThread(page, "subagent");
  const chip = composer(page).getByTestId("thread-permission").getByTestId("thread-asking-agent");
  await expect(chip).toHaveText("general-purpose · Write the changelog entry");
  expect(await chip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await chip.hover();
  await expect(openTooltip(page)).toHaveText("general-purpose · Write the changelog entry");
  await shot(page, "subagent-dark");
  await page.mouse.move(0, 0);
  await expect(openTooltip(page)).toHaveCount(0);
});

// The keys' logic (Enter with nothing picked, digits, Enter moving on and submitting) and Escape
// skipping a focused question: unit-tested in src/components/thread/PendingPrompt.test.tsx.
// Left here: the keys reaching the prompt from the real editor.
test("question keyboard from the editor: digits pick, Enter moves on and submits", async ({ page }) => {
  await openThread(page, "question");
  const q = composer(page).getByTestId("thread-question");
  await editor(page).click();
  await page.keyboard.press("2");
  await expect(q.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(q).toContainText("2 of 2");
  await page.keyboard.press("1");
  await page.keyboard.press("Enter");
  await expect.poll(responds).toHaveLength(1);
  const sent = (await invocations()).find((i) => i.name === "thread.respond");
  expect(Object.values(JSON.parse(sent?.args.answer ?? "{}") as Record<string, string>)).toEqual(["Push to a new branch", "Yes"]);
});

test("Escape never interrupts a running turn (editor or timeline); the Interrupt button does", async ({ page }) => {
  await openThread(page, "streaming");
  const interrupts = async () => (await calls()).filter((c) => c.startsWith("interrupt"));
  // The empty editor.
  await editor(page).click();
  await page.keyboard.press("Escape");
  // The timeline (the pane focused).
  await page.getByTestId("thread-timeline").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  expect(await interrupts()).toEqual([]);
  await expect(page.getByTestId("thread-interrupt")).toBeVisible();

  await page.getByTestId("thread-interrupt").click();
  await expect.poll(calls).toContain("interrupt s-r1");
  await expect(page.locator('[data-testid="thread-turn-header"]:not([data-live])').last()).toContainText("Interrupted");
  await expect(page.getByTestId("thread-interrupt")).toHaveCount(0);
  // No success toast for an interrupt: the header says it.
  await expect(page.getByText("interrupted thread s-r1")).toHaveCount(0);
});

// An effort change while busy waits for the turn, when idle it applies at once: unit-tested in
// src/components/thread/ThreadComposer.test.tsx (the "Set effort to" note is the daemon's).

// Answering a request Claude withdrew (a plain notice, no error, the prompt stays gone):
// unit-tested in src/components/thread/PendingPrompt.test.tsx; its timeline row stops waiting
// when the daemon resolves the request (rows.test.tsx, "a tool waiting for permission").

test("fields keep their keys: the Other field and the deny reason take digits and Escape; an open reason ignores 1 and 2", async ({ page }) => {
  await openThread(page, "question");
  const q = composer(page).getByTestId("thread-question");
  const other = q.getByLabel("Other answer");
  await other.click();
  await page.keyboard.type("12");
  await expect(other).toHaveValue("12");
  await expect(q.getByRole("radio").nth(0)).toHaveAttribute("aria-checked", "false");
  // Escape leaves the field for the prompt; it does not skip.
  await page.keyboard.press("Escape");
  await expect(q).toBeFocused();
  // Enter on a focused action button is the button's own: Skip skips, it does not submit.
  await q.getByTestId("thread-question-skip").focus();
  await page.keyboard.press("Enter");
  await expect.poll(responds).toEqual(["respond s-r1 deny req-push-q"]);

  await openThread(page, "permission");
  const prompt = composer(page).getByTestId("thread-permission");
  await editor(page).click();
  await page.keyboard.press("3");
  const reason = prompt.getByTestId("thread-deny-reason");
  await expect(reason).toBeFocused();
  await page.keyboard.type("2 tests fail");
  await expect(reason).toHaveValue("2 tests fail");
  // Back in the empty editor, 1 and 2 do not allow while the reason is open; 3 returns to it.
  await editor(page).click();
  await page.keyboard.press("1");
  await page.keyboard.press("2");
  await page.keyboard.press("3");
  await expect(reason).toBeFocused();
  await expect(reason).toHaveValue("2 tests fail");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await responds()).slice(1)).toEqual(["respond s-r1 deny req-push message=2 tests fail"]);
});

// A question's pages and picks surviving the timeline streaming meanwhile: unit-tested in
// src/components/thread/PendingPrompt.test.tsx.
