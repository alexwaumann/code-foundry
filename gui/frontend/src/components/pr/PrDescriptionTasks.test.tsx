import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const reads = vi.hoisted(() => ({ gate: Promise.resolve() }));
vi.mock("@/api/gh", async (orig) => {
  const { prGhFakes } = await import("@/test/prWorld");
  return {
    ...(await orig<typeof import("@/api/gh")>()),
    ...prGhFakes,
    getPullRequestDetail: async (slug: string, number: number) => {
      await reads.gate;
      return prGhFakes.getPullRequestDetail(slug, number);
    },
  };
});
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { daemon, invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { seedPrWorld, SLUG } = await import("@/test/prWorld");
const { openPr, renderPrPanel, resetPrStores, settle, toastTexts } = await import("@/test/prPanelHarness");
const { usePrPanelStore } = await import("@/stores/prPanel");

/**
 * The description's task boxes (TaskBox, stores/prPanel.ts setTaskChecked) in a pull request
 * tab against src/test/prWorld.ts: who gets them, what pr.checkbox is sent, the optimistic
 * state, the failure, and what stays read-only. Which items count: lib/taskItems.test.tsx.
 */

let world: ReturnType<typeof seedPrWorld>;

beforeEach(async () => {
  resetDaemon();
  world = seedPrWorld();
  await resetPrStores();
  reads.gate = Promise.resolve();
});

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  cleanup();
  vi.clearAllMocks();
});

const description = () => within(screen.getByTestId("pr-description"));
const boxes = () => description().queryAllByRole("checkbox");
const box = (name: string | RegExp) => description().getByRole("checkbox", { name });
const stateOf = (el: HTMLElement) => el.getAttribute("aria-checked");
const MANUAL = "resize a thread while it prints (manual)";

/** Holds pr.checkbox until the returned function is called. */
function holdCheckbox(): () => void {
  const run = daemon.handlers.get("pr.checkbox");
  if (!run) throw new Error("no pr.checkbox");
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  daemon.handlers.set("pr.checkbox", async (inv) => {
    await gate;
    return run(inv);
  });
  return release;
}

async function show(number = 145): Promise<void> {
  renderPrPanel();
  await openPr(number);
}

describe("description task boxes", () => {
  it("offers a box for each task item, in its state", async () => {
    await show();
    expect(boxes().map(stateOf)).toEqual(["true", "false"]);
    expect((box(MANUAL) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("pr-description").querySelectorAll("input")).toHaveLength(0);
  });

  it("ticks one: its index, state and source text go to pr.checkbox, the box stays ticked", async () => {
    await show();
    fireEvent.click(box(MANUAL));
    await settle(4);
    expect(invocationsOf("pr.checkbox").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145", index: "1", checked: "true", text: MANUAL }]);
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(world.detail(145)?.body).toContain(`- [x] ${MANUAL}`);
    expect(screen.queryByTestId("pr-task-saving")).toBeNull();
    expect(toastTexts()).toEqual([]);
  });

  it("unticks one, naming it by its source, code ticks and all", async () => {
    await show();
    const code = "`go test ./internal/store/terminal/...`";
    fireEvent.click(box(code));
    await settle(4);
    expect(invocationsOf("pr.checkbox").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145", index: "0", checked: "false", text: code }]);
    expect(stateOf(box(code))).toBe("false");
    expect(world.detail(145)?.body).toContain(`- [ ] ${code}`);
  });

  it("flips at once and shows a spinner while it saves; a second click sends nothing", async () => {
    await show();
    const release = holdCheckbox();
    fireEvent.click(box(MANUAL));
    await settle();
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(box(MANUAL).getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByTestId("pr-task-saving")).toHaveLength(1);
    fireEvent.click(box(MANUAL));
    await settle();
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(invocationsOf("pr.checkbox")).toHaveLength(1);
    release();
    await settle(4);
    expect(screen.queryByTestId("pr-task-saving")).toBeNull();
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(usePrPanelStore.getState().taskChecks).toEqual({});
  });

  it("does not flip back between the daemon's answer and the new detail", async () => {
    await show();
    let release = () => {};
    reads.gate = new Promise<void>((r) => (release = r));
    fireEvent.click(box(MANUAL));
    await settle(4);
    // The command is done and the read is under way: the store still holds the state.
    expect(world.detail(145)?.body).toContain(`- [x] ${MANUAL}`);
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(box(MANUAL).getAttribute("aria-busy")).toBe("true");
    release();
    await settle(4);
    expect(stateOf(box(MANUAL))).toBe("true");
    expect(box(MANUAL).getAttribute("aria-busy")).toBe("false");
  });

  it("lets a second box go while the first saves", async () => {
    await show();
    const release = holdCheckbox();
    fireEvent.click(box(MANUAL));
    await settle();
    const [first] = boxes();
    if (!first) throw new Error("no box");
    fireEvent.click(first);
    await settle();
    expect(invocationsOf("pr.checkbox").map((i) => i.args.index)).toEqual(["1", "0"]);
    expect(screen.getAllByTestId("pr-task-saving")).toHaveLength(2);
    release();
    await settle(6);
    expect(boxes().map(stateOf)).toEqual(["false", "true"]);
  });

  it("goes back and toasts the daemon's message when refused", async () => {
    await show();
    world.failNext.add("pr.checkbox");
    fireEvent.click(box(MANUAL));
    await settle(4);
    expect(stateOf(box(MANUAL))).toBe("false");
    expect(screen.queryByTestId("pr-task-saving")).toBeNull();
    expect(toastTexts().join(" ")).toContain(`has a different task 2 in its description now ("edited on GitHub", was "${MANUAL}")`);
    expect(world.detail(145)?.body).toContain(`- [ ] ${MANUAL}`);
  });

  it("shows the new text after a refusal, and a click then goes with it", async () => {
    await show();
    world.update(145, (d) => ({ ...d, body: d.body.replace(MANUAL, "edited on GitHub") }));
    fireEvent.click(box(MANUAL));
    await settle(6);
    expect(toastTexts().join(" ")).toContain("has a different task 2");
    fireEvent.click(box("edited on GitHub"));
    await settle(4);
    expect(invocationsOf("pr.checkbox").at(-1)?.args.text).toBe("edited on GitHub");
    expect(stateOf(box("edited on GitHub"))).toBe("true");
  });

  it("does not move the Show all fold", async () => {
    await show();
    const body = screen.getByTestId("pr-description-body");
    const folded = body.dataset.folded;
    fireEvent.click(box(MANUAL));
    await settle(4);
    expect(screen.getByTestId("pr-description-body").dataset.folded).toBe(folded);
    expect(usePrPanelStore.getState().byTab).toEqual(expect.not.objectContaining({ open: expect.anything() as unknown }));
  });

  it("keeps the boxes read-only for a viewer who cannot edit", async () => {
    world.update(145, (d) => ({ ...d, viewerCanUpdate: false, viewerPermission: "read" }));
    await show();
    expect(boxes().map((b) => (b as HTMLInputElement).disabled)).toEqual([true, true]);
    expect(screen.getByTestId("pr-description").querySelectorAll("input")).toHaveLength(2);
    expect(screen.queryByTestId("pr-task-box")).toBeNull();
  });

  it.each(["merged", "closed"] as const)("offers them on a %s pull request the viewer can edit, as GitHub does", async (state) => {
    world.update(145, (d) => ({ ...d, viewerCanUpdate: true, pullRequest: { ...d.pullRequest, state } }));
    await show();
    fireEvent.click(box(MANUAL));
    await settle(4);
    expect(invocationsOf("pr.checkbox")).toHaveLength(1);
    expect(stateOf(box(MANUAL))).toBe("true");
  });

  it("leaves task lists in comments read-only", async () => {
    world.update(145, (d) => ({ ...d, comments: d.comments.map((c, i) => (i === 0 ? { ...c, body: "- [ ] in a comment" } : c)) }));
    await show();
    expect(screen.getByText("in a comment").querySelector("input")?.disabled).toBe(true);
    expect(screen.getAllByTestId("pr-task-box")).toHaveLength(2);
  });
});
