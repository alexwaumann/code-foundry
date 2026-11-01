import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginView, SurfaceUpdateView } from "@/api/plugin";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { SidePanel } from "@/components/panel/SidePanel";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { applyIntent } from "@/stores/intents";
import { activeTab, getPanel, makeTab, openSurface, usePanelStore, type Tab } from "@/stores/panel";
import { applyPluginEvent, usePluginsStore } from "@/stores/plugins";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useUiStore } from "@/stores/ui";
import { confirmFirst, daemon, invocationsOf, resetDaemon } from "@/test/daemonFakes";
import { demoView, type DemoTab } from "@/test/pluginFixtures";
import { push, resetSurfaces, surfaces } from "@/test/pluginSurfaceFakes";
import { seedWorld } from "@/test/projectsWorld";
import { PluginSurface } from "./PluginSurface";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/plugin", async (orig) => ({ ...(await orig<typeof import("@/api/plugin")>()), ...(await import("@/test/pluginSurfaceFakes")).surfaceFakes }));

/**
 * One plugin surface tab over the hello demo's captured views (src/test/pluginFixtures.ts),
 * its WatchSurface faked (src/test/pluginSurfaceFakes.ts): the header, tabs and tab title,
 * acts and command buttons, a log's appended lines, the plugin going down, and the intents
 * a plugin sends (InvokeCommand, ShowView). What the hello plugin answers to an act (its
 * next view) is the plugin's, not the GUI's.
 */

const hello = {
  name: "hello",
  displayName: "Hello",
  surfaces: [
    { id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread", when: "", showCommand: "plugin.hello.show.demo", kind: "plugin.hello.demo" },
    { id: "pinned", title: "Hello Pinned", icon: "pin", scope: "thread", when: "", showCommand: "plugin.hello.show.pinned", kind: "plugin.hello.pinned" },
  ],
} as unknown as PluginView;

const command = (name: string, title: string): CommandView => ({ name, title, description: "", category: "Hello", args: [], keybindings: [], available: true });
const INSTANCE = "hello/demo/thread:s-3";

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Thread s-3 selected, its panel showing the hello demo, the plugin's first view sent. */
async function openDemo(view: DemoTab = "overview"): Promise<Tab> {
  const tab = makeTab("plugin.hello.demo", "Hello Demo");
  act(() => {
    openSurface("current", tab);
  });
  render(
    <>
      <PluginSurface tab={tab} />
      <ConfirmDialog />
    </>,
  );
  await tick();
  await send({ kind: "state", instance: INSTANCE, phase: "live", message: "", pluginState: "running" }, { kind: "view", instance: INSTANCE, version: 1, view: demoView(view), hostRendered: false });
  await waitFor(() => {
    expect(screen.getByTestId("plugin-surface").dataset.phase).toBe("live");
  });
  return tab;
}

/** Updates down the surface's stream, as the plugin host sends them. */
async function send(...updates: SurfaceUpdateView[]): Promise<void> {
  act(() => {
    push(updates);
  });
  await tick();
}

const surface = () => screen.getByTestId("plugin-surface");
const byKey = (testId: string, key: string) => surface().querySelector<HTMLElement>(`[data-testid="${testId}"][data-key="${key}"]`) as HTMLElement;

beforeEach(() => {
  resetDaemon();
  resetSurfaces();
  seedWorld();
  usePanelStore.setState({ byKey: {} });
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {} });
  usePluginsStore.setState(applyPluginEvent({ byName: {}, order: [], loaded: false, epoch: 0, dirs: null }, { kind: "snapshot", plugins: [hello] }));
  act(() => {
    useUiStore.getState().select({ kind: "thread", id: "s-3" });
  });
  const sel = useUiStore.getState().selection;
  // The daemon's list for this context (a command run reads it again).
  daemon.commands = [command("plugin.hello.show.demo", "Show Hello Demo"), command("plugin.hello.greet", "Greet"), command("plugin.hello.forget", "Forget")];
  useCommandsStore.setState({ commands: daemon.commands, contextKey: contextKey(getUiContext(sel)) });
});

afterEach(cleanup);

describe("PluginSurface", () => {
  it("opens live with the view's header and tabs; the panel tab takes the view's title", async () => {
    await openDemo();
    expect(within(surface()).getByTestId("plugin-title").textContent).toBe("Hello demo");
    expect(within(surface()).getByTestId("plugin-subline").textContent).toContain("thread s-");
    expect(byKey("plugin-tab", "overview").getAttribute("aria-selected")).toBe("true");
    expect(activeTab(getPanel("current"))?.title).toBe("Hello");
    expect(within(surface()).getByTestId("plugin-body")).toBeTruthy();
    // One WatchSurface for the tab, with the panel's thread.
    expect(surfaces.streams.map((s) => [s.ref.plugin, s.ref.surface, s.ref.context.activeThreadId])).toEqual([["hello", "demo", "s-3"]]);
  });

  it("a button sends an act on the version on screen with the panel's thread; a command button runs it there; a destructive one asks in the daemon's words", async () => {
    await openDemo();
    fireEvent.click(byKey("plugin-button", "click"));
    await tick();
    expect(surfaces.acts.map((a) => [a.instance, a.version, a.key, a.context?.activeThreadId])).toEqual([[INSTANCE, 1, "click", "s-3"]]);

    fireEvent.click(byKey("plugin-button", "greet"));
    await tick();
    expect(invocationsOf("plugin.hello.greet").map((i) => [i.args.name, i.context.activeThreadId])).toEqual([["panel", "s-3"]]);

    confirmFirst("plugin.hello.forget", "Forget the remembered word?");
    fireEvent.click(byKey("plugin-button", "forget"));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Forget the remembered word?");
    fireEvent.click(within(dialog).getByTestId("confirm-cancel"));
    await tick();
    expect(invocationsOf("plugin.hello.forget").map((i) => i.confirmed)).toEqual([false]);
  });

  it("a tab is a choice sent to the plugin; the log tab draws its tones and the lines the plugin appends", async () => {
    await openDemo();
    fireEvent.click(byKey("plugin-tab", "log"));
    await tick();
    expect(surfaces.acts.at(-1)).toMatchObject({ instance: INSTANCE, version: 1, key: "log" });
    // Read as active while the choice is pending.
    expect(byKey("plugin-tab", "log").getAttribute("aria-selected")).toBe("true");
    await send({ kind: "view", instance: INSTANCE, version: 2, view: demoView("log"), hostRendered: false });
    const lint = screen.getAllByTestId("plugin-log")[1] as HTMLElement;
    expect(lint.querySelector('[data-tone="attention"]')?.textContent).toBe("warning: unused variable x");
    expect(lint.querySelector('[data-tone="error"]')?.textContent).toBe("error: missing return");
    fireEvent.click(byKey("plugin-button", "log-start"));
    await tick();
    expect(surfaces.acts.at(-1)).toMatchObject({ version: 2, key: "log-start" });
    const steps = ["fetching sources", "resolving", "compiling", "linking", "testing", "done"];
    await send(...steps.map((s, i): SurfaceUpdateView => ({ kind: "append", instance: INSTANCE, version: 2, key: "build-log", text: `[${String(i + 1)}/6] ${s}\n`, lines: [] })));
    const build = screen.getAllByTestId("plugin-log-box")[0] as HTMLElement;
    expect(build.textContent).toContain("[1/6] fetching sources");
    expect(build.textContent).toContain("[6/6] done");
    expect(build.dataset.lines).toBe("6");
  });

  it("the form checks on the host, keeps its drafts across tabs, submits its values; a stored secret is not echoed", async () => {
    await openDemo("form");
    const form = () => within(surface()).getByTestId("plugin-form");
    const field = (name: string, testId = "plugin-input") => form().querySelector<HTMLInputElement>(`[data-testid="${testId}"][data-name="${name}"]`) as HTMLInputElement;
    const error = (name: string) => form().querySelector(`[data-testid="plugin-field"][data-name="${name}"] [data-testid="plugin-field-error"]`)?.textContent ?? null;
    const save = () => form().querySelector<HTMLElement>('[data-testid="plugin-button"][data-key="f-save"]') as HTMLElement;
    // Required: the host refuses before the plugin hears of it.
    fireEvent.click(save());
    await tick();
    expect(error("name")).toBe("Required");
    expect(surfaces.acts.filter((a) => a.key === "f-save")).toEqual([]);
    fireEvent.change(field("name"), { target: { value: "Ada1" } });
    fireEvent.blur(field("name"));
    expect(error("name")).toBe("Letters and spaces only");
    fireEvent.change(field("name"), { target: { value: "Ada" } });
    // A draft survives a trip to another tab and back (the plugin's views for each).
    await send({ kind: "view", instance: INSTANCE, version: 2, view: demoView("overview"), hostRendered: false });
    await send({ kind: "view", instance: INSTANCE, version: 3, view: demoView("form"), hostRendered: false });
    expect(field("name").value).toBe("Ada");
    fireEvent.change(field("token"), { target: { value: "tok-123" } });
    // Multiple without a style: a dropdown over a checklist.
    fireEvent.click(field("tags", "plugin-select"));
    const options = await screen.findByTestId("plugin-select-options");
    fireEvent.click(options.querySelector('[data-value="b"]') as HTMLElement);
    fireEvent.keyDown(options, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("plugin-select-options")).toBeNull();
    });
    expect(field("tags", "plugin-select").textContent).toContain("Alpha, Beta");
    fireEvent.click(field("notifyDone", "plugin-toggle"));
    fireEvent.click(save());
    await tick();
    const sent = surfaces.acts.filter((a) => a.key === "f-save");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.values).toMatchObject({ name: "Ada", token: "tok-123", env: "dev", tags: ["a", "b"], notifyFail: true, notifyDone: true });
    // The plugin took it; its next view says the secret is stored: the field is empty again and says so.
    const next = demoView("form");
    const stored = JSON.parse(JSON.stringify(next).replace('"kind":"secret"', '"kind":"secret","hasValue":true')) as typeof next;
    await send({ kind: "view", instance: INSTANCE, version: 4, view: stored, hostRendered: false });
    expect(field("token").value).toBe("");
    expect(field("token").placeholder).toBe("Saved · type to replace");
  });

  it("the layout tab: Enter in the toolbar's search sends it, a chip acts, the footer's Clear acts once enabled and a new reset token drops the draft; another tab has no strips", async () => {
    await openDemo("layout");
    const toolbar = () => within(surface()).getByTestId("plugin-toolbar");
    const footer = () => within(surface()).getByTestId("plugin-footer");
    const input = () => within(toolbar()).getByTestId<HTMLInputElement>("plugin-input");
    expect(input().placeholder).toBe("Filter runs");
    fireEvent.change(input(), { target: { value: "fix" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await tick();
    expect(surfaces.acts.at(-1)).toMatchObject({ instance: INSTANCE, key: "layout-search", values: { q: "fix" } });
    fireEvent.click(toolbar().querySelector('[data-testid="plugin-chip"][data-key="layout-st-failed"]') as HTMLElement);
    await tick();
    expect(surfaces.acts.at(-1)).toMatchObject({ key: "layout-st-failed" });
    // The plugin's next view: the search it took as the field's value, the failed chip selected, Clear enabled.
    const filtered = demoView("layout");
    const v2 = JSON.parse(
      JSON.stringify(filtered)
        .replace('"placeholder":"Filter runs"', '"placeholder":"Filter runs","value":"fix"')
        .replace('"selected":true,', "")
        .replace('"key":"layout-st-failed",', '"key":"layout-st-failed","selected":true,')
        .replace('"label":"Clear filter","action":{"event":"layout-clear"},"disabled":true', '"label":"Clear filter","action":{"event":"layout-clear"}'),
    ) as typeof filtered;
    await send({ kind: "view", instance: INSTANCE, version: 2, view: v2, hostRendered: false });
    expect(toolbar().querySelector('[data-key="layout-st-failed"]')?.getAttribute("data-selected")).toBe("true");
    expect(input().value).toBe("fix");
    const clear = () => footer().querySelector<HTMLButtonElement>('[data-testid="plugin-button"][data-key="layout-clear"]') as HTMLButtonElement;
    expect(clear().disabled).toBe(false);
    fireEvent.click(clear());
    await tick();
    expect(surfaces.acts.at(-1)).toMatchObject({ key: "layout-clear" });
    // Cleared: the plugin's view with a new reset token for the search drops its draft, Clear disabled again.
    const v3 = JSON.parse(JSON.stringify(demoView("layout")).replace('"resetToken":"0"', '"resetToken":"1"')) as typeof filtered;
    await send({ kind: "view", instance: INSTANCE, version: 3, view: v3, hostRendered: false });
    expect(input().value).toBe("");
    expect(clear().disabled).toBe(true);
    // Another view tab brings its own strips: none.
    await send({ kind: "view", instance: INSTANCE, version: 4, view: demoView("overview"), hostRendered: false });
    expect(within(surface()).queryByTestId("plugin-toolbar")).toBeNull();
    expect(within(surface()).queryByTestId("plugin-footer")).toBeNull();
  });

  it("a plugin that goes down keeps its last view dimmed and offers a restart; back up, it is live", async () => {
    await openDemo();
    await send({ kind: "state", instance: INSTANCE, phase: "plugin-down", message: "", pluginState: "crashed" });

    expect(within(surface()).getByTestId("plugin-down").textContent).toContain("Hello crashed");
    expect(within(surface()).getByTestId("plugin-body").dataset.stale).toBe("true");
    fireEvent.click(within(surface()).getByTestId("plugin-restart"));
    await tick();
    expect(invocationsOf("plugin.restart").map((i) => i.args)).toEqual([{ name: "hello" }]);
    await send({ kind: "state", instance: INSTANCE, phase: "live", message: "", pluginState: "running" });
    expect(within(surface()).queryByTestId("plugin-down")).toBeNull();
    expect(surface().dataset.phase).toBe("live");
  });
});

describe("the side panel's surface list", () => {
  it("lists the available plugin surfaces below the built-ins; one the daemon makes available (Pin) joins, and opens", () => {
    usePanelStore.setState({ byKey: { "thread:s-3": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
    useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
    render(<SidePanel />);
    const empty = screen.getByTestId("panel-empty");
    const plugins = within(empty).getByTestId("panel-plugin-surfaces");
    const kinds = () => [...plugins.querySelectorAll<HTMLElement>("[data-surface]")].map((e) => e.dataset.surface);
    expect(kinds()).toEqual(["plugin.hello.demo"]);
    expect(plugins.querySelector('[data-surface="plugin.hello.demo"]')?.textContent).toMatch(/Hello Demo/);
    // Below the built-ins.
    const builtIn = empty.querySelector('[data-surface="files"]') as HTMLElement;
    expect(builtIn.compareDocumentPosition(plugins)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Pinned (the plugin's act; its show command is available for this thread now).
    act(() => {
      useCommandsStore.setState((st) => ({ commands: [...st.commands, command("plugin.hello.show.pinned", "Show Hello Pinned")] }));
    });
    expect(kinds()).toEqual(["plugin.hello.demo", "plugin.hello.pinned"]);
    fireEvent.click(plugins.querySelector('[data-surface="plugin.hello.pinned"]') as HTMLElement);
    expect(activeTab(getPanel("current"))?.kind).toBe("plugin.hello.pinned");
  });
});

describe("a plugin's intents", () => {
  it("ShowView with a thread opens the surface in that thread's panel", () => {
    act(() => {
      applyIntent({ kind: "showView", name: "panel.plugin.hello.demo?thread=s-4" });
    });
    const e = usePanelStore.getState().byKey["thread:s-4"];
    expect(e?.open).toBe(true);
    expect(e && activeTab(e)?.kind).toBe("plugin.hello.demo");
  });

  it("InvokeCommand runs the command through the confirm dialog, naming the plugin; OK runs it confirmed", async () => {
    render(<ConfirmDialog />);
    confirmFirst("plugin.hello.forget", "Forget the remembered word?");
    act(() => {
      applyIntent({ kind: "invokeCommand", name: "plugin.hello.forget", args: {}, context: { ...getUiContext(), activeThreadId: "s-3" }, caller: "plugin:hello" });
    });
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Forget the remembered word?");
    expect(within(dialog).getByTestId("confirm-caller").textContent).toBe("Asked by Hello");
    fireEvent.click(within(dialog).getByTestId("confirm-ok"));
    await waitFor(() => {
      expect(invocationsOf("plugin.hello.forget").map((i) => [i.confirmed, i.context.activeThreadId])).toEqual([
        [false, "s-3"],
        [true, "s-3"],
      ]);
    });
  });
});
