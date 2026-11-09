import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectOption } from "@/api/plugin";
import { AVATAR_TONES, avatarTone, groupOptions, PICKER_DEBOUNCE_MS, pickedOptions, pickedSummary, pickerShows, pickerTerm, searchSender, togglePick } from "./picker";

const opt = (value: string, extra: Partial<SelectOption> = {}): SelectOption => ({ key: `k-${value}`, value, label: value.toUpperCase(), ...extra });

afterEach(() => {
  vi.useRealTimers();
});

describe("pickerTerm", () => {
  it.each([
    ["", ""],
    ["a", ""],
    ["  a  ", ""],
    ["al", "al"],
    ["  ale ", "ale"],
    ["😀", ""], // one code point, as the daemon counts
    ["😀x", "😀x"],
  ])("%j → %j", (input, want) => {
    expect(pickerTerm(input)).toBe(want);
  });
});

describe("pickerShows", () => {
  const search = { key: "s", event: "e", query: "ale", results: [opt("ale")] };
  it("lists the options before a term", () => {
    expect(pickerShows(search, "")).toEqual({ kind: "options" });
  });
  it("lists the results that answer the term", () => {
    expect(pickerShows(search, "ale")).toEqual({ kind: "results", results: [opt("ale")] });
    expect(pickerShows({ ...search, results: undefined }, "ale")).toEqual({ kind: "results", results: [] });
  });
  it("drops an answer to another query: Searching…", () => {
    expect(pickerShows(search, "alex")).toEqual({ kind: "searching" });
    expect(pickerShows(search, "al")).toEqual({ kind: "searching" });
    expect(pickerShows({ key: "s", event: "e" }, "al")).toEqual({ kind: "searching" });
    expect(pickerShows(undefined, "al")).toEqual({ kind: "searching" });
  });
});

describe("groupOptions", () => {
  it("keeps each group's first place and the options' order inside it", () => {
    const g = groupOptions([opt("a", { group: "Recent" }), opt("b"), opt("c", { group: "Recent" }), opt("d", { group: "Team" })]);
    expect(g.map((x) => [x.heading, x.options.map((o) => o.value)])).toEqual([
      ["Recent", ["a", "c"]],
      ["", ["b"]],
      ["Team", ["d"]],
    ]);
  });
});

describe("avatarTone", () => {
  it("is one of the chart colours and the same for one value", () => {
    const tones = new Set(["ada", "alan", "grace", "kim", "me", "", "😀"].map(avatarTone));
    for (const t of tones) expect(t >= 1 && t <= AVATAR_TONES).toBe(true);
    expect(tones.size).toBeGreaterThan(1);
    expect(avatarTone("ada")).toBe(avatarTone("ada"));
  });
});

describe("togglePick", () => {
  it.each([
    [["a"], "b", true, false, ["a", "b"]],
    [["a", "b"], "a", true, false, ["b"]],
    [["a"], "b", false, false, ["b"]],
    [["a"], "a", false, false, []],
    [["a"], "a", false, true, ["a"]],
    [[], "a", false, false, ["a"]],
  ])("%j pick %s (multiple %s, required %s) → %j", (current, value, multiple, required, want) => {
    expect(togglePick(current, value, multiple, required)).toEqual(want);
  });
});

describe("pickedOptions", () => {
  it("names a value from the lists first, then what was seen, else the value itself", () => {
    const seen = new Map([["kim", opt("kim", { label: "Kim (seen)" })]]);
    const got = pickedOptions(["me", "kim", "zed"], [[opt("me", { label: "Me (result)" })], [opt("me", { label: "Me (option)" })]], seen);
    expect(got.map((o) => o.label)).toEqual(["Me (result)", "Kim (seen)", "zed"]);
    expect(pickedSummary(got)).toBe("Me (result), Kim (seen), zed");
    expect(pickedSummary([])).toBe("");
  });
});

describe("searchSender", () => {
  it("sends a term once typing pauses, not below the threshold", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const s = searchSender((t) => {
      sent.push(t);
      return Promise.resolve();
    });
    s.push("a");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS * 2);
    expect(sent).toEqual([]);
    s.push("al");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS - 1);
    s.push(" ale ");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["ale"]);
  });

  it("drops what waits when the box goes under the threshold", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const s = searchSender((t) => {
      sent.push(t);
      return Promise.resolve();
    });
    s.push("ale");
    s.push("a");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS * 2);
    expect(sent).toEqual([]);
  });

  it("keeps one search in flight and sends the newest term last", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let answer: () => void = () => undefined;
    const s = searchSender(
      (t) =>
        new Promise<void>((resolve) => {
          sent.push(t);
          answer = resolve;
        }),
    );
    s.push("al");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
    s.push("ale");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
    s.push("alex");
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS);
    expect(sent).toEqual(["al"]);
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["al", "alex"]);
  });

  it("sends nothing after cancel", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => Promise.resolve());
    const s = searchSender(send);
    s.push("ale");
    s.cancel();
    await vi.advanceTimersByTimeAsync(PICKER_DEBOUNCE_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
