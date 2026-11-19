import { expect, test } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Reply marks (docs/notes/thread-reply-mark.md). The marks' data and the mock's scenario are
 * vitest's (api/replies, mock/replies); this only saves the PR's screenshots with
 * SHOTS=<dir>: the sender's "Asked … · waiting for a reply" / "Told … · no reply needed" note
 * rows as today's timeline draws them, before and after the answer turns the question's row
 * into "· replied" in place.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

for (const scheme of ["dark", "light"] as const) {
  test(`reply mark note rows screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await mockPost("thread?state=replies");
    await openApp(page);
    await row(page, "s:s-r1").click();
    const pane = page.getByTestId("thread-pane");
    await expect(pane.getByText("· waiting for a reply")).toBeVisible();
    await page.mouse.move(1390, 890);
    await page.screenshot({ path: `${shots ?? ""}/reply-mark-waiting-${scheme}.png`, scale: "device" });
    await mockPost("thread/reply?id=s-r1");
    await expect(pane.getByText("· replied")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/reply-mark-replied-${scheme}.png`, scale: "device" });
  });
}
