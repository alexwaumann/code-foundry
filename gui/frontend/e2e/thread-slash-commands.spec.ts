import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * A running thread's "/" card offers the slash commands its process reported
 * (docs/notes/slash-commands-2-gui.md) over the mock's scripted thread: the project's and
 * the user's skills as before, a plugin's under "Skills", Claude Code's own under "Claude
 * Code" (plain text when inserted); aliases match. A message starting with a command the
 * app replaces is refused with the daemon's text under the composer, the text kept. Set
 * SHOTS=<dir> to save screenshots (the card in both schemes: its light pass runs only then,
 * nothing in it is theme-specific). Matching and aliases: src/lib/completion.test.ts.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openThread(page: Page, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const card = (page: Page) => page.getByTestId("completion-card");
const labels = (page: Page) => card(page).getByTestId("completion-label");
const headings = (page: Page) => card(page).getByTestId("completion-group");
const prompt = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-prompt");

// The card's groups (Claude Code last), the hint and a description's first line: unit-tested in
// src/components/compose/SlashCommandCard.test.tsx.

/** SHOTS=<dir>: the card in both schemes. */
for (const scheme of ["dark", "light"] as const) {
  test(`the card screenshot (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
    await openThread(page, scheme);
    await page.keyboard.type("/");
    await expect(headings(page)).toHaveText(["User", "Skills", "Claude Code"]);
    await shot(page, `slash-card-${scheme}`);
  });
}

test("a built-in inserts plain text; a skill keeps its tag; the text goes as typed", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("/comp");
  await expect(card(page).locator("[data-selected]")).toContainText("/compact");
  await page.keyboard.press("Enter");
  await expect(card(page)).toBeHidden();
  await expect(prompt(page)).toHaveAttribute("data-value", "/compact ");
  await expect(page.getByTestId("thread-composer").getByTestId("prompt-tag")).toHaveCount(0);
  await page.keyboard.type("keep the plan and /dep");
  await expect(labels(page).first()).toHaveText("/deploy");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("thread-composer").getByTestId("prompt-tag")).toHaveText("/deploy");
  await page.keyboard.press("Enter");
  await expect.poll(calls).toContain("send s-r1 /compact keep the plan and /deploy");
});

// The daemon's refusal under the composer, the text kept, and a message it takes clearing it:
// unit-tested in src/components/thread/ThreadComposer.test.tsx (the refusals and aliases are
// the daemon's: internal/store/thread/slashcommands_test.go). Left here: typing in the real
// editor clears it.
test("a refused command's message under the composer goes once the text is edited", async ({ page }) => {
  await openThread(page, "light");
  await page.keyboard.type("/clear please");
  await expect(card(page)).toBeHidden();
  await page.keyboard.press("Enter");
  const error = page.getByTestId("thread-composer-error");
  await expect(error).toHaveText("Start a new thread instead of clearing this one.");
  await expect(prompt(page)).toHaveAttribute("data-value", "/clear please");
  await shot(page, "slash-refused-light");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/name new title");
  await expect(error).toBeHidden();
});

// The list following commands events and falling back to the disk scan: unit-tested in
// src/components/compose/SlashCommandCard.test.tsx and src/api/slashCommands.test.ts.
