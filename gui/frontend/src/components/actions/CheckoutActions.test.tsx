import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionIconName } from "@/api/actions";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));

const { ActionDialog } = await import("./ActionDialog");
const { ProjectsPage } = await import("@/components/projects/ProjectsPage");
const { Toaster } = await import("@/components/ui/sonner");
const { daemon, invocationsOf, lastInvocation, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { layoutOf, pane, row: split, seedLayout, space, tab } = await import("@/test/shellLayout");
const { ACTION_IDS, ACTION_NAMES, action, fakeActionCommands, seedActions } = await import("@/test/actionsWorld");
const { CF, GP, seedWorld } = await import("@/test/projectsWorld");
const { useActionDialogStore } = await import("@/stores/actionDialog");
const { useActionsStore } = await import("@/stores/actions");
const { resetLayout } = await import("@/stores/layout");
const { useShellViewStore } = await import("@/stores/shellView");
const { projectPage, useUiStore } = await import("@/stores/ui");

/**
 * Actions on the Projects page (docs/notes/actions-2-gui.md): a checkout row's Run action
 * submenu (its right-click menu, docs/notes/project-page-2-checkouts.md), the editor it opens (ActionDialog) saving through action.add / action.edit /
 * action.remove, a run (the keyboard into its tab), and Details' Add an action. The
 * daemon's answers change the actions store the way its events would. e2e/actions.spec.ts
 * keeps the gear's split hover in a real browser.
 */

const row = (path = CF, project = "repo-cf") => document.querySelector<HTMLElement>(`[data-nav-key="pw:${project}::${path}"]`) as HTMLElement;
const menu = () => screen.getByTestId("checkout-menu-actions-menu");
const items = () => within(menu()).queryAllByTestId("checkout-menu-action");
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

/** The row's right-click menu, then its Run action submenu (ArrowRight on its trigger). */
function openMenu(path = CF, project = "repo-cf"): HTMLElement {
  fireEvent.contextMenu(row(path, project));
  const sub = screen.getByTestId("checkout-menu-actions");
  act(() => {
    sub.focus();
  });
  fireEvent.keyDown(sub, { key: "ArrowRight" });
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
  resetLayout();
  seedWorld();
  seedActions();
  useActionDialogStore.setState({ editor: null, runId: null, seq: 0 });
  fakeEditor();
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
});

describe("a checkout row's Run action submenu", () => {
  it("the project's actions in order with their icons, Add action; each gear names its action", async () => {
    renderPage("repo-cf");
    await settle();
    openMenu();
    expect(items().map((e) => e.textContent)).toEqual(ACTION_NAMES);
    expect(items().every((e) => e.querySelector("svg") !== null)).toBe(true);
    expect(within(menu()).getByTestId("checkout-menu-add-action").textContent).toBe("Add action");
    expect(within(item("Test")).getByTestId("checkout-menu-action-gear").getAttribute("aria-label")).toBe("Edit Test");
  });

  it("an item runs the action for that worktree; the keyboard goes into the run's tab", async () => {
    fakeActionCommands(() => ({ projectId: "repo-cf", worktree: CF }));
    // The daemon opens the run's tab (here in a second pane) as it starts the run.
    const run = daemon.handlers.get("action.run");
    daemon.handlers.set("action.run", async (inv) => {
      const res = await (run as NonNullable<typeof run>)(inv);
      const { terminalId } = JSON.parse(res.resultJson) as { terminalId: string };
      await seedLayout(layoutOf([space(split("r-1", [pane("p-1", [tab("t-page", "projects")]), pane("p-2", [tab("t-run", "terminal", "", { params: { terminal: terminalId } })])]), "p-1")]));
      return res;
    });
    const seq = useShellViewStore.getState().focusRequest.seq;
    renderPage("repo-cf");
    await settle();
    openMenu();
    await pickItem(item("Build"));
    expect(invocationsOf("action.run").map((c) => [c.args, c.context.activeProjectId, c.context.activeWorktreePath])).toEqual([[{ action: ACTION_IDS.build, terminal: "true" }, "repo-cf", CF]]);
    expect(useShellViewStore.getState().focusRequest).toEqual({ paneId: "p-2", seq: seq + 1 });
  });

  it("a project without actions has no Run action; Details says none, and Add an action opens a new one's editor", async () => {
    renderPage("repo-gp");
    await settle();
    fireEvent.contextMenu(row(GP, "repo-gp"));
    expect(screen.getByTestId("checkout-menu")).toBeTruthy();
    expect(screen.queryByTestId("checkout-menu-actions")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("checkout-menu"), { key: "Escape" });
    await settle();
    expect(screen.getByTestId("details-actions-value").textContent).toBe("none");
    fireEvent.click(screen.getByTestId("details-add-action"));
    await settle();
    expect(dialog()?.dataset.mode).toBe("new");
    expect(dialog()?.textContent).toContain("Saved for every thread in ghostty-playground.");
    expect(document.activeElement).toBe(field("action-name"));
  });

  it("Details' Actions row names them; its Edit menu lists them with their icons (each opens its editor) and New action", async () => {
    renderPage("repo-cf");
    await settle();
    expect(screen.getByTestId("details-actions-value").textContent).toBe(ACTION_NAMES.join(" · "));
    fireEvent.pointerDown(screen.getByTestId("details-edit-actions"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const edit = screen.getByTestId("details-actions-menu");
    expect(edit.querySelector('[data-slot="dropdown-menu-label"]')?.textContent).toBe("Edit an action");
    const entries = within(edit).getAllByTestId("details-action-edit");
    expect(entries.map((e) => e.textContent)).toEqual(ACTION_NAMES);
    for (const e of entries) expect(e.querySelector("svg")).toBeTruthy();
    expect(within(edit).getByTestId("details-new-action").textContent).toBe("New action");
    await pickItem(entries[1] as HTMLElement);
    expect(dialog()?.dataset.mode).toBe("edit");
    expect(field("action-name").value).toBe(ACTION_NAMES[1]);
  });

  it("Details' Edit menu's New action adds one to that project", async () => {
    renderPage("repo-cf");
    await settle();
    fireEvent.pointerDown(screen.getByTestId("details-edit-actions"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await pickItem(screen.getByTestId("details-new-action"));
    expect(dialog()?.dataset.mode).toBe("new");
    expect(dialog()?.textContent).toContain("Saved for every thread in code-foundry. Runs in the worktree's checkout");
    fireEvent.change(field("action-name"), { target: { value: "Zig build" } });
    fireEvent.change(field("action-command"), { target: { value: "zig build" } });
    fireEvent.click(field("action-save"));
    await settle();
    expect(dialog()).toBeNull();
    expect(lastInvocation("action.add")?.args).toMatchObject({ name: "Zig build", command: "zig build", project: "repo-cf" });
    const ids = useActionsStore.getState().byProject["repo-cf"] ?? [];
    expect(ids.map((id) => useActionsStore.getState().byId[id]?.name)).toEqual([...ACTION_NAMES, "Zig build"]);
  });
});

describe("add, then edit (gear by pointer and by keyboard), then delete an action", () => {
  it("each step sends what the editor holds, and the menu follows the store", async () => {
    renderPage("repo-cf");
    await settle();
    await pickItem(within(openMenu()).getByTestId("checkout-menu-add-action"));
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
    await pickItem(within(openMenu()).getByTestId("checkout-menu-add-action"));
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

    // The gear edits (it runs nothing); only what changed is sent; Cmd+Enter saves.
    const lint = Object.values(useActionsStore.getState().byId).find((a) => a.name === "Lint");
    expect(lint).toBeDefined();
    openMenu();
    fireEvent.click(within(item("Lint")).getByTestId("checkout-menu-action-gear"));
    await settle();
    expect(screen.queryByTestId("checkout-menu")).toBeNull();
    expect(invocationsOf("action.run")).toHaveLength(0);
    expect(dialog()?.dataset.mode).toBe("edit");
    expect(field("action-name").value).toBe("Lint");
    expect(field("action-command").value).toBe("golangci-lint run\nstaticcheck ./...");
    fireEvent.change(field("action-command"), { target: { value: "make lint" } });
    fireEvent.keyDown(field("action-command"), { key: "Enter", metaKey: true });
    await settle();
    expect(dialog()).toBeNull();
    expect(invocationsOf("action.edit").map((i) => i.args)).toEqual([{ action: lint?.id, command: "make lint", project: "repo-cf" }]);

    // ArrowRight on a highlighted item focuses its gear; Enter there edits.
    openMenu();
    act(() => {
      item("Lint").focus();
    });
    fireEvent.keyDown(item("Lint"), { key: "ArrowRight" });
    const gear = within(item("Lint")).getByTestId("checkout-menu-action-gear");
    expect(document.activeElement).toBe(gear);
    fireEvent.keyDown(gear, { key: "Enter" });
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
