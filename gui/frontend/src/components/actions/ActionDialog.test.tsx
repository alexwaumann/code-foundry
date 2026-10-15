import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionView } from "@/api/actions";

const deleteAction = vi.hoisted(() => vi.fn<(id: string, repoId: string) => Promise<string | null>>());
const saveAction = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@/stores/actionActions", async (orig) => ({ ...(await orig<typeof import("@/stores/actionActions")>()), deleteAction, saveAction }));

const { ActionDialog } = await import("./ActionDialog");
const { useActionDialogStore } = await import("@/stores/actionDialog");
const { useActionsStore } = await import("@/stores/actions");

const testAction: ActionView = { id: "a-1", repoId: "web", name: "Test", command: "go test", icon: "test", inTerminal: true, onWorktreeCreate: false, position: 0 };

beforeEach(() => {
  useActionsStore.setState({ byId: { "a-1": testAction }, byRepo: { web: ["a-1"] }, runs: {} });
  useActionDialogStore.setState({ editor: { mode: "edit", actionId: "a-1", repoId: "web", from: "thread" }, seq: 1 });
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
          useActionsStore.setState({ byId: {}, byRepo: {} });
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
    expect(saveAction).toHaveBeenCalledWith({ repoId: "web", actionId: "a-1" }, { name: "Test", command: "go test", icon: "test", onWorktreeCreate: false });
  });

  it("Cmd+Enter does not save while the delete confirm is open", () => {
    render(<ActionDialog />);
    fireEvent.click(screen.getByTestId("action-delete"));
    fireEvent.keyDown(screen.getByTestId("action-dialog"), { key: "Enter", metaKey: true });
    expect(saveAction).not.toHaveBeenCalled();
  });

  it("a refusal goes, with the Name field's red state, once the user edits the name", async () => {
    useActionDialogStore.setState({ editor: { mode: "new", repoId: "web", from: "thread" }, seq: 2 });
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
      useActionsStore.setState({ byId: {}, byRepo: {} });
    });
    expect(screen.getByTestId("action-error").textContent).toBe("This action was deleted.");
    expect(screen.getByTestId<HTMLButtonElement>("action-save").disabled).toBe(true);
  });
});
