import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPickView } from "@/api/actions";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const picks = vi.hoisted(() => new Map<string, ActionPickView>());
vi.mock("@/api/actions", async (orig) => ({ ...(await orig<typeof import("@/api/actions")>()), getActionPick: (projectId: string) => Promise.resolve(picks.get(projectId) ?? null) }));

const { PlaceGroup } = await import("./PlaceGroup");
const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { ACTION_IDS, ACTION_NAMES, seedActions } = await import("@/test/actionsWorld");
const { seedWorld } = await import("@/test/projectsWorld");
const { actionPicksResource } = await import("@/stores/threadInfo");
const { useActionsStore } = await import("@/stores/actions");

/**
 * The thread info card's action row (docs/notes/actions-2-gui.md): its ellipsis lists the
 * project's actions and an item runs one for the thread (action.run --terminal in the
 * thread's context). The run's tab is src/components/bottom/BottomPanel.test.tsx's.
 */

beforeEach(() => {
  resetDaemon();
  seedWorld();
  seedActions();
  actionPicksResource.store.setState({ entries: {} });
  const dev = useActionsStore.getState().byId[ACTION_IDS.dev];
  if (!dev) throw new Error("no Dev");
  picks.set("repo-cf", { source: "first", action: dev, last: null });
});

afterEach(cleanup);

describe("the card's action row", () => {
  it("its menu lists the project's actions; an item runs that one for the thread", async () => {
    render(<PlaceGroup threadId="s-1" />);
    await waitFor(() => {
      expect(screen.getByTestId("ti-action-more")).toBeTruthy();
    });
    fireEvent.pointerDown(screen.getByTestId("ti-action-more"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = screen.getByTestId("ti-action-menu");
    expect(within(menu).getAllByTestId("ti-action-item").map((e) => e.textContent)).toEqual(ACTION_NAMES);
    fireEvent.click(within(menu).getAllByTestId("ti-action-item")[1] as HTMLElement);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("ti-action-menu")).toBeNull();
    expect(invocationsOf("action.run").map((c) => [c.args, c.context.activeThreadId])).toEqual([[{ action: ACTION_IDS.test, terminal: "true" }, "s-1"]]);
  });
});
