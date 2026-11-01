import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionView } from "@/api/actions";

const deleteAction = vi.hoisted(() => vi.fn<(id: string, projectId: string) => Promise<string | null>>());
const saveAction = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@/stores/actionActions", async (orig) => ({ ...(await orig<typeof import("@/stores/actionActions")>()), deleteAction, saveAction }));

const { ActionDialog } = await import("./ActionDialog");
const { useActionDialogStore } = await import("@/stores/actionDialog");
const { useActionsStore } = await import("@/stores/actions");

const testAction: ActionView = { id: "a-1", projectId: "web", name: "Test", command: "go test", icon: "test", inTerminal: true, onWorktreeCreate: false, position: 0 };

beforeEach(() => {
  useActionsStore.setState({ byId: { "a-1": testAction }, byProject: { web: ["a-1"] }, runs: {} });
  useActionDialogStore.setState({ editor: { mode: "edit", actionId: "a-1", projectId: "web", from: "thread" }, seq: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useActionDialogStore.setState({ editor: null });
});

describe("ActionDialog", () => {
  it("a Delete whose removal event comes before action.remove answers does not read as deleted meanwhile", async () => {
    let answer: (v: string | null) => void = () => undefined;
    deleteAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          // The daemon publishes the removal before it answers.
          useActionsStore.setState({ byId: {}, byProject: {} });
          answer = resolve;
        }),
    );
    render(<ActionDialog />);
    fireEvent.click(screen.getByTestId("action-delete"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("action-delete-yes"));
      await Promise.resolve();
    });
    expect(deleteAction).toHaveBeenCalledWith("a-1", "web");
    expect(screen.queryByTestId("action-error")).toBeNull();
    await act(async () => {
      answer(null);
      await Promise.resolve();
    });
    expect(useActionDialogStore.getState().editor).toBeNull();
  });

  it("the inline confirm keeps the keyboard: Delete moves it to Keep, Keep back to Delete", () => {
    render(<ActionDialog />);
    const del = screen.getByTestId("action-delete");
    del.focus();
    fireEvent.click(del);
    expect(document.activeElement).toBe(screen.getByTestId("action-delete-keep"));
    fireEvent.click(screen.getByTestId("action-delete-keep"));
    expect(document.activeElement).toBe(screen.getByTestId("action-delete"));
  });

  // WebKit does not focus a button on click: after clicking an icon tile or the switch, the
  // keyboard is on the dialog's content (outside the form), and Cmd+Enter must still save.
  it.each([
    ["the dialog's content", () => screen.getByTestId("action-dialog")],
    ["an icon tile", () => screen.getAllByTestId("action-icon")[2] as HTMLElement],
    ["the switch", () => screen.getByTestId("action-on-create")],
    ["the Name field", () => screen.getByTestId("action-name")],
  ])("Cmd+Enter saves from %s", async (_n, el) => {
    render(<ActionDialog />);
    await act(async () => {
      fireEvent.keyDown(el(), { key: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(saveAction).toHaveBeenCalledWith({ projectId: "web", actionId: "a-1" }, { name: "Test", command: "go test", icon: "test", onWorktreeCreate: false });
  });

  it("the icon tiles are one radio group: one tab stop, arrow keys move the choice", async () => {
    render(<ActionDialog />);
    const tiles = screen.getAllByTestId("action-icon");
    const group = screen.getByRole("radiogroup", { name: "Icon" });
    expect(group).toBe(screen.getByTestId("action-icons"));
    // Radix's roving focus: the group is the one tab stop and hands the focus to the checked tile.
    expect(group.getAttribute("tabindex")).toBe("0");
    expect(tiles.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "-1", "-1", "-1", "-1"]);
    const test = tiles[1] as HTMLElement;
    expect(test.dataset.icon).toBe("test");
    expect(test.getAttribute("aria-checked")).toBe("true");
    act(() => {
      test.focus();
    });
    fireEvent.keyDown(test, { key: "ArrowRight" });
    await waitFor(() => {
      expect(tiles[2]?.getAttribute("aria-checked")).toBe("true");
    });
    expect(document.activeElement).toBe(tiles[2]);
    expect(test.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.keyDown(tiles[2] as HTMLElement, { key: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(saveAction).toHaveBeenCalledWith({ projectId: "web", actionId: "a-1" }, { name: "Test", command: "go test", icon: "lint", onWorktreeCreate: false });
  });

  // e2e/actions.spec.ts's icon tiles test, whose dialog opened from the Projects page.
  it("a new action's icon starts on Play; arrows wrap at the ends, End goes to the last, a click picks", async () => {
    useActionDialogStore.setState({ editor: { mode: "new", projectId: "web", from: "projects" }, seq: 3 });
    render(<ActionDialog />);
    const tile = (icon: string) => document.querySelector<HTMLElement>(`[data-testid="action-icon"][data-icon="${icon}"]`) as HTMLElement;
    const checked = () => document.querySelector('[data-testid="action-icon"][aria-checked="true"]')?.getAttribute("data-icon");
    const press = async (key: string) => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key });
      // Radix's roving focus moves on a timer.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    expect(checked()).toBe("play");
    act(() => {
      tile("play").focus();
    });
    await press("ArrowRight");
    expect(document.activeElement).toBe(tile("test"));
    expect(checked()).toBe("test");
    await press("ArrowRight");
    expect(checked()).toBe("lint");
    await press("ArrowLeft");
    expect(checked()).toBe("test");
    // End focuses the last tile; ArrowRight from there wraps to the first.
    await press("End");
    expect(document.activeElement).toBe(tile("debug"));
    await press("ArrowRight");
    expect(checked()).toBe("play");
    await press("ArrowLeft");
    expect(checked()).toBe("debug");
    fireEvent.click(tile("build"));
    expect(checked()).toBe("build");
  });

  it("Cmd+Enter does not save while the delete confirm is open", () => {
    render(<ActionDialog />);
    fireEvent.click(screen.getByTestId("action-delete"));
    fireEvent.keyDown(screen.getByTestId("action-dialog"), { key: "Enter", metaKey: true });
    expect(saveAction).not.toHaveBeenCalled();
  });

  it("a refusal goes, with the Name field's red state, once the user edits the name", async () => {
    useActionDialogStore.setState({ editor: { mode: "new", projectId: "web", from: "thread" }, seq: 2 });
    saveAction.mockImplementationOnce(() => Promise.resolve('this project already has an action named "Test"' as never));
    render(<ActionDialog />);
    const name = screen.getByTestId<HTMLInputElement>("action-name");
    fireEvent.change(name, { target: { value: "test" } });
    fireEvent.change(screen.getByTestId("action-command"), { target: { value: "true" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("action-save"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("action-error").textContent).toBe('this project already has an action named "Test"');
    expect(name.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(name, { target: { value: "test 2" } });
    expect(screen.queryByTestId("action-error")).toBeNull();
    expect(name.hasAttribute("aria-invalid")).toBe(false);
  });

  it("an action deleted elsewhere while the editor is open says so and cannot be saved", () => {
    render(<ActionDialog />);
    act(() => {
      useActionsStore.setState({ byId: {}, byProject: {} });
    });
    expect(screen.getByTestId("action-error").textContent).toBe("This action was deleted.");
    expect(screen.getByTestId<HTMLButtonElement>("action-save").disabled).toBe(true);
  });
});
