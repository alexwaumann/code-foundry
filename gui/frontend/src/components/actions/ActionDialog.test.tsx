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

  it("an action deleted elsewhere while the editor is open says so and cannot be saved", () => {
    render(<ActionDialog />);
    act(() => {
      useActionsStore.setState({ byId: {}, byRepo: {} });
    });
    expect(screen.getByTestId("action-error").textContent).toBe("This action was deleted.");
    expect(screen.getByTestId<HTMLButtonElement>("action-save").disabled).toBe(true);
  });
});
