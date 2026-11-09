/** A picker (pluginsdk/ui Select.Search): what it lists, which acts it sends, its tokens and keys. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, Field, SelectOption, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";
import { PICKER_DEBOUNCE_MS, PICKER_MAX_PICKED } from "./picker";
import { InStrip } from "./strip";

const acts: ActRequestView[] = [];
let refuse = false;

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.push(req);
    return refuse ? Promise.reject(new Error("plugin refused")) : Promise.resolve();
  }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const ctx: ViewCtx = { watchKey: "w", instance: "p/s/global", plugin: "p", viewTab: "", uiContext: emptyContext } as ViewCtx;

const people: SelectOption[] = [
  { key: "o-me", value: "me", label: "Me", avatar: "AW", detail: "you", group: "Selected" },
  { key: "o-kim", value: "kim", label: "Kim Park", avatar: "K", group: "Recent" },
  { key: "o-bot", value: "bot", label: "Release bot", icon: "bot", group: "Recent", disabled: true },
];

function picker(over: Partial<Field> = {}, select: Partial<NonNullable<Field["select"]>> = {}): Field {
  return {
    key: "who",
    name: "who",
    label: "Assignee",
    change: { event: "assignee" },
    select: { multiple: true, value: ["me"], placeholder: "Anyone", options: people, search: { key: "who-search", event: "search-people", placeholder: "Search people" }, ...select },
    ...over,
  };
}

function view(field: Field, strip = false) {
  const nodes: ViewNode[] = [{ key: "f", form: { fields: [field, { key: "n", name: "note", input: { value: "x" } }] } }];
  const tree = (
    <ViewContext.Provider value={ctx}>
      <InStrip.Provider value={strip ? "toolbar" : null}>
        <NodeList nodes={nodes} />
      </InStrip.Provider>
    </ViewContext.Provider>
  );
  return tree;
}

function show(field: Field, strip = false) {
  const r = render(view(field, strip));
  return { ...r, update: (f: Field) => r.rerender(view(f, strip)) };
}

const trigger = () => screen.getByTestId("plugin-select");
const box = () => screen.getByTestId("plugin-picker-search");
const shows = () => screen.getByTestId("plugin-picker-list").getAttribute("data-shows");
const rows = () => screen.queryAllByTestId("plugin-picker-option").map((r) => r.getAttribute("data-option"));
const draftKey = `${ctx.instance}\u0000\u0000f`;

async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  // cmdk scrolls the highlighted row into view; jsdom has no layout.
  Element.prototype.scrollIntoView = () => undefined;
  acts.length = 0;
  refuse = false;
  vi.useFakeTimers();
  usePluginSurfacesStore.setState({ watches: { w: { instance: "p/s/global", version: 1 } } } as never);
});

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {} } as never);
  vi.useRealTimers();
});

describe("a picker before typing", () => {
  it("names the picked options and lists the options in their groups", () => {
    show(picker());
    expect(trigger().getAttribute("data-style")).toBe("picker");
    expect(screen.getByTestId("plugin-picker-summary").textContent).toBe("Me");
    fireEvent.click(trigger());
    expect(shows()).toBe("options");
    expect(screen.getAllByTestId("plugin-picker-group").map((g) => g.getAttribute("data-heading"))).toEqual(["Selected", "Recent"]);
    expect(rows()).toEqual(["me", "kim", "bot"]);
    const [me, , bot] = screen.getAllByTestId("plugin-picker-option");
    if (!me || !bot) throw new Error("rows");
    expect(me.getAttribute("data-picked")).toBe("true");
    expect(within(me).getByTestId("plugin-picker-avatar").textContent).toBe("AW");
    expect(me.textContent).toContain("you");
    expect(bot.getAttribute("data-disabled")).toBe("true");
    expect(within(bot).queryByTestId("plugin-picker-avatar")).toBeNull();
    expect(screen.getAllByTestId("plugin-picker-token").map((t) => t.textContent)).toEqual(["Me"]);
  });

  it("asks for characters when the plugin lists no options", () => {
    show(picker({}, { options: [], value: [] }));
    expect(screen.getByTestId("plugin-picker-summary").textContent).toBe("Anyone");
    fireEvent.click(trigger());
    expect(screen.getByTestId("plugin-picker-hint").textContent).toBe("Type 2+ characters to search");
  });
});

describe("a picker's search", () => {
  it("sends the query from two characters once typing pauses, showing Searching… until a view answers it", async () => {
    const { update } = show(picker());
    fireEvent.click(trigger());
    await type("a");
    expect(shows()).toBe("options");
    expect(acts).toEqual([]);
    fireEvent.change(box(), { target: { value: "al" } });
    expect(shows()).toBe("searching");
    expect(screen.getByTestId("plugin-picker-searching").textContent).toBe("Searching…");
    await type(" ale ");
    expect(acts.map((a) => [a.key, a.value, a.values])).toEqual([["who-search", "ale", { who: ["me"], note: "x" }]]);
    // An answer to an older query is dropped.
    update(picker({}, { search: { key: "who-search", event: "search-people", query: "al", results: [{ key: "m-al", value: "al", label: "Al" }] } }));
    expect(shows()).toBe("searching");
    update(picker({}, { search: { key: "who-search", event: "search-people", query: "ale", results: [{ key: "m-ale", value: "ale", label: "Alejandra Ruiz", group: "Matches", detail: "platform" }] } }));
    expect(shows()).toBe("results");
    expect(rows()).toEqual(["ale"]);
    update(picker({}, { search: { key: "who-search", event: "search-people", query: "ale", results: [] } }));
    expect(screen.getByTestId("plugin-picker-nomatch").textContent).toBe("No matches");
  });

  it("says so when the plugin refuses the search", async () => {
    refuse = true;
    show(picker());
    fireEvent.click(trigger());
    await type("ale");
    expect(acts).toHaveLength(1);
    expect(screen.getByTestId("plugin-picker-failed").textContent).toBe("Search failed");
  });

  it("drops a search still waiting when the picker closes", async () => {
    show(picker());
    fireEvent.click(trigger());
    fireEvent.change(box(), { target: { value: "ale" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS * 2);
    });
    expect(screen.queryByTestId("plugin-picker")).toBeNull();
    expect(acts).toEqual([]);
    expect(document.activeElement).toBe(trigger());
  });
});

describe("picking", () => {
  const answered = picker({}, { search: { key: "who-search", event: "search-people", query: "ale", results: [{ key: "m-ale", value: "ale", label: "Alejandra Ruiz" }] } });

  it("adds a multiple picker's pick as a token and sends the change, staying open", async () => {
    const { update } = show(answered);
    fireEvent.click(trigger());
    await type("ale");
    acts.length = 0;
    fireEvent.click(screen.getByText("Alejandra Ruiz"));
    expect(acts.map((a) => [a.key, a.value, a.values])).toEqual([["who", "me,ale", { who: ["me", "ale"], note: "x" }]]);
    expect(usePluginSurfacesStore.getState().drafts[draftKey]).toEqual({ who: ["me", "ale"] });
    expect(screen.getAllByTestId("plugin-picker-token").map((t) => t.textContent)).toEqual(["Me", "Alejandra Ruiz"]);
    expect(screen.getByTestId("plugin-picker")).toBeTruthy();
    // A later view without her still names her (the label this picker saw).
    update(picker({}, { search: { key: "who-search", event: "search-people", query: "kim", results: [] } }));
    expect(screen.getByTestId("plugin-picker-summary").textContent).toBe("Me, Alejandra Ruiz");
  });

  it("removes a token by its × and the last one by Backspace in an empty box", () => {
    show(picker({}, { value: ["me", "kim"] }));
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Remove Me" }));
    expect(acts.at(-1)?.values).toEqual({ who: ["kim"], note: "x" });
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(acts.at(-1)?.values).toEqual({ who: [], note: "x" });
    expect(acts.at(-1)?.value).toBe("");
    expect(screen.queryAllByTestId("plugin-picker-token")).toEqual([]);
    // Backspace with text in the box edits the text.
    fireEvent.change(box(), { target: { value: "k" } });
    const before = acts.length;
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(acts).toHaveLength(before);
  });

  it("closes a single picker on a pick, and picking the chosen one again clears it", async () => {
    show(picker({}, { multiple: false, value: ["me"] }));
    fireEvent.click(trigger());
    expect(screen.queryAllByTestId("plugin-picker-token")).toEqual([]);
    fireEvent.click(screen.getByText("Kim Park"));
    expect(acts.at(-1)?.value).toBe("kim");
    expect(acts.at(-1)?.values).toEqual({ who: "kim", note: "x" });
    expect(screen.queryByTestId("plugin-picker")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // Radix moves focus back a task later
    });
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.click(within(screen.getByTestId("plugin-picker-list")).getByText("Kim Park"));
    expect(acts.at(-1)?.value).toBe("");
  });

  it("keeps a required single picker's choice when it is picked again", () => {
    show(picker({ required: true }, { multiple: false, value: ["me"] }));
    fireEvent.click(trigger());
    fireEvent.click(within(screen.getByTestId("plugin-picker-list")).getByText("Me"));
    expect(acts.at(-1)?.value).toBe("me");
  });

  it("picks the highlighted row with Enter after the arrows move", () => {
    show(picker({}, { value: [] }));
    fireEvent.click(trigger());
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(acts.at(-1)?.values).toEqual({ who: ["kim"], note: "x" });
  });

  it("stops at the limit: unpicked rows are disabled", () => {
    const many = Array.from({ length: PICKER_MAX_PICKED }, (_, i) => `v${String(i)}`);
    show(picker({}, { value: many }));
    fireEvent.click(trigger());
    const kim = screen.getAllByTestId("plugin-picker-option").find((r) => r.getAttribute("data-option") === "kim");
    expect(kim?.getAttribute("data-disabled")).toBe("true");
  });

  it("sends no change for a disabled field: the trigger is disabled", () => {
    show(picker({ disabled: true }));
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a picker in a toolbar", () => {
  it("is a compact trigger: its label, then the picked labels", () => {
    show(picker({}, { value: ["me", "kim"] }), true);
    expect(trigger().getAttribute("data-style")).toBe("picker-compact");
    expect(trigger().textContent).toBe("AssigneeMe, Kim Park");
    expect(screen.getAllByTestId("plugin-field")[0]?.className).toContain("shrink");
  });

  it("shows only the label (and a placeholder when given) with nothing picked", () => {
    show(picker({}, { value: [], placeholder: undefined }), true);
    expect(trigger().textContent).toBe("Assignee");
  });
});
