/** The date field (pluginsdk/ui InputDate): its trigger, calendar, keys, quick picks, bounds and the acts it sends. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, Field, ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { tooltipText } from "@/test/tooltip";
import { ViewContext, type ViewCtx } from "./context";
import { DateControl } from "./DateControl";
import { moveFocus, weekStartOf } from "./date";
import { NodeList } from "./NodeList";
import { InStrip } from "./strip";

const acts: ActRequestView[] = [];

vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.push(req);
    return Promise.resolve();
  }),
}));

const ctx: ViewCtx = { watchKey: "w", instance: "p/s/global", plugin: "p", viewTab: "", uiContext: emptyContext } as ViewCtx;

function inView(children: ReactNode) {
  return render(<ViewContext.Provider value={ctx}>{children}</ViewContext.Provider>);
}

function form(field: Field, submit = false): ViewNode {
  return { key: "f", form: { fields: [field], ...(submit ? { submit: { key: "save", label: "Save", action: { event: "save" } } } : {}) } };
}

const due = (input: Partial<NonNullable<Field["input"]>> = {}, extra: Partial<Field> = {}): Field => ({
  key: "f-due",
  name: "due",
  label: "Due",
  input: { kind: "date", ...input },
  change: { event: "due" },
  ...extra,
});

const trigger = () => screen.getByTestId("plugin-date");
const popover = () => screen.getByTestId("plugin-date-popover");
const day = (iso: string) => popover().querySelector<HTMLElement>(`[role="gridcell"][data-day="${iso}"]`) as HTMLElement;
const tick = () => act(() => Promise.resolve());

async function open() {
  fireEvent.click(trigger());
  await screen.findByTestId("plugin-date-popover");
}

beforeEach(() => {
  acts.length = 0;
  // Wednesday 11 November 2026, 10:00 local.
  vi.useFakeTimers({ now: new Date(2026, 10, 11, 10), toFake: ["Date"] });
  usePluginSurfacesStore.setState({ watches: { w: { instance: "p/s/global", version: 1 } } } as never);
});

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, pending: {} } as never);
  vi.useRealTimers();
});

describe("the trigger", () => {
  it("shows the day short with the year only for another year, else the placeholder", () => {
    const { rerender } = render(<DateControl id="d" name="due" value="2026-11-14" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    expect(trigger().textContent).toBe("Sat, Nov 14");
    expect(trigger().getAttribute("data-value")).toBe("2026-11-14");
    rerender(<DateControl id="d" name="due" value="2027-01-04" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    expect(trigger().textContent).toBe("Mon, Jan 4, 2027");
    rerender(<DateControl id="d" name="due" value="" placeholder="No due date" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    expect(trigger().textContent).toBe("No due date");
    expect(trigger().className).toContain("text-cf-text-muted");
    rerender(<DateControl id="d" name="due" value="" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    expect(trigger().textContent).toBe("No date");
  });

  it("is named by its label and marked invalid and required", () => {
    inView(<NodeList nodes={[form(due({}, { required: true, error: "Pick a day" }))]} />);
    expect(screen.getByRole("button", { name: /Due/ })).toBe(trigger());
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(trigger().getAttribute("aria-required")).toBe("true");
  });
});

describe("the calendar", () => {
  it("opens on the value's month, the value filled and focused, today outlined", async () => {
    render(<DateControl id="d" name="due" value="2026-12-03" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    await open();
    expect(screen.getByTestId("plugin-date-month").textContent).toBe("December 2026");
    expect(day("2026-12-03").getAttribute("aria-selected")).toBe("true");
    expect(day("2026-12-03").className).toContain("bg-cf-accent");
    expect(document.activeElement).toBe(day("2026-12-03"));
    expect(day("2026-12-03").getAttribute("aria-label")).toBe("Thursday, December 3, 2026");
    // November's last days lead the first week, muted.
    expect(day("2026-11-30").className).toContain("text-cf-text-muted");
    fireEvent.click(screen.getByTestId("plugin-date-prev"));
    expect(screen.getByTestId("plugin-date-month").textContent).toBe("November 2026");
    expect(day("2026-11-11").getAttribute("data-today")).toBe("true");
    expect(day("2026-11-11").getAttribute("aria-current")).toBe("date");
    expect(day("2026-11-11").className).toContain("border-cf-border");
  });

  it("opens on today without a value", async () => {
    render(<DateControl id="d" name="due" value="" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    await open();
    expect(screen.getByTestId("plugin-date-month").textContent).toBe("November 2026");
    expect(document.activeElement).toBe(day("2026-11-11"));
    expect(popover().querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  });

  it("starts the week where the locale does", async () => {
    render(<DateControl id="d" name="due" value="" disabled={false} invalid={false} onPick={() => {}} locale="de-DE" />);
    await open();
    const heads = within(popover()).getAllByRole("columnheader");
    expect(heads).toHaveLength(7);
    // An engine without week info starts on Monday too.
    expect(heads[0]?.getAttribute("aria-label")).toBe("Montag");
    expect(screen.getByTestId("plugin-date-month").textContent).toBe("November 2026");
  });

  it("moves the focus with the keys, across months", async () => {
    render(<DateControl id="d" name="due" value="2026-11-14" disabled={false} invalid={false} onPick={() => {}} locale="en-GB" />);
    await open();
    const grid = within(popover()).getByRole("grid");
    const press = async (key: string) => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key });
      await tick();
    };
    await press("ArrowRight");
    expect(document.activeElement).toBe(day("2026-11-15"));
    await press("ArrowDown");
    expect(document.activeElement).toBe(day("2026-11-22"));
    await press("ArrowDown");
    await press("ArrowDown");
    // Into December: the month follows.
    expect(screen.getByTestId("plugin-date-month").textContent).toBe("December 2026");
    expect(document.activeElement).toBe(day("2026-12-06"));
    await press("PageUp");
    expect(document.activeElement).toBe(day("2026-11-06"));
    await press("ArrowUp");
    await press("ArrowLeft");
    expect(document.activeElement).toBe(day("2026-10-29"));
    expect(grid.isConnected).toBe(true);
    // One tab stop: the focused day.
    expect(popover().querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  });

  it("picks a day, closing the popover", async () => {
    const onPick = vi.fn();
    render(<DateControl id="d" name="due" value="2026-11-14" disabled={false} invalid={false} onPick={onPick} locale="en-US" />);
    await open();
    fireEvent.click(day("2026-11-20"));
    expect(onPick).toHaveBeenCalledWith("2026-11-20");
    await waitFor(() => {
      expect(screen.queryByTestId("plugin-date-popover")).toBeNull();
    });
    // Picking the day already set changes nothing.
    await open();
    fireEvent.click(day("2026-11-14"));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

describe("moveFocus", () => {
  it.each<[string, string, number, string | null]>([
    ["ArrowLeft", "2026-11-01", 1, "2026-10-31"],
    ["ArrowRight", "2026-11-30", 1, "2026-12-01"],
    ["ArrowUp", "2026-11-03", 1, "2026-10-27"],
    ["ArrowDown", "2026-11-28", 1, "2026-12-05"],
    ["PageUp", "2026-03-31", 1, "2026-02-28"],
    ["PageDown", "2026-01-31", 1, "2026-02-28"],
    // 2026-11-11 is a Wednesday.
    ["Home", "2026-11-11", 1, "2026-11-09"],
    ["End", "2026-11-11", 1, "2026-11-15"],
    ["Home", "2026-11-11", 0, "2026-11-08"],
    ["End", "2026-11-11", 0, "2026-11-14"],
    ["Enter", "2026-11-11", 1, null],
    ["a", "2026-11-11", 1, null],
  ])("%s from %s (week from %d)", (key, from, start, want) => {
    expect(moveFocus(key, from, start)).toBe(want);
  });
});

describe("quick picks", () => {
  it("lands on today, tomorrow and next Monday; the tooltips say the hidden days", async () => {
    const onPick = vi.fn();
    render(<DateControl id="d" name="due" value="2026-11-14" disabled={false} invalid={false} onPick={onPick} locale="en-US" />);
    await open();
    expect(screen.getByTestId("plugin-date-today").getAttribute("data-day")).toBe("2026-11-11");
    expect(screen.getByTestId("plugin-date-tomorrow").getAttribute("data-day")).toBe("2026-11-12");
    expect(screen.getByTestId("plugin-date-monday").getAttribute("data-day")).toBe("2026-11-16");
    expect(screen.getByTestId("plugin-date-monday").textContent).toBe("Mon");
    // The Tip sits on a span (a disabled pick still shows it).
    const tip = screen.getByTestId("plugin-date-monday").parentElement as HTMLElement;
    tip.tabIndex = 0;
    expect(tooltipText(tip)).toBe("Mon, Nov 16");
    fireEvent.click(screen.getByTestId("plugin-date-tomorrow"));
    expect(onPick).toHaveBeenLastCalledWith("2026-11-12");
  });

  it("clears, and Clear is off with nothing set", async () => {
    const onPick = vi.fn();
    const { rerender } = render(<DateControl id="d" name="due" value="2026-11-14" disabled={false} invalid={false} onPick={onPick} locale="en-US" />);
    await open();
    fireEvent.click(screen.getByTestId("plugin-date-clear"));
    expect(onPick).toHaveBeenLastCalledWith("");
    rerender(<DateControl id="d" name="due" value="" disabled={false} invalid={false} onPick={onPick} locale="en-US" />);
    await open();
    expect(screen.getByTestId("plugin-date-clear").hasAttribute("disabled")).toBe(true);
  });
});

describe("bounds", () => {
  it("disables the days, months and picks outside min..max, and keeps the focus inside", async () => {
    render(<DateControl id="d" name="due" value="" min="2026-11-12" max="2026-12-10" disabled={false} invalid={false} onPick={() => {}} locale="en-US" />);
    await open();
    // Today is before min: the focus starts on min.
    expect(document.activeElement).toBe(day("2026-11-12"));
    expect(day("2026-11-11").hasAttribute("disabled")).toBe(true);
    expect(day("2026-11-12").hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("plugin-date-prev").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("plugin-date-today").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("plugin-date-tomorrow").hasAttribute("disabled")).toBe(false);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    await tick();
    expect(document.activeElement).toBe(day("2026-11-12"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "PageDown" });
    await tick();
    // Dec 12 is past max: the focus stops on max.
    expect(document.activeElement).toBe(day("2026-12-10"));
    expect(screen.getByTestId("plugin-date-next").hasAttribute("disabled")).toBe(true);
    expect(day("2026-12-11").hasAttribute("disabled")).toBe(true);
  });
});

describe("in a form", () => {
  it("sends a change act for each pick, with the form's values", async () => {
    inView(<NodeList nodes={[{ key: "f", form: { fields: [due({ value: "2026-11-14" }), { key: "f-t", name: "title", input: { value: "Ship" } }] } }]} />);
    await open();
    fireEvent.click(day("2026-11-20"));
    await tick();
    expect(acts.map((a) => [a.key, a.value, a.values])).toEqual([["f-due", "2026-11-20", { due: "2026-11-20", title: "Ship" }]]);
    expect(trigger().getAttribute("data-value")).toBe("2026-11-20");
    await open();
    fireEvent.click(screen.getByTestId("plugin-date-clear"));
    await tick();
    expect(acts.at(-1)?.value).toBe("");
  });

  it("a live date sends each pick once, through the one-at-a-time sender", async () => {
    inView(<NodeList nodes={[form(due({ live: true }))]} />);
    await open();
    fireEvent.click(screen.getByTestId("plugin-date-monday"));
    await tick();
    expect(acts.map((a) => [a.key, a.value])).toEqual([["f-due", "2026-11-16"]]);
  });

  it("submits the picked day; required refuses none", async () => {
    inView(<NodeList nodes={[form(due({}, { required: true, change: undefined }), true)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick();
    expect(screen.getByTestId("plugin-field-error").textContent).toBe("Required");
    expect(acts).toEqual([]);
    await open();
    fireEvent.click(screen.getByTestId("plugin-date-today"));
    await tick();
    // No change event: the pick waits for the submit, and clears the error.
    expect(acts).toEqual([]);
    expect(screen.queryByTestId("plugin-field-error")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick();
    expect(acts.map((a) => [a.key, a.values])).toEqual([["save", { due: "2026-11-11" }]]);
  });

  it("refuses a plugin value out of its bounds on submit", async () => {
    inView(<NodeList nodes={[form(due({ value: "2026-11-01", min: "2026-11-10" }, { change: undefined }), true)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await tick();
    expect(screen.getByTestId("plugin-field-error").textContent).toMatch(/^On or after /);
    expect(acts).toEqual([]);
  });

  it("is disabled with the form", () => {
    inView(<NodeList nodes={[{ key: "f", form: { busy: true, fields: [due()] } }]} />);
    expect(trigger().hasAttribute("disabled")).toBe(true);
  });

  it("sits in a toolbar row at its own width, its label for screen readers", () => {
    inView(
      <InStrip.Provider value="toolbar">
        <NodeList nodes={[form(due({ value: "2026-11-14" }))]} />
      </InStrip.Provider>,
    );
    const field = screen.getByTestId("plugin-field");
    expect(field.className).toContain("shrink-0");
    expect(field.className).not.toContain("flex-[2_1_0%]");
    expect(within(field).getByText("Due").className).toContain("sr-only");
  });
});

it("weekStartOf reads the locale (Sunday in the US when the engine knows)", () => {
  expect([0, 1]).toContain(weekStartOf("en-US"));
});
