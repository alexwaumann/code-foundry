/**
 * Plugin menus (docs/notes/plugin-menu.md): the fold rule and a row's menu items (pure), a
 * menu's blocks, and in jsdom what the row's ⋯, its right-click menu, the header's ⋯ and a
 * menu button show and which act a pick sends. The real right-click at the pointer and
 * focus coming back are in e2e/plugin-menu.spec.ts.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, Row, ViewButton, ViewMenuItem, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { ViewContext, type ViewCtx } from "./context";
import { SurfaceHeader } from "./Header";
import { buttonItem, buttonsWidth, buttonWidth, foldRowActions, isContextMenuKey, menuBlocks, menuKeys, ROW_TITLE_MIN, rowMenuItems } from "./menu";
import { NodeList } from "./NodeList";

const host = vi.hoisted(() => ({ acts: [] as ActRequestView[], commands: [] as unknown[][], urls: [] as string[], copies: [] as string[] }));

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    host.acts.push(req);
    return Promise.resolve(2);
  }),
}));

vi.mock("@/stores/pluginSurfaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/pluginSurfaces")>()),
  runCommandElement: vi.fn((...args: unknown[]) => {
    host.commands.push(args);
    return Promise.resolve(true);
  }),
  openElementUrl: vi.fn((url: string) => {
    host.urls.push(url);
  }),
  copyElementText: vi.fn((text: string) => {
    host.copies.push(text);
    return Promise.resolve();
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "jira/board/global", viewTab: "", uiContext: emptyContext, inert: false };

function inView(children: ReactNode, c: ViewCtx = ctx) {
  return render(<ViewContext.Provider value={c}>{children}</ViewContext.Provider>);
}

const btn = (key: string, label: string, extra: Partial<ViewButton> = {}): ViewButton => ({ key, label, action: { event: key }, ...extra });
const item = (key: string, label: string, extra: Partial<ViewMenuItem> = {}): ViewMenuItem => ({ key, label, action: { event: "pick", data: key }, ...extra });

/** Jira's row menu (sketch C): items, a separator, a Move to submenu of one group, a URL, a copy, a disabled danger item. */
const JIRA: ViewMenuItem[] = [
  item("start", "Start a thread on this"),
  { key: "send", label: "Send to this thread", action: { command: { name: "thread.send", args: { text: "CF-407" } } } },
  { separator: true },
  {
    key: "move",
    label: "Move to",
    submenu: [item("todo", "To do", { group: "status" }), item("review", "In review", { group: "status", checked: true }), item("done", "Done", { group: "status" })],
  },
  { separator: true },
  { key: "open", label: "Open in Jira", action: { openUrl: "https://jira.example.com/CF-407" } },
  { key: "copy", label: "Copy key", action: { copy: "CF-407" } },
  { separator: true },
  item("delete", "Delete", { danger: true, disabled: true }),
];

function list(rows: Row[], dense = false): ViewNode {
  return { key: "l", list: { rows, ...(dense ? { dense } : {}) } };
}

/** Lets Radix's close (its focus scope's unmount runs in a timeout) and the picked item's act land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function openMore(scope: HTMLElement = document.body): HTMLElement {
  fireEvent.pointerDown(within(scope).getByRole("button", { name: "More options" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByTestId("plugin-more-menu");
}

/** The menu's entries as text: labels, "---" for a separator, "▸" after a submenu, "✓" before a checked item. */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"]')].map((el) => {
    if (el.getAttribute("role") === "separator") return "---";
    const label = el.textContent;
    if (el.getAttribute("data-testid") === "plugin-menu-sub") return `${label} ▸`;
    return el.hasAttribute("data-checked") ? `✓ ${label}` : label;
  });
}

async function pick(menu: HTMLElement, key: string) {
  const el = menu.querySelector(`[data-key="${key}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no item ${key}`);
  fireEvent.click(el);
  await settle();
}

/** Gives every plugin row `width` px (jsdom has no layout). */
function rowWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.getAttribute("data-testid") === "plugin-row" ? width : 0;
    return { top: 0, bottom: 40, left: 0, right: w, width: w, height: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
}

beforeEach(() => {
  host.acts = [];
  host.commands = [];
  host.urls = [];
  host.copies = [];
  usePluginSurfacesStore.setState({ watches: { w: { instance: "jira/board/global", version: 1 } } } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {} } as never);
});

describe("the fold rule (sketch C)", () => {
  const three = [btn("rerun", "Rerun", { icon: "rotate-ccw" }), btn("log", "Open log"), btn("send", "Send to thread")];
  it("estimates a button's width as PluginButton draws it", () => {
    expect(buttonWidth(btn("x", "Rerun", { icon: "x", iconOnly: true }))).toBe(24);
    expect(buttonWidth(btn("x", "Rerun"))).toBe(16 + 5 * 7);
    expect(buttonWidth(btn("x", "Rerun", { icon: "rotate-ccw" }))).toBe(16 + 14 + 5 * 7);
    expect(buttonsWidth([btn("a", "Rerun"), btn("b", "Log")])).toBe(buttonWidth(btn("a", "Rerun")) + buttonWidth(btn("b", "Log")) + 6);
  });

  it.each([
    ["no buttons", null, [], false, false],
    ["not measured yet", null, three, false, false],
    ["a side panel row", 400, three, false, true],
    ["an expanded panel's row", 700, three, false, false],
    ["just wide enough", ROW_TITLE_MIN + buttonsWidth(three), three, false, false],
    ["one px short", ROW_TITLE_MIN + buttonsWidth(three) - 1, three, false, true],
    ["two short buttons in the panel", 400, three.slice(0, 2), false, false],
    ["a dense row's labelled buttons", null, three, true, true],
    ["a dense row's icon buttons", 700, [btn("x", "Cancel", { icon: "square", iconOnly: true })], true, false],
  ] as const)("%s", (_, width, actions, dense, want) => {
    expect(foldRowActions(width, actions, dense)).toBe(want);
  });

  it("puts folded buttons first, a separator, then the menu's items; null without a ⋯", () => {
    const actions = [btn("rerun", "Rerun"), btn("stop", "Stop", { style: "destructive", disabled: true }), btn("busy", "Busy", { busy: true })];
    const menu = { items: [item("open", "Open")] };
    expect(rowMenuItems({ actions }, false)).toBeNull();
    expect(rowMenuItems({ actions, menu }, false)).toEqual(menu.items);
    expect(rowMenuItems({ actions }, true)?.map((it) => it.key)).toEqual(["rerun", "stop", "busy"]);
    expect(rowMenuItems({ actions, menu }, true)).toEqual([
      { key: "rerun", label: "Rerun", action: { event: "rerun" } },
      { key: "stop", label: "Stop", action: { event: "stop" }, disabled: true, danger: true },
      { key: "busy", label: "Busy", action: { event: "busy" }, disabled: true },
      { separator: true },
      ...menu.items,
    ]);
    expect(buttonItem(btn("x", "X", { style: "attention" }))).toEqual({ key: "x", label: "X", action: { event: "x" } });
  });
});

describe("a menu's blocks", () => {
  it("joins a group's adjacent items, nests a submenu and keeps separators between items", () => {
    const blocks = menuBlocks(JIRA);
    expect(blocks.map((b) => b.kind)).toEqual(["item", "item", "separator", "sub", "separator", "item", "item", "separator", "item"]);
    const sub = blocks[3];
    if (sub?.kind !== "sub") throw new Error("not a submenu");
    expect(sub.blocks).toEqual([{ kind: "group", group: "status", value: "review", items: JIRA[3]?.submenu?.map((it) => ({ ...it, key: it.key })) }]);
  });

  it("drops separators at the ends and in a row, keyless items and a second level", () => {
    const blocks = menuBlocks([{ separator: true }, item("a", "A"), { separator: true }, { separator: true }, { label: "no key" }, item("b", "B"), { key: "s", label: "S", submenu: [item("c", "C"), { key: "s2", label: "Deep", submenu: [item("d", "D")] }] }, { separator: true }]);
    expect(blocks.map((b) => (b.kind === "separator" ? "---" : b.kind === "sub" ? `${b.item.key}:${b.blocks.map((x) => (x.kind === "item" ? x.item.key : x.kind)).join()}` : b.kind === "item" ? b.item.key : b.kind))).toEqual(["a", "---", "b", "s:c"]);
  });

  it("splits a group that comes back after another item into two groups", () => {
    const blocks = menuBlocks([item("a", "A", { group: "g" }), item("x", "X"), item("b", "B", { group: "g", checked: true })]);
    expect(blocks.map((b) => (b.kind === "group" ? `${b.group}=${b.value}` : b.kind))).toEqual(["g=", "item", "g=b"]);
  });

  it("lists the keys its items act with", () => {
    expect(menuKeys(JIRA)).toEqual(["start", "send", "todo", "review", "done", "open", "copy", "delete"]);
  });

  it.each([
    [{ key: "ContextMenu", shiftKey: false }, true],
    [{ key: "F10", shiftKey: true }, true],
    [{ key: "F10", shiftKey: false }, false],
    [{ key: "F10", shiftKey: true, metaKey: true }, false],
    [{ key: "Enter", shiftKey: false }, false],
  ])("the context menu key %o: %s", (e, want) => {
    expect(isContextMenuKey({ metaKey: false, ctrlKey: false, altKey: false, ...e })).toBe(want);
  });
});

describe("a row's menu", () => {
  const row: Row = { key: "CF-407", title: "Plugin menus: fold actions by width", action: { event: "open", data: "CF-407" }, menu: { items: JIRA } };

  it("shows a ⋯ More options whose menu lists the items in order", () => {
    inView(<NodeList nodes={[list([row])]} />);
    const menu = openMore();
    expect(entries(menu)).toEqual(["Start a thread on this", "Send to this thread", "---", "Move to ▸", "---", "Open in Jira", "Copy key", "---", "Delete"]);
    const del = within(menu).getByText("Delete").closest('[role="menuitem"]');
    expect(del?.getAttribute("data-variant")).toBe("destructive");
    expect(del?.hasAttribute("data-disabled")).toBe(true);
  });

  it("opens the submenu with its one-pick group, the checked item checked", () => {
    inView(<NodeList nodes={[list([row])]} />);
    const menu = openMore();
    fireEvent.keyDown(within(menu).getByTestId("plugin-menu-sub"), { key: "ArrowRight" });
    const sub = screen.getByTestId("plugin-menu-submenu");
    expect(entries(sub)).toEqual(["To do", "✓ In review", "Done"]);
    expect(within(sub).getByText("In review").closest('[role="menuitemradio"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    ["an event item acts on the plugin with its key", "start", () => host.acts.map((a) => a.key), ["start"]],
    ["a command item runs the command", "send", () => host.commands.map((c) => c.slice(0, 4)), [["w", "send", "thread.send", { text: "CF-407" }]]],
    ["a URL item opens it", "open", () => host.urls, ["https://jira.example.com/CF-407"]],
    ["a copy item copies", "copy", () => host.copies, ["CF-407"]],
  ] as const)("%s, not the row's own action", async (_, key, got, want) => {
    inView(<NodeList nodes={[list([row])]} />);
    await pick(openMore(), key);
    expect(got()).toEqual(want);
    if (key !== "start") expect(host.acts).toEqual([]);
    expect(screen.queryByTestId("plugin-more-menu")).toBeNull();
  });

  it("acts with a submenu's group item's key", async () => {
    inView(<NodeList nodes={[list([row])]} />);
    const menu = openMore();
    fireEvent.keyDown(within(menu).getByTestId("plugin-menu-sub"), { key: "ArrowRight" });
    await pick(screen.getByTestId("plugin-menu-submenu"), "done");
    expect(host.acts.map((a) => a.key)).toEqual(["done"]);
  });

  it("does nothing for a disabled item", async () => {
    inView(<NodeList nodes={[list([row])]} />);
    await pick(openMore(), "delete");
    expect(host.acts).toEqual([]);
  });

  it("opens the same menu on a right-click on the row", async () => {
    inView(<NodeList nodes={[list([row])]} />);
    fireEvent.contextMenu(screen.getByTestId("plugin-row"));
    const menu = screen.getByTestId("plugin-row-menu");
    expect(entries(menu)).toEqual(["Start a thread on this", "Send to this thread", "---", "Move to ▸", "---", "Open in Jira", "Copy key", "---", "Delete"]);
    await pick(menu, "start");
    expect(host.acts.map((a) => a.key)).toEqual(["start"]);
  });

  it.each([
    ["the ContextMenu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("opens it from the focused row with %s", (_, key) => {
    inView(<NodeList nodes={[list([row])]} />);
    const el = screen.getByTestId("plugin-row");
    el.focus();
    fireEvent.keyDown(el, key);
    expect(screen.getByTestId("plugin-row-menu")).toBeTruthy();
  });

  it("opens it with Shift+F10 from the ⋯ too (a row without its own action is not focusable)", () => {
    inView(<NodeList nodes={[list([{ ...row, action: undefined }])]} />);
    const more = screen.getByRole("button", { name: "More options" });
    expect(screen.getByTestId("plugin-row").tabIndex).toBe(-1);
    fireEvent.keyDown(more, { key: "F10", shiftKey: true });
    expect(screen.getByTestId("plugin-row-menu")).toBeTruthy();
  });

  it("has no ⋯ and no right-click menu without a menu or folded buttons", () => {
    inView(<NodeList nodes={[list([{ key: "r", title: "Plain", actions: [btn("rerun", "Rerun")] }])]} />);
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("plugin-row"));
    expect(screen.queryByTestId("plugin-row-menu")).toBeNull();
  });

  it("is inert while the plugin is down", () => {
    inView(<NodeList nodes={[list([row])]} />, { ...ctx, inert: true });
    expect(screen.getByRole("button", { name: "More options" })).toHaveProperty("disabled", true);
    fireEvent.contextMenu(screen.getByTestId("plugin-row"));
    expect(screen.queryByTestId("plugin-row-menu")).toBeNull();
  });

  it("spins its ⋯ while a picked item's act is in flight", () => {
    usePluginSurfacesStore.setState({ pending: { w: { review: true } } } as never);
    inView(<NodeList nodes={[list([row])]} />);
    expect(screen.getByRole("button", { name: "More options" }).querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("folding a row's buttons (sketch C)", () => {
  const actions = [btn("rerun", "Rerun", { icon: "rotate-ccw" }), btn("log", "Open log"), btn("send", "Send to thread")];
  const row: Row = { key: "b5", title: "Build #5", actions, menu: { items: [item("open", "Open in CI"), item("copy-link", "Copy link")] } };

  it("keeps the buttons on a wide row and its ⋯ holds only the menu", () => {
    rowWidth(700);
    inView(<NodeList nodes={[list([row])]} />);
    expect(screen.getByTestId("plugin-row").hasAttribute("data-folded")).toBe(false);
    expect(screen.getAllByTestId("plugin-button").map((b) => b.textContent)).toEqual(["Rerun", "Open log", "Send to thread"]);
    expect(entries(openMore())).toEqual(["Open in CI", "Copy link"]);
  });

  it("folds them into the ⋯ of a narrow row: buttons first, a separator, the menu", async () => {
    rowWidth(400);
    inView(<NodeList nodes={[list([row])]} />);
    expect(screen.getByTestId("plugin-row").hasAttribute("data-folded")).toBe(true);
    expect(screen.queryAllByTestId("plugin-button")).toEqual([]);
    const menu = openMore();
    expect(entries(menu)).toEqual(["Rerun", "Open log", "Send to thread", "---", "Open in CI", "Copy link"]);
    await pick(menu, "log");
    expect(host.acts.map((a) => a.key)).toEqual(["log"]);
  });

  it("gives a narrow row with buttons and no menu a ⋯ of its buttons", () => {
    rowWidth(400);
    inView(<NodeList nodes={[list([{ ...row, menu: undefined }])]} />);
    expect(entries(openMore())).toEqual(["Rerun", "Open log", "Send to thread"]);
  });

  it("folds a dense row's labelled buttons, whatever its width", () => {
    rowWidth(900);
    inView(<NodeList nodes={[list([{ ...row, menu: undefined }], true)]} />);
    expect(entries(openMore())).toEqual(["Rerun", "Open log", "Send to thread"]);
  });
});

describe("the header's actions", () => {
  it("draws one with an icon icon-only, and one without as a small labelled button", () => {
    inView(<SurfaceHeader header={{ title: "Jenkins", actions: [btn("refresh", "Refresh", { icon: "refresh-cw" }), btn("rerun", "Rerun failed")] }} fallbackTitle="Jenkins" icon="hammer" />);
    const [refresh, rerun] = within(screen.getByTestId("plugin-subline")).getAllByTestId("plugin-button");
    expect(refresh?.getAttribute("aria-label")).toBe("Refresh");
    expect(refresh?.textContent).toBe("");
    expect(rerun?.getAttribute("aria-label")).toBeNull();
    expect(rerun?.textContent).toBe("Rerun failed");
    expect(rerun?.getAttribute("data-size")).toBe("xs");
  });
});

describe("the header's ⋯", () => {
  it("follows its actions and acts with the item's key", async () => {
    inView(<SurfaceHeader header={{ title: "Jenkins", actions: [btn("refresh", "Refresh", { icon: "refresh-cw", iconOnly: true })], menu: { items: [item("rebuild-all", "Rebuild all"), { separator: true }, item("settings", "Settings")] } }} fallbackTitle="Jenkins" icon="hammer" />);
    const more = screen.getByTestId("plugin-header-more");
    expect(more.getAttribute("aria-label")).toBe("More options");
    expect(screen.getByTestId("plugin-subline").lastElementChild?.lastElementChild).toBe(more);
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = screen.getByTestId("plugin-header-more-menu");
    expect(entries(menu)).toEqual(["Rebuild all", "---", "Settings"]);
    await pick(menu, "settings");
    expect(host.acts.map((a) => a.key)).toEqual(["settings"]);
  });

  it("shows on a header without a subline or actions", () => {
    inView(<SurfaceHeader header={{ title: "Jenkins", menu: { items: [item("a", "A")] } }} fallbackTitle="Jenkins" icon="hammer" />);
    expect(screen.getByTestId("plugin-header-more")).toBeTruthy();
  });
});

describe("a menu button", () => {
  const rebuild: ViewButton = { key: "rebuild", label: "Rebuild", style: "outline", menu: { items: [item("rebuild-1", "Rebuild"), item("rebuild-params", "Rebuild with parameters")] } };

  it("shows a chevron and opens its menu; a pick acts with the item's key", async () => {
    inView(<NodeList nodes={[{ key: "bar", actions: { buttons: [rebuild] } }]} />);
    const b = screen.getByRole("button", { name: "Rebuild" });
    expect(within(b).getByTestId("plugin-button-chevron")).toBeTruthy();
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.pointerDown(b, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = screen.getByTestId("plugin-button-rebuild-menu");
    expect(entries(menu)).toEqual(["Rebuild", "Rebuild with parameters"]);
    await pick(menu, "rebuild-params");
    expect(host.acts.map((a) => a.key)).toEqual(["rebuild-params"]);
  });

  it("opens nothing while disabled", () => {
    inView(<NodeList nodes={[{ key: "bar", actions: { buttons: [{ ...rebuild, disabled: true }] } }]} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Rebuild" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    expect(screen.queryByTestId("plugin-button-rebuild-menu")).toBeNull();
  });

  it("an icon-only menu button has no chevron", () => {
    inView(<NodeList nodes={[{ key: "bar", actions: { buttons: [{ ...rebuild, icon: "hammer", iconOnly: true }] } }]} />);
    expect(screen.queryByTestId("plugin-button-chevron")).toBeNull();
  });
});
