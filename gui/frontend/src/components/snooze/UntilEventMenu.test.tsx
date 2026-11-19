import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { MenuKit } from "@/components/thread/menuKit";
import { useSettingsStore } from "@/stores/settings";
import { useSnoozeEventPickerStore } from "@/stores/snoozeEvents";
import { useThreadsStore } from "@/stores/threads";
import { useViewsStore } from "@/stores/views";
import { SnoozePresetItems } from "./SnoozeMenu";
import { SnoozeEventPicker } from "./SnoozeEventPicker";

const runs: { name: string; args: Record<string, string>; thread: string }[] = [];
let events = "{}";
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  runCommandForResult: (name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string } } = {}) => {
    runs.push({ name, args, thread: opts.ctx?.activeThreadId ?? "" });
    return Promise.resolve({ message: "", resultJson: name === "thread.snooze.events" ? events : "" });
  },
  runCommand: (name: string, args: Record<string, string>, ctx: { activeThreadId?: string }) => {
    runs.push({ name, args, thread: ctx.activeThreadId ?? "" });
    return Promise.resolve(true);
  },
}));

/** Plain parts: the menus' Radix items are not what these tests read. */
function Item({ onSelect, children, ...rest }: { onSelect: () => void; children?: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  );
}
const Plain = ({ children, ...rest }: { children?: ReactNode; className?: string }) => <div {...rest}>{children}</div>;
const kit: MenuKit = { Item, Separator: () => <hr />, Shortcut: Plain, Label: (p) => <div data-testid="menu-label">{p.children}</div>, Sub: Plain, SubTrigger: Plain, SubContent: Plain, promptAfterInPlace: false, rowInView: true };

const ALL = ["checks_done", "review", "merged", "comment", "head_pushed", "closed", "review_requested"];
const pr = (number: number, title: string, conditions = ALL) => ({ target: `acme/web#${String(number)}`, number, title, conditions });

function setEvents(o: { pullRequests?: unknown[]; plugins?: unknown[]; recentPlugins?: string[] }): void {
  events = JSON.stringify(o);
}

function setChecked(v: string | undefined): void {
  useSettingsStore.setState({ snapshot: { values: v === undefined ? {} : { "threads.snooze_events": v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
}

/** The submenu as lines: a label line's text, or an item's event key. */
function lines(): string[] {
  const menu = screen.getByTestId("snooze-events");
  return [...menu.querySelectorAll<HTMLElement>("[data-testid=menu-label], [data-testid=snooze-event], [data-testid=snooze-more-events], [data-testid=snooze-choose-events]")].map(
    (el) => (el.dataset.testid === "menu-label" ? `label ${el.textContent}` : (el.dataset.event ?? el.textContent)),
  );
}

beforeEach(() => {
  runs.length = 0;
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", name: "Fix login", savedAtMs: null, projectId: "", worktreePath: "/tmp/x", projectIds: [], checkoutPaths: [] } as unknown as ThreadView }, order: ["s-1"] });
  setChecked(undefined);
});

afterEach(() => {
  cleanup();
});

describe("Until event", () => {
  it("lists up to three pull requests, each a label line over its checked events, then up to three plugin events, then the two links", async () => {
    setEvents({
      pullRequests: [pr(812, "Fix login"), pr(790, "Docs", ["merged", "comment"]), pr(700, "Old", ["comment"]), pr(650, "Cache"), pr(600, "Fourth")],
      plugins: [
        { target: "hello/tick", title: "Tick", pluginName: "Hello" },
        { target: "doc-preview/deploy", title: "Preview deployed", pluginName: "Doc Preview" },
        { target: "disk-watch/low", title: "Disk low", pluginName: "Disk Watch" },
        { target: "test-watcher/tests-finished", title: "Tests finished", pluginName: "Test Watcher" },
      ],
      recentPlugins: ["test-watcher/tests-finished"],
    });
    setChecked("checks_done review merged plugin:hello/tick plugin:disk-watch/low plugin:doc-preview/deploy");
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={() => <hr />} kit={kit} />);
    await screen.findByTestId("snooze-until-event");
    expect(lines()).toEqual([
      "label #812Fix login",
      "acme/web#812 checks_done",
      "acme/web#812 review",
      "acme/web#812 merged",
      "label #790Docs",
      "acme/web#790 merged",
      "label #650Cache",
      "acme/web#650 checks_done",
      "acme/web#650 review",
      "acme/web#650 merged",
      "label Plugins",
      // The recent one, then the checked ones in the daemon's order: disk-watch/low is past three.
      "test-watcher/tests-finished",
      "hello/tick",
      "doc-preview/deploy",
      "More events…",
      "Choose what shows here…",
    ]);
    // The plugin's name on the right of its event.
    const first = screen.getAllByTestId("snooze-event").find((b) => b.dataset.event === "doc-preview/deploy");
    expect(within(first as HTMLElement).getByTestId("snooze-event-plugin").textContent).toBe("Doc Preview");
    expect(runs[0]).toEqual({ name: "thread.snooze.events", args: { id: "s-1" }, thread: "s-1" });
  });

  it("is hidden when the thread has nothing to wait on, and in the bulk menu", async () => {
    setEvents({ pullRequests: [pr(812, "Fix login", [])] });
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={() => <hr />} kit={kit} />);
    await waitFor(() => {
      expect(runs.some((r) => r.name === "thread.snooze.events")).toBe(true);
    });
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("snooze-until-event")).toBeNull();
    cleanup();
    runs.length = 0;
    setEvents({ pullRequests: [pr(812, "Fix login")] });
    render(<SnoozePresetItems id="s-1" ids={["s-1", "s-2"]} Item={Item} Separator={() => <hr />} kit={kit} />);
    await act(() => Promise.resolve());
    expect(screen.queryByTestId("snooze-until-event")).toBeNull();
    expect(runs).toEqual([]);
  });

  it("keeps More events when nothing is checked", async () => {
    setEvents({ pullRequests: [pr(812, "Fix login")], plugins: [{ target: "hello/tick", title: "Tick", pluginName: "Hello" }] });
    setChecked("none");
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={() => <hr />} kit={kit} />);
    await screen.findByTestId("snooze-until-event");
    expect(lines()).toEqual(["More events…", "Choose what shows here…"]);
  });

  it("snoozes until the event picked with thread.snooze", async () => {
    setEvents({ pullRequests: [pr(812, "Fix login")], plugins: [{ target: "hello/tick", title: "Tick", pluginName: "Hello", args: { every: "10s" } }], recentPlugins: ["hello/tick"] });
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={() => <hr />} kit={kit} />);
    await screen.findByTestId("snooze-until-event");
    const items = screen.getAllByTestId("snooze-event");
    fireEvent.click(items.find((b) => b.dataset.event === "acme/web#812 merged") as HTMLElement);
    fireEvent.click(items.find((b) => b.dataset.event === "hello/tick") as HTMLElement);
    expect(runs.slice(1)).toEqual([
      { name: "thread.snooze", args: { "until-pr": "acme/web#812", on: "merged" }, thread: "s-1" },
      { name: "thread.snooze", args: { "until-plugin": "hello/tick", arg: "every=10s" }, thread: "s-1" },
    ]);
  });

  it("opens More events, and Settings at its section", async () => {
    setEvents({ pullRequests: [pr(812, "Fix login")] });
    render(<SnoozePresetItems id="s-1" Item={Item} Separator={() => <hr />} kit={kit} />);
    fireEvent.click(await screen.findByTestId("snooze-more-events"));
    await waitFor(() => {
      expect(useSnoozeEventPickerStore.getState()).toMatchObject({ open: true, threadId: "s-1" });
    });
    fireEvent.click(screen.getByTestId("snooze-choose-events"));
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "general" });
  });
});

describe("More events", () => {
  it("lists every event; typing filters; Enter snoozes until the one under the cursor", async () => {
    setEvents({
      pullRequests: [pr(812, "Fix login", ["checks_done", "merged", "comment"]), pr(790, "Docs", ["merged"])],
      plugins: [{ target: "doc-preview/deploy", title: "Preview deployed", pluginName: "Doc Preview" }],
    });
    useSnoozeEventPickerStore.setState({ open: true, threadId: "s-1", inView: true, seq: 1 });
    render(<SnoozeEventPicker />);
    await waitFor(() => {
      expect(screen.getAllByTestId("snooze-event-row")).toHaveLength(5);
    });
    const filter = screen.getByTestId("snooze-event-filter");
    fireEvent.change(filter, { target: { value: "812 merged" } });
    await waitFor(() => {
      expect(screen.getAllByTestId("snooze-event-row").map((r) => r.dataset.event)).toEqual(["pr:acme/web#812:merged"]);
    });
    fireEvent.change(filter, { target: { value: "deploy" } });
    await waitFor(() => {
      expect(screen.getAllByTestId("snooze-event-row").map((r) => r.dataset.event)).toEqual(["plugin:doc-preview/deploy"]);
    });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(runs.at(-1)).toEqual({ name: "thread.snooze", args: { "until-plugin": "doc-preview/deploy" }, thread: "s-1" });
    expect(useSnoozeEventPickerStore.getState().open).toBe(false);
  });
});
