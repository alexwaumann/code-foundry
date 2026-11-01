import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionIconName } from "@/api/actions";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));

const { ActionDialog } = await import("./ActionDialog");
const { BottomPanel } = await import("@/components/bottom/BottomPanel");
const { ProjectsPage } = await import("@/components/projects/ProjectsPage");
const { Toaster } = await import("@/components/ui/sonner");
const { daemon, invocationsOf, lastInvocation, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { attach } = await import("@/test/terminalHost");
const { ACTION_IDS, ACTION_NAMES, action, fakeActionCommands, seedActions } = await import("@/test/actionsWorld");
const { CF, seedWorld } = await import("@/test/projectsWorld");
const { useActionDialogStore } = await import("@/stores/actionDialog");
const { useActionsStore } = await import("@/stores/actions");
const { useBottomStore } = await import("@/stores/bottomPanel");
const { projectPage, useUiStore } = await import("@/stores/ui");

/**
 * Actions on the Projects page (docs/notes/actions-2-gui.md): a checkout row's actions menu
 * (ActionsMenu), the editor it opens (ActionDialog) saving through action.add / action.edit /
 * action.remove, a run's tab in the page's bottom panel, and Details' Add an action. The
 * daemon's answers change the actions store the way its events would. e2e/actions.spec.ts
 * keeps the pencil's hover opacity and Escape closing its tooltip before the menu.
 */

const trigger = (path = CF, project = "repo-cf") => document.querySelector<HTMLElement>(`[data-nav-key="pw:${project}::${path}"] [data-testid="worktree-actions-menu"]`);
const menu = () => screen.getByTestId("worktree-actions-menu-menu");
const items = () => within(menu()).queryAllByTestId("action-item");
const item = (name: string) => items().find((e) => e.textContent === name) as HTMLElement;
const dialog = () => screen.queryByTestId("action-dialog");
const field = (id: string) => within(dialog() as HTMLElement).getByTestId<HTMLInputElement>(id);

/** Lets a picked item run (onCloseAutoFocus, the editor's microtask) and commands answer. */
async function settle(n = 3) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function openMenu(path = CF, project = "repo-cf"): HTMLElement {
  fireEvent.pointerDown(trigger(path, project) as HTMLElement, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return menu();
}

async function pickItem(el: HTMLElement) {
  fireEvent.click(el);
  await settle();
}

function renderPage(projectId: string) {
  act(() => {
    useUiStore.getState().select(projectPage(projectId));
  });
  return render(
    <>
      <ProjectsPage />
      <ActionDialog />
      <BottomPanel columnHeight={800} />
      <Toaster />
    </>,
  );
}

let nextId = 0;

/** The daemon's action.add / action.edit / action.remove, applied to the store as its events would; a name the project has (ignoring case) is refused. */
function fakeEditor() {
  daemon.handlers.set("action.add", (inv) => {
    const { name = "", command = "", icon = "play", project = "" } = inv.args;
    const taken = Object.values(useActionsStore.getState().byId).find((a) => a.projectId === project && a.name.toLowerCase() === name.toLowerCase());
    if (taken) throw refuse(`failed precondition: this project already has an action named "${taken.name}"`);
    const id = `a-new${String(++nextId).padStart(9, "0")}`;
    const ids = useActionsStore.getState().byProject[project] ?? [];
    const a = action(id, project, name, command, icon as ActionIconName, { onWorktreeCreate: inv.args["on-worktree-create"] === "true", position: ids.length });
    act(() => {
      useActionsStore.setState((s) => ({ byId: { ...s.byId, [id]: a }, byProject: { ...s.byProject, [project]: [...ids, id] } }));
    });
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("action.edit", (inv) => {
    const id = inv.args.action ?? "";
    act(() => {
      useActionsStore.setState((s) => {
        const a = s.byId[id];
        return a ? { byId: { ...s.byId, [id]: { ...a, ...(inv.args.command !== undefined ? { command: inv.args.command } : {}), ...(inv.args.name !== undefined ? { name: inv.args.name } : {}) } } } : {};
      });
    });
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("action.remove", (inv) => {
    const id = inv.args.action ?? "";
    act(() => {
      useActionsStore.setState((s) => {
        const a = s.byId[id];
        if (!a) return {};
        const { [id]: _gone, ...byId } = s.byId;
        return { byId, byProject: { ...s.byProject, [a.projectId]: (s.byProject[a.projectId] ?? []).filter((x) => x !== id) } };
      });
    });
    return { message: "", resultJson: "" };
  });
}

beforeEach(() => {
  resetDaemon();
  attach.reset();
  seedWorld();
  seedActions();
  useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
  useActionDialogStore.setState({ editor: null, runId: null, seq: 0 });
  fakeEditor();
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
});

describe("a checkout row's actions menu", () => {
  it("the project's name, its actions in order, New action; each pencil names its action", async () => {
    renderPage("repo-cf");
    await settle();
    openMenu();
    expect(within(menu()).getByTestId("actions-project").textContent).toBe("code-foundry");
    expect(items().map((e) => e.textContent)).toEqual(ACTION_NAMES);
    expect(within(menu()).getByTestId("action-new").textContent).toBe("New action");
    expect(within(item("Test")).getByTestId("action-edit").getAttribute("aria-label")).toBe("Edit Test");
  });

  it("an item runs the action for that worktree, in the Projects page's bottom panel", async () => {
    fakeActionCommands(() => ({ projectId: "repo-cf", worktree: CF }));
    renderPage("repo-cf");
    await settle();
    openMenu();
    await pickItem(item("Build"));
    expect(invocationsOf("action.run").map((c) => [c.args, c.context.activeProjectId, c.context.activeWorktreePath])).toEqual([[{ action: ACTION_IDS.build, terminal: "true" }, "repo-cf", CF]]);
    const bottom = screen.getByTestId("bottom-panel");
    expect(bottom.dataset.panelKey).toBe("view:projects");
    expect([...bottom.querySelectorAll('[data-kind="action"]')].map((e) => e.textContent)).toEqual(["Build"]);
    expect(screen.getByTestId("action-echo").textContent).toBe("$ make build");
  });

  it("a project without actions has no row menu; Details says none, and Add an action opens a new one's editor", async () => {
    renderPage("repo-gp");
    await settle();
    expect(screen.queryByTestId("worktree-actions-menu")).toBeNull();
    expect(screen.getByTestId("details-actions").textContent).toMatch(/none\s*·\s*Add an action/);
    fireEvent.click(screen.getByTestId("details-add-action"));
    await settle();
    expect(dialog()?.dataset.mode).toBe("new");
    expect(dialog()?.textContent).toContain("Saved for every thread in ghostty-playground.");
    expect(document.activeElement).toBe(field("action-name"));
  });

  it("the project menu's New action adds one to that project", async () => {
    renderPage("repo-gp");
    await settle();
    fireEvent.pointerDown(screen.getByTestId("project-more"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await pickItem(screen.getByTestId("project-new-action"));
    expect(dialog()?.dataset.mode).toBe("new");
    expect(dialog()?.textContent).toContain("Saved for every thread in ghostty-playground. Runs in the worktree's checkout");
    fireEvent.change(field("action-name"), { target: { value: "Zig build" } });
    fireEvent.change(field("action-command"), { target: { value: "zig build" } });
    fireEvent.click(field("action-save"));
    await settle();
    expect(dialog()).toBeNull();
    expect(lastInvocation("action.add")?.args).toMatchObject({ name: "Zig build", command: "zig build", project: "repo-gp" });
    const ids = useActionsStore.getState().byProject["repo-gp"] ?? [];
    expect(ids.map((id) => useActionsStore.getState().byId[id]?.name)).toEqual(["Zig build"]);
  });
});

describe("add, then edit (pencil and ArrowRight), then delete an action", () => {
  it("each step sends what the editor holds, and the menu follows the store", async () => {
    renderPage("repo-cf");
    await settle();
    await pickItem(within(openMenu()).getByTestId("action-new"));
    expect(dialog()?.dataset.mode).toBe("new");
    expect(within(dialog() as HTMLElement).getByRole("heading", { name: "New action" })).toBeTruthy();
    const save = () => field("action-save") as unknown as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(field("action-name"), { target: { value: "Lint" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(field("action-command"), { target: { value: "golangci-lint run\nstaticcheck ./..." } });
    fireEvent.click(dialog()?.querySelector('[data-testid="action-icon"][data-icon="lint"]') as HTMLElement);
    expect(dialog()?.querySelector('[data-testid="action-icon"][aria-checked="true"]')?.getAttribute("data-icon")).toBe("lint");
    fireEvent.click(field("action-on-create"));
    expect(field("action-on-create").getAttribute("aria-checked")).toBe("true");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await settle();
    expect(dialog()).toBeNull();
    expect(invocationsOf("action.add").map((i) => i.args)).toEqual([{ name: "Lint", command: "golangci-lint run\nstaticcheck ./...", icon: "lint", "in-terminal": "true", "on-worktree-create": "true", project: "repo-cf" }]);
    openMenu();
    expect(items().map((e) => e.textContent)).toEqual([...ACTION_NAMES, "Lint"]);
    fireEvent.keyDown(menu(), { key: "Escape" });
    await settle();

    // A name the project has (ignoring case): the daemon's refusal, in place, without its
    // "failed precondition: " and without a toast.
    await pickItem(within(openMenu()).getByTestId("action-new"));
    fireEvent.change(field("action-name"), { target: { value: "test" } });
    fireEvent.change(field("action-command"), { target: { value: "true" } });
    fireEvent.click(save());
    await settle();
    expect(field("action-error").textContent).toBe('this project already has an action named "Test"');
    expect(field("action-name").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
    fireEvent.click(field("action-cancel"));
    await settle();
    expect(dialog()).toBeNull();

    // The pencil edits (it runs nothing); only what changed is sent; Cmd+Enter saves.
    const lint = Object.values(useActionsStore.getState().byId).find((a) => a.name === "Lint");
    expect(lint).toBeDefined();
    openMenu();
    fireEvent.click(within(item("Lint")).getByTestId("action-edit"));
    await settle();
    expect(screen.queryByTestId("worktree-actions-menu-menu")).toBeNull();
    expect(invocationsOf("action.run")).toHaveLength(0);
    expect(dialog()?.dataset.mode).toBe("edit");
    expect(field("action-name").value).toBe("Lint");
    expect(field("action-command").value).toBe("golangci-lint run\nstaticcheck ./...");
    fireEvent.change(field("action-command"), { target: { value: "make lint" } });
    fireEvent.keyDown(field("action-command"), { key: "Enter", metaKey: true });
    await settle();
    expect(dialog()).toBeNull();
    expect(invocationsOf("action.edit").map((i) => i.args)).toEqual([{ action: lint?.id, command: "make lint", project: "repo-cf" }]);

    // ArrowRight on a highlighted row is the pencil's keyboard path.
    openMenu();
    fireEvent.keyDown(item("Lint"), { key: "ArrowRight" });
    await settle();
    expect(dialog()?.dataset.mode).toBe("edit");
    expect(field("action-command").value).toBe("make lint");
    expect(invocationsOf("action.run")).toHaveLength(0);

    // Delete asks in the footer, Save gone; the project's name does not break; Keep goes
    // back (the keyboard with it), Delete deletes.
    fireEvent.click(field("action-delete"));
    const confirm = field("action-delete-confirm");
    expect(confirm.textContent).toContain("Delete Lint for every thread in code-foundry?");
    expect(within(confirm).getByTestId("action-delete-project").classList.contains("truncate")).toBe(true);
    expect(within(dialog() as HTMLElement).queryByTestId("action-save")).toBeNull();
    expect(document.activeElement).toBe(within(confirm).getByTestId("action-delete-keep"));
    fireEvent.click(within(confirm).getByTestId("action-delete-keep"));
    expect(within(dialog() as HTMLElement).queryByTestId("action-delete-confirm")).toBeNull();
    expect(document.activeElement).toBe(field("action-delete"));
    fireEvent.click(field("action-delete"));
    fireEvent.click(field("action-delete-yes"));
    await settle();
    expect(dialog()).toBeNull();
    expect(invocationsOf("action.remove").map((i) => i.args)).toEqual([{ action: lint?.id, project: "repo-cf" }]);
    openMenu();
    expect(items().map((e) => e.textContent)).toEqual(ACTION_NAMES);
  });
});
