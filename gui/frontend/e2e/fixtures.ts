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
  context: { activeTerminalId: string; activeSessionId: string; activeRepoId: string; activeWorktreePath: string; activeView: string; activeWorkspaceId?: string } | null;
  args: Record<string, string>;
  confirmed?: boolean;
}

export async function invocations(): Promise<Invocation[]> {
  const res = await fetch(`${mockUrl}/__mock/invocations`);
  return (await res.json()) as Invocation[];
}

/** The mock's registered projects (RepoService.List). protojson omits git: false. */
export async function listRepos(): Promise<{ id: string; path: string; name: string; git: boolean }[]> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.RepoService/List`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: "{}",
  });
  expect(res.ok).toBe(true);
  const { repos = [] } = (await res.json()) as { repos?: { id: string; path: string; name: string; git?: boolean }[] };
  return repos.map((r) => ({ id: r.id, path: r.path, name: r.name, git: r.git ?? false }));
}

/** The registered project at path, or undefined. */
export async function repoAt(path: string): Promise<{ id: string; path: string; name: string; git: boolean } | undefined> {
  return (await listRepos()).find((r) => r.path === path);
}

/** POSTs a /__mock control endpoint and returns its JSON. */
export async function mockPost(pathAndQuery: string): Promise<unknown> {
  const res = await fetch(`${mockUrl}/__mock/${pathAndQuery}`, { method: "POST" });
  expect(res.ok, `${pathAndQuery}: ${String(res.status)}`).toBe(true);
  return res.json();
}

/** Long-lived streams the mock has open right now, by RPC (e.g. "EventService/Watch"). */
export async function openStreams(): Promise<Record<string, number>> {
  const res = await fetch(`${mockUrl}/__mock/streams`);
  return (await res.json()) as Record<string, number>;
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
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
}

/** Shows the Projects page from its sidebar entry. */
export async function openProjects(page: Page): Promise<void> {
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
}

/**
 * Selects a worktree (its overview page) from the Projects page through the row's Open
 * button: a project's worktree row, or a workspace member row when `workspaceId` is
 * given. (Enter or double-click on a row shows the worktree in the page's side panel.)
 */
export async function selectWorktree(page: Page, repoId: string, path: string, workspaceId?: string): Promise<void> {
  await openProjects(page);
  const key = workspaceId ? `m:${workspaceId}::${repoId}` : `pw:${repoId}::${path}`;
  const r = page.locator(`[data-nav-key="${key}"]`);
  await r.hover();
  await r.getByTestId(workspaceId ? "member-open-overview" : "worktree-open").click();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
}

/** Selects a project (its overview page) from the Projects page through the row's Open button. */
export async function selectProject(page: Page, repoId: string): Promise<void> {
  await openProjects(page);
  const r = page.locator(`[data-nav-key="p:${repoId}"]`);
  await r.hover();
  await r.getByTestId("project-open").click();
  await expect(page.getByTestId("projects-page")).toHaveCount(0);
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
