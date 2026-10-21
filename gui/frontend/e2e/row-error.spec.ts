import { expect, test } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

// A payload the renderer cannot handle (a drifted Claude format) used to unmount the whole
// window. It now degrades to one row; the rest of the thread and the window stay.
test("a timeline row that fails to render degrades alone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openApp(page);
  await row(page, "s:s-1").click();
  const pane = page.getByTestId("thread-pane");
  await expect(pane.getByTestId("thread-user").first()).toBeVisible();
  await page.evaluate(async () => {
    // The app's own store, from the Vite dev server (the instance the app runs).
    const storeUrl = "/src/stores/thread.ts";
    const { useThreadStore } = (await import(/* @vite-ignore */ storeUrl)) as {
      useThreadStore: { setState: (f: (s: { logs: Record<string, { byId: Record<string, { ordinal: number }>; order: string[] }> }) => unknown) => void };
    };
    useThreadStore.setState((s) => {
      const log = s.logs["s-1"];
      if (!log) return s;
      const ordinal = Math.max(...Object.values(log.byId).map((x) => x.ordinal)) + 1;
      // A text item whose text is not a string.
      const it = { id: "broken", ordinal, kind: "text", parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false, text: 42 };
      return { logs: { ...s.logs, "s-1": { ...log, byId: { ...log.byId, broken: it }, order: [...log.order, "broken"] } } };
    });
  });
  const broken = pane.getByTestId("row-error");
  await expect(broken).toContainText("Could not render this item.");
  await expect(pane.getByTestId("thread-user").first()).toBeVisible();
  await expect(page.getByTestId("thread-list")).toBeVisible();
  await broken.getByTestId("error-details-toggle").click();
  await expect(broken.getByTestId("error-details")).toContainText('"id": "broken"');
  expect(errors).toEqual([]);
});
