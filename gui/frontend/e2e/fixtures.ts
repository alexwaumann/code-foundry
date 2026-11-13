import { expect, type Locator, type Page } from "@playwright/test";
import { MOCK_PORT, MOCK_TOKEN } from "../playwright.config";

export const mockUrl = `http://127.0.0.1:${String(MOCK_PORT)}`;
export const CF = "/Users/dev/src/code-foundry";

/** What every send from the composer adds to thread.new's args (docs/notes/instant-threads-4-composer.md). */
export const BACKGROUND = { "background-setup": "true", "draft-json": expect.any(String) as unknown as string };

/** App URL pointed at the e2e mock daemon via the dev-only query override. */
export const appPath = `/?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}`;

/**
 * Resets the mock to its default world and holds it still: the mock's clock flips s-1
 * busy/idle every 4 s and settles s-5 from starting after 8 s, which would move them in and
 * out of the sidebar's Working section (and every row below them) under a spec's pointer.
 * Held, s-1 stays busy and s-5 starting, so the sidebar's order holds still.
 */
export async function resetMock(): Promise<void> {
  const res = await fetch(`${mockUrl}/__mock/reset`, { method: "POST" });
  expect(res.ok).toBe(true);
  await holdThreads("s-1", "s-5");
  // s-1 may have flipped to idle between the reset and the hold.
  await mockPost("thread/status?id=s-1&status=busy");
}

export interface Invocation {
  name: string;
  context: { activeTerminalId: string; activeThreadId: string; activeProjectId: string; activeWorktreePath: string; activeView: string; activeWorkspaceId?: string } | null;
  args: Record<string, string>;
  confirmed?: boolean;
}

export async function invocations(): Promise<Invocation[]> {
  const res = await fetch(`${mockUrl}/__mock/invocations`);
  return (await res.json()) as Invocation[];
}

/** The mock's registered projects (ProjectService.List). protojson omits git: false. */
export async function listProjects(): Promise<{ id: string; path: string; name: string; git: boolean }[]> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.ProjectService/List`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: "{}",
  });
  expect(res.ok).toBe(true);
  const { projects: projects = [] } = (await res.json()) as { projects?: { id: string; path: string; name: string; git?: boolean }[] };
  return projects.map((r) => ({ id: r.id, path: r.path, name: r.name, git: r.git ?? false }));
}

/** The registered project at path, or undefined. */
export async function projectAt(path: string): Promise<{ id: string; path: string; name: string; git: boolean } | undefined> {
  return (await listProjects()).find((r) => r.path === path);
}

/** POSTs a /__mock control endpoint and returns its JSON. */
/**
 * The thread info card off for every thread never toggled (the setting layout.thread_info; on by
 * default): a spec of the card turns it on with the header's toggle, from a known state.
 */
export async function infoCardOff(): Promise<void> {
  await mockPost("settings/external?layout.thread_info=false");
}

export async function mockPost(pathAndQuery: string): Promise<unknown> {
  const res = await fetch(`${mockUrl}/__mock/${pathAndQuery}`, { method: "POST" });
  expect(res.ok, `${pathAndQuery}: ${String(res.status)}`).toBe(true);
  return res.json();
}

/**
 * Makes a fresh copy the composer's default Work in choice (the default is the project
 * folder itself), for specs that exercise the new-worktree flow: the base picker,
 * thread.new --new-worktree.
 */
export async function freshCopyByDefault(): Promise<void> {
  await mockPost("settings/external?threads.default_worktree=new");
}

/** Stops the mock's clock from changing these threads (status, settling); controls and input still do. */
export async function holdThreads(...ids: string[]): Promise<void> {
  await mockPost(`thread/hold?${ids.map((id) => `id=${id}`).join("&")}`);
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

/** An intent (UiIntent as Connect JSON) to every window, as a command emits it (POST /__mock/emit). */
export async function emit(intent: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${mockUrl}/__mock/emit`, { method: "POST", body: JSON.stringify({ intent }) });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { delivered?: number }).delivered ?? 0;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto(appPath);
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  // The window's first draw (the layout and the first-load import): the key table acts from then on.
  await expect(page.locator('[data-testid="shell"][data-shell-mode="shell"]')).toBeVisible();
}

/**
 * cmd+N, then the nth project row of the picker (registry order, whatever the rows above
 * it: No project and the workspaces): that project's composer, its prompt focused.
 */
export async function composeProject(page: Page, n = 1): Promise<void> {
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await palette.locator("[data-project]").nth(n - 1).click();
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/**
 * Opens the Add Project dialog (project.add) the way a user without a shortcut does: the
 * sidebar's New thread button, then the project picker's "Add a project…" row.
 */
export async function openAddProjectDialog(page: Page): Promise<void> {
  await page.getByTestId("sidebar-new-thread").click();
  await page.getByTestId("palette").getByTestId("picker-add-project").click();
  await expect(page.getByTestId("add-project-dialog")).toBeVisible();
}

/**
 * Shows the Projects index in a tab: the space's Projects tab (one per space), opened or focused by
 * selecting the index (the selection bridge runs view.projects), in an empty space too.
 */
export async function openProjects(page: Page): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().select(m.PROJECTS_INDEX))`);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
}

/** Shows a project's page: the index, then its row. */
export async function openProjectPage(page: Page, projectId: string): Promise<void> {
  await openProjects(page);
  // The name: the middle of the row may be its failing checks, which open their page instead.
  await page.locator(`[data-nav-key="p:${projectId}"]`).getByTestId("project-name").click();
  await expect(page.locator(`[data-testid="projects-page"][data-page="project"][data-project="${projectId}"]`)).toBeVisible();
}

/** Shows a workspace's page: the index, then its row. */
export async function openWorkspacePage(page: Page, workspaceId: string): Promise<void> {
  await openProjects(page);
  await page.locator(`[data-nav-key="ws:${workspaceId}"]`).click();
  await expect(page.locator(`[data-testid="projects-page"][data-page="workspace"][data-workspace="${workspaceId}"]`)).toBeVisible();
}

/** Opens a checkout's Diff tab in the shown page's side panel (stores/filePanel.ts openCheckoutDiff, what a checkout menu's Show changes runs). */
async function openDiffTabFor(page: Page, projectId: string, path: string): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((c) => c.openCheckoutDiff("current", ${JSON.stringify(projectId)}, ${JSON.stringify(path)}))`);
}

/**
 * Shows a worktree's Diff tab: its project's page with the worktree's tab in the page's
 * side panel (a checkout row has no click; its menu's Show changes runs the same, and only
 * with changes), or, with `workspaceId`, the workspace's page with the tab in its panel (a
 * member row opens nothing; a thread row's menu shows a changed member's). The page stays
 * selected: the palette has no worktree context here; tests that need one select a thread in
 * the worktree.
 */
export async function selectWorktree(page: Page, projectId: string, path: string, workspaceId?: string): Promise<void> {
  if (workspaceId) {
    await openWorkspacePage(page, workspaceId);
    await openDiffTabFor(page, projectId, path);
  } else {
    await openProjectPage(page, projectId);
    await openDiffTabFor(page, projectId, path);
  }
  await expect(page.getByTestId("diff-surface")).toHaveAttribute("data-path", path);
}

/**
 * Opens the selected thread's own Diff tab in its panel, as the thread info card's
 * Changes row does (stores/filePanel.ts openCheckoutDiff), without the card: tests of
 * the panel's tabs start from it. The panel shows, unfocused.
 */
export async function openThreadChanges(page: Page): Promise<void> {
  const path = await page.evaluate(`Promise.all([__cfModule("/src/stores/filePanel.ts"), __cfModule("/src/stores/threads.ts"), __cfModule("/src/stores/ui.ts")]).then(([c, t, u]) => {
    const sel = u.useUiStore.getState().selection;
    const th = sel.kind === "thread" ? t.useThreadsStore.getState().byId[sel.id] : undefined;
    if (!th) return "";
    c.openCheckoutDiff("current", th.projectId, th.worktreePath, true);
    return th.worktreePath;
  })`);
  expect(path).not.toBe("");
  await expect(page.getByTestId("diff-surface")).toHaveAttribute("data-path", String(path));
}

export function row(page: Page, key: string) {
  return page.locator(`[data-row-key="${key}"]`);
}

/**
 * Moves the pointer onto `target` and waits for the sidebar row's hover card to go. After a
 * row click the card outlives the pointer for a moment, and while it is up it takes the first
 * Escape (Tip's Escape rule), so a test about Escape in the pane would race it. It is waited
 * out of the DOM, not only closed: fading out, it still lies over the pane and takes a wheel.
 */
export async function leaveSidebar(page: Page, target: Locator): Promise<void> {
  await target.hover();
  await expect(page.getByTestId("thread-tooltip")).toHaveCount(0);
}

/** How many threads need the user, as the window title says ("Code Foundry (2)"); Ember is not counted there. */
export async function expectAttention(page: Page, count: number): Promise<void> {
  await expect(page).toHaveTitle(count > 0 ? `Code Foundry (${String(count)})` : "Code Foundry");
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

/** The open tooltip (`Tip`, components/ui/tooltip.tsx); one fading out has data-state="closed". */
export function openTooltip(page: Page): Locator {
  return page.locator('[data-slot="tooltip-content"]:not([data-state="closed"])');
}

/**
 * Hovers `target` and expects the themed tooltip that opens to read `text` (there are no
 * native `title` tooltips), then moves the pointer off and waits for it to close.
 */
export async function expectTooltip(page: Page, target: Locator, text: string | RegExp): Promise<void> {
  // From outside: a tooltip opens when the pointer enters, and not again after a click
  // until it leaves.
  await page.mouse.move(0, 0);
  await target.hover();
  await expect(openTooltip(page)).toHaveText(text);
  await page.mouse.move(0, 0);
  await expect(openTooltip(page)).toHaveCount(0);
}

/** A minimal valid PDF (mock/pdf.ts, shared with the mock daemon's file fixtures). */
export { testPdf } from "../mock/pdf";

/** Viewport points at the start and end of `text` inside `within` (its first occurrence, across text nodes of one element). */
export async function textPoints(within: Locator, text: string): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  return within.evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let all = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      all += (n as Text).data;
    }
    const at = all.indexOf(needle);
    if (at < 0) throw new Error(`no ${needle}`);
    const point = (offset: number, end: boolean) => {
      let acc = 0;
      for (const t of nodes) {
        if (offset < acc + t.data.length || (end && offset === acc + t.data.length)) {
          const r = document.createRange();
          const o = offset - acc;
          r.setStart(t, end ? o - 1 : o);
          r.setEnd(t, end ? o : o + 1);
          const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
          return { x: end ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 };
        }
        acc += t.data.length;
      }
      throw new Error("offset out of range");
    };
    return { from: point(at, false), to: point(at + needle.length, true) };
  }, text);
}

/** Drags the mouse over `text` (in `within`), from its start to its end, once the text has stopped moving (the virtualized list measures rows as they mount). */
export async function dragSelect(page: Page, within: Locator, text: string): Promise<{ x: number; y: number }> {
  let pts = await textPoints(within, text);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(50);
    const next = await textPoints(within, text);
    const still = next.from.x === pts.from.x && next.from.y === pts.from.y && next.to.y === pts.to.y;
    pts = next;
    if (still) break;
  }
  const { from, to } = pts;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  return to;
}

/**
 * A project's page shows (and, for `worktreeBranch`, its cursor is on that checkout's
 * row): where a project just added or ui.focus.project lands
 * (stores/projectsPage.ts showProjectOnProjectsPage).
 */
export async function expectProjectRevealed(page: Page, name: string, worktreeBranch?: string): Promise<void> {
  await expect(page.locator('[data-testid="projects-page"][data-page="project"]')).toBeVisible();
  await expect(page.getByTestId("page-name")).toHaveText(name);
  if (worktreeBranch) await expect(page.locator('[data-nav-key^="pw:"][aria-selected="true"]')).toContainText(worktreeBranch);
}

/**
 * Runs a command as the CLI inside thread `threadId` would ("" for none): no active view, so
 * the reply's message is the CLI's. Not ok for a refusal, its message then the error's.
 */
export async function invokeAs(threadId: string, name: string, args: Record<string, string> = {}): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, args, ...(threadId ? { context: { activeThreadId: threadId } } : {}) }),
  });
  return { ok: res.ok, message: ((await res.json()) as { message?: string }).message ?? "" };
}

/** The mock's scripted thread calls, in order (/__mock/thread/calls). */
export async function threadCalls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

/** What the mock's plugins were asked to do, in order (/__mock/plugin/acts). */
export async function pluginActs(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/plugin/acts`);
  return (await res.json()) as string[];
}

/** The app with thread s-3 selected and its panel showing the hello plugin's demo (from the palette), live. */
export async function openHelloDemo(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(page.getByTestId("plugin-surface")).toHaveAttribute("data-phase", "live");
}

/** The page zoom at `percent`, through the app's own store (cmd+= / cmd+-), once applied. */
export async function setZoom(page: Page, percent: number): Promise<void> {
  await page.evaluate(`__cfModule("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setZoom(${String(percent)}))`);
  await expect(page.locator("html")).toHaveAttribute("data-zoom", String(percent));
}
