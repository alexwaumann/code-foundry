import { expect, type Page } from "@playwright/test";
import { MOCK_PORT, MOCK_TOKEN } from "../playwright.config";

export const mockUrl = `http://127.0.0.1:${String(MOCK_PORT)}`;
export const CF = "/Users/dev/src/code-foundry";

/** App URL pointed at the e2e mock daemon via the dev-only query override. */
export const appPath = `/?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}`;

/**
 * Resets the mock to its default world and holds it still: the mock's clock flips s-1
 * busy/idle every 4 s and settles s-5 from starting after 8 s, which would move them in and
 * out of the sidebar's Working section (and every row below them) under a spec's pointer.
 * Held, s-1 stays busy and s-5 starting, so the sidebar shows DEFAULT_ORDER. A spec that
 * needs the clock releases them (`releaseSessions`).
 */
export async function resetMock(): Promise<void> {
  const res = await fetch(`${mockUrl}/__mock/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
  await holdSessions("s-1", "s-5");
  // s-1 may have flipped to idle between the reset and the hold.
  await mockPost("session/status?id=s-1&status=busy");
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

/** Stops the mock's clock from changing these threads (status, settling); controls and input still do. */
export async function holdSessions(...ids: string[]): Promise<void> {
  await mockPost(`session/hold?${ids.map((id) => `id=${id}`).join("&")}`);
}

/** Lets the mock's clock change these threads again (resetMock holds s-1 and s-5). */
export async function releaseSessions(...ids: string[]): Promise<void> {
  await mockPost(`session/release?${ids.map((id) => `id=${id}`).join("&")}`);
}

/** The default world's sidebar order after resetMock: s-2 waits, s-6/s-4/s-3 are idle, s-5 (starting) and s-1 (busy) work. */
export const DEFAULT_ORDER = ["s:s-2", "s:s-6", "s:s-4", "s:s-3", "h:working", "s:s-5", "s:s-1"];

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
 * Shows a worktree's overview: the Projects page with the worktree's tab in the page's
 * side panel, by double-clicking its row (a project's worktree row, or a workspace
 * member row when `workspaceId` is given). The page stays selected: the palette has no
 * worktree context here; tests that need one select a thread in the worktree.
 */
export async function selectWorktree(page: Page, repoId: string, path: string, workspaceId?: string): Promise<void> {
  await openProjects(page);
  const key = workspaceId ? `m:${workspaceId}::${repoId}` : `pw:${repoId}::${path}`;
  await page.locator(`[data-nav-key="${key}"]`).dblclick();
  await expect(page.getByTestId("worktree-surface")).toHaveAttribute("data-path", path);
}

/** Shows a project's main worktree in the Projects page's side panel by double-clicking the project row. */
export async function selectProject(page: Page, repoId: string): Promise<void> {
  await openProjects(page);
  await page.locator(`[data-nav-key="p:${repoId}"]`).dblclick();
  await expect(page.getByTestId("worktree-surface")).toHaveAttribute("data-repo", repoId);
}

export function row(page: Page, key: string) {
  return page.locator(`[data-row-key="${key}"]`);
}

/**
 * Text of the bottom panel's active shell (renderer-agnostic: works for WebGL too). Its
 * host is the only terminal host (threads have none), exposed as window.__cfTerminal.
 */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __cfTerminal?: { renderer: { getText(): string } } };
    return w.__cfTerminal?.renderer.getText() ?? "";
  });
}

export async function expectTerminalText(page: Page, text: string | RegExp): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout: 5000 }).toMatch(text);
}

/** The selected thread's prompt: its composer's editor, where a selected thread puts the keyboard. */
export function threadPrompt(page: Page) {
  return page.getByTestId("thread-composer").getByTestId("composer-input");
}
