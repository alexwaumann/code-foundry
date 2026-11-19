import { describe, expect, it } from "vitest";
import type { SnoozeEventsView } from "@/api/snoozeEvents";
import { eventRowMatches, formatSnoozeEventsSetting, hasSnoozeEvents, moreEventRows, parseSnoozeEventsSetting, snoozeEventArgs, untilEventMenu } from "./snoozeEvents";

const ALL = ["checks_done", "review", "merged", "comment", "head_pushed", "closed", "review_requested"];

function pr(number: number, conditions = ALL, title = `Change ${String(number)}`) {
  return { target: `acme/web#${String(number)}`, number, title, conditions };
}

function plugin(target: string, title = target, pluginName = "Hello") {
  return { target, title, pluginName, args: {} };
}

function evs(o: Partial<SnoozeEventsView>): SnoozeEventsView {
  return { pullRequests: [], plugins: [], recentPlugins: [], ...o };
}

const DEFAULTS = parseSnoozeEventsSetting(undefined);

describe("untilEventMenu", () => {
  it("offers the checked pending events of at most three pull requests, newest first as listed", () => {
    const menu = untilEventMenu(evs({ pullRequests: [pr(812), pr(790, ["merged", "comment"]), pr(700, ["comment"]), pr(650), pr(600)] }), DEFAULTS);
    expect(menu.pullRequests.map((p) => [p.number, p.events.map((e) => e.label)])).toEqual([
      [812, ["Checks finish", "Reviewed", "Merged"]],
      [790, ["Merged"]],
      // #700 has nothing checked pending: left out, so the third is #650.
      [650, ["Checks finish", "Reviewed", "Merged"]],
    ]);
  });

  it("follows the setting: unchecked events go, checked extra ones come, in menu order", () => {
    const menu = untilEventMenu(evs({ pullRequests: [pr(812)] }), parseSnoozeEventsSetting("closed comment merged"));
    expect(menu.pullRequests[0]?.events.map((e) => e.condition)).toEqual(["merged", "comment", "closed"]);
    expect(untilEventMenu(evs({ pullRequests: [pr(812)] }), parseSnoozeEventsSetting("none")).pullRequests).toEqual([]);
  });

  it("puts the recently used plugin events first, then fills up to three from the checked ones", () => {
    const plugins = [plugin("a/one"), plugin("b/two"), plugin("c/three"), plugin("d/four"), plugin("e/five")];
    const checked = parseSnoozeEventsSetting("checks_done plugin:a/one plugin:d/four plugin:e/five");
    // gone/x was used but is not running now: skipped.
    const menu = untilEventMenu(evs({ plugins, recentPlugins: ["c/three", "gone/x", "a/one"] }), checked);
    expect(menu.plugins.map((p) => p.target)).toEqual(["c/three", "a/one", "d/four"]);
  });

  it("shows no plugin event when none was used or checked, and caps the recent ones at three", () => {
    const plugins = [plugin("a/one"), plugin("b/two"), plugin("c/three"), plugin("d/four")];
    expect(untilEventMenu(evs({ plugins }), DEFAULTS).plugins).toEqual([]);
    expect(untilEventMenu(evs({ plugins, recentPlugins: ["d/four", "c/three", "b/two", "a/one"] }), DEFAULTS).plugins.map((p) => p.target)).toEqual(["d/four", "c/three", "b/two"]);
  });
});

describe("hasSnoozeEvents", () => {
  it.each([
    { name: "nothing", v: evs({}), want: false },
    { name: "a pull request with no pending event", v: evs({ pullRequests: [pr(1, [])] }), want: false },
    { name: "a pending event", v: evs({ pullRequests: [pr(1, ["merged"])] }), want: true },
    { name: "a plugin source", v: evs({ plugins: [plugin("a/b")] }), want: true },
  ])("$name: $want", ({ v, want }) => {
    expect(hasSnoozeEvents(v)).toBe(want);
  });
});

describe("More events", () => {
  const rows = moreEventRows(evs({ pullRequests: [pr(812, ["checks_done", "merged"], "Fix login"), pr(790, ["comment"], "Docs")], plugins: [plugin("vercel/deploy", "Preview deployed", "Vercel")] }));

  it("lists every event, grouped by pull request then Plugins", () => {
    expect(rows.map((r) => [r.group, r.label, r.hint])).toEqual([
      ["#812 Fix login", "Checks finish", ""],
      ["#812 Fix login", "Merged", ""],
      ["#790 Docs", "New comment", ""],
      ["Plugins", "Preview deployed", "Vercel"],
    ]);
  });

  it.each([
    { query: "812 merged", want: ["pr:acme/web#812:merged"] },
    { query: "#812", want: ["pr:acme/web#812:checks_done", "pr:acme/web#812:merged"] },
    { query: "deploy", want: ["plugin:vercel/deploy"] },
    { query: "vercel", want: ["plugin:vercel/deploy"] },
    { query: "login checks", want: ["pr:acme/web#812:checks_done"] },
    { query: "", want: ["pr:acme/web#812:checks_done", "pr:acme/web#812:merged", "pr:acme/web#790:comment", "plugin:vercel/deploy"] },
    { query: "nothing", want: [] },
  ])("filters on every word typed: $query", ({ query, want }) => {
    expect(rows.filter((r) => eventRowMatches(r, query)).map((r) => r.key)).toEqual(want);
  });
});

describe("the setting", () => {
  it("reads the default when unset, and none as nothing", () => {
    expect([...DEFAULTS]).toEqual(["checks_done", "review", "merged"]);
    expect(parseSnoozeEventsSetting("none").size).toBe(0);
  });

  it("writes events in menu order and plugin sources sorted, none when empty", () => {
    expect(formatSnoozeEventsSetting(new Set(["plugin:b/x", "merged", "plugin:a/y", "checks_done"]))).toBe("checks_done merged plugin:a/y plugin:b/x");
    expect(formatSnoozeEventsSetting(new Set())).toBe("none");
  });
});

describe("snoozeEventArgs", () => {
  it("is until-pr with on for a pull request, until-plugin with each arg on its line for a plugin", () => {
    expect(snoozeEventArgs({ kind: "pull_request", target: "acme/web#812", condition: "merged" })).toEqual({ "until-pr": "acme/web#812", on: "merged" });
    expect(snoozeEventArgs({ kind: "plugin", target: "hello/tick", args: { thread: "s-1", every: "10s" } })).toEqual({ "until-plugin": "hello/tick", arg: "every=10s\nthread=s-1" });
    expect(snoozeEventArgs({ kind: "plugin", target: "hello/tick", args: {} })).toEqual({ "until-plugin": "hello/tick" });
  });
});
