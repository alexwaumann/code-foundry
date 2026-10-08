import { expect, type Page } from "@playwright/test";
import { MOCK_PORT, MOCK_TOKEN } from "../playwright.config";

export const mockUrl = `http://127.0.0.1:${String(MOCK_PORT)}`;
export const CF = "/Users/dev/src/code-foundry";

/** App URL pointed at the e2e mock daemon via the dev-only query override. */
export const appPath = `/?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}`;

export async function resetMock(): Promise<void> {
  const res = await fetch(`${mockUrl}/__mock/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
}

export interface Invocation {
  name: string;
  context: { activeTerminalId: string; activeSessionId: string; activeRepoId: string; activeWorktreePath: string; activeView: string } | null;
  args: Record<string, string>;
}

export async function invocations(): Promise<Invocation[]> {
  const res = await fetch(`${mockUrl}/__mock/invocations`);
  return (await res.json()) as Invocation[];
}

export async function writes(): Promise<{ id: string; data: string }[]> {
  const res = await fetch(`${mockUrl}/__mock/writes`);
  return (await res.json()) as { id: string; data: string }[];
}

/** UiService.Emit with the Connect JSON protocol, as the CLI would. */
export async function emit(intent: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.UiService/Emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ intent }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { delivered?: number }).delivered ?? 0;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto(appPath);
  await expect(page.getByRole("treeitem").filter({ hasText: "code-foundry" }).first()).toBeVisible();
}

export function row(page: Page, key: string) {
  return page.locator(`[data-row-key="${key}"]`);
}

/** Text of the attached terminal's buffer (renderer-agnostic: works for WebGL too). */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __cfTerminal?: { renderer: { getText(): string } } };
    return w.__cfTerminal?.renderer.getText() ?? "";
  });
}

export async function expectTerminalText(page: Page, text: string | RegExp): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout: 5000 }).toMatch(text);
}
