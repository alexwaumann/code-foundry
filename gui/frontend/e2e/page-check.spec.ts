import { expect, test } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * A page check (code-foundry page.check; docs/notes/page-self-check.md) in a real browser
 * against the mock: the shot page renders a page in a card's frame and its report, marked on
 * <html>, has the page's script error with where it was, and the call the app refused. How a
 * report is collected and when a page has settled are unit-tested (src/lib/pageCheck.test.ts),
 * the daemon and the host in Go.
 */

const PAGE = `${CF}/docs/check-broken.html`;

test.beforeEach(async () => {
  await resetMock();
});

test("a check reports the page's script error and the refused call", async ({ page }) => {
  await mockPost(`page?path=${encodeURIComponent(PAGE)}&owner=s-1&how=written`);
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`/shot.html?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}&page=${encodeURIComponent(PAGE)}&thread=s-1&settleMs=4000`);
  await expect(page.locator("html")).toHaveAttribute("data-page-check", /.+/, { timeout: 10_000 });
  const report = JSON.parse((await page.locator("html").getAttribute("data-page-check")) ?? "{}") as {
    loaded: boolean;
    problems: { kind: string; call: string; code: string; message: string; where: string }[];
  };
  expect(report.loaded).toBe(true);
  expect(report.problems).toContainEqual(expect.objectContaining({ kind: "script", message: expect.stringContaining("totl"), where: expect.stringMatching(/^check-broken\.html:6:\d+$/) }));
  expect(report.problems).toContainEqual(expect.objectContaining({ kind: "bridge", call: "thraed.list", code: "unavailable" }));
});
