import { describe, expect, it } from "vitest";
import type { SettingFieldView, SettingPageView, SettingsSchemaView } from "@/api/settings";
import { bucketKeybindings, fieldRows, highlightParts, isBound, matchField, pageSections, queryWords, searchSettings } from "./model";

const base: Omit<SettingFieldView, "key" | "title" | "type" | "page" | "section"> = {
  description: "",
  group: "g",
  enumValues: [],
  enumLabels: [],
  defaultValue: "",
  restartRequired: false,
  min: 0,
  max: 0,
  placeholder: "",
  unit: "",
  dependsOn: "",
  row: "",
};

function field(key: string, page: string, section: string, extra: Partial<SettingFieldView> = {}): SettingFieldView {
  return { ...base, key, title: key, type: "string", page, section, ...extra };
}

const pages: SettingPageView[] = [
  { id: "general", title: "General", description: "", sections: [{ id: "threads", title: "Threads", description: "" }, { id: "lifecycle", title: "Lifecycle", description: "" }] },
  { id: "source", title: "Source control", description: "", sections: [{ id: "github", title: "GitHub", description: "" }, { id: "projects", title: "Projects", description: "" }] },
  { id: "empty", title: "Empty", description: "", sections: [{ id: "nothing", title: "Nothing", description: "" }] },
];

const schema: SettingsSchemaView = {
  groups: [],
  pages,
  fields: [
    field("threads.default_model", "general", "threads", { title: "Model", row: "model" }),
    field("threads.default_effort", "general", "threads", { title: "Effort", row: "model" }),
    field("threads.auto_name", "general", "threads", { title: "Name threads automatically", description: "Uses the naming model." }),
    field("threads.cache_ttl_seconds", "general", "lifecycle", { title: "Prompt cache lifetime" }),
    // Out of section order in the list: search still follows the page's sections.
    field("projects.fetch_interval_seconds", "source", "projects", { title: "Fetch interval" }),
    field("github.poll_interval_seconds", "source", "github", { title: "Poll interval" }),
  ],
};

describe("search", () => {
  it("splits the query into lower-case words", () => {
    expect(queryWords("  Poll   INTERVAL ")).toEqual(["poll", "interval"]);
    expect(queryWords("   ")).toEqual([]);
  });

  it.each([
    ["title", ["model"], true],
    ["description", ["naming"], true],
    ["key", ["auto_name"], true],
    ["every word must match", ["naming", "zebra"], false],
    ["no words match everything", [], true],
  ])("matches a field by %s", (_name, words, want) => {
    const f = field("threads.auto_name", "general", "threads", { title: "Name threads automatically", description: "Uses the naming model." });
    expect(matchField(f, words)).toBe(want);
  });

  it("finds matches across pages in section order, with a count for every page", () => {
    const res = searchSettings(schema, ["interval"]);
    expect(res.hits.map((h) => [h.page.id, h.section?.title, h.field.key])).toEqual([
      ["source", "GitHub", "github.poll_interval_seconds"],
      ["source", "Projects", "projects.fetch_interval_seconds"],
    ]);
    expect(res.counts).toEqual({ general: 0, source: 2, empty: 0 });
  });

  it("marks every occurrence of every word, case-insensitively, merging overlaps", () => {
    expect(highlightParts("github.poll_interval_seconds", ["interval"])).toEqual([
      { text: "github.poll_", hit: false },
      { text: "interval", hit: true },
      { text: "_seconds", hit: false },
    ]);
    expect(highlightParts("Poll Poll", ["poll"])).toEqual([
      { text: "Poll", hit: true },
      { text: " ", hit: false },
      { text: "Poll", hit: true },
    ]);
    expect(highlightParts("abcd", ["abc", "bcd"])).toEqual([{ text: "abcd", hit: true }]);
    expect(highlightParts("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("page layout", () => {
  it("lists a page's non-empty sections with their fields", () => {
    const general = pages[0];
    const empty = pages[2];
    if (!general || !empty) throw new Error("fixture");
    expect(pageSections(schema, general).map((s) => [s.section.id, s.fields.map((f) => f.key)])).toEqual([
      ["threads", ["threads.default_model", "threads.default_effort", "threads.auto_name"]],
      ["lifecycle", ["threads.cache_ttl_seconds"]],
    ]);
    expect(pageSections(schema, empty)).toEqual([]);
  });

  it("puts fields sharing a row id side by side, others alone", () => {
    const rows = fieldRows(schema.fields.filter((f) => f.section === "threads"));
    expect(rows.map((r) => r.map((f) => f.key))).toEqual([["threads.default_model", "threads.default_effort"], ["threads.auto_name"]]);
  });

  it("does not join two runs of the same row id split by another field", () => {
    const fs = [field("a", "p", "s", { row: "x" }), field("b", "p", "s"), field("c", "p", "s", { row: "x" })];
    expect(fieldRows(fs).map((r) => r.map((f) => f.key))).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("keybindings", () => {
  const sections = [
    { id: "thread", title: "Thread", description: "" },
    { id: "view", title: "View", description: "" },
    { id: "daemon", title: "Daemon", description: "" },
    { id: "git", title: "Git", description: "" },
  ];
  const kb = (cmd: string, section: string, defaultValue = "") => field(`keybindings.${cmd}`, "keybindings", section, { type: "keybinding", defaultValue });
  const fields = [
    kb("thread.new", "thread", "cmd+n"),
    kb("thread.rename", "thread"),
    kb("thread.archive", "thread"),
    kb("view.settings", "view", "cmd+,"),
    kb("daemon.restart", "daemon"),
    kb("git.fetch", "git", "cmd+shift+f"),
  ];

  it("knows a bound value", () => {
    expect([isBound("cmd+n"), isBound(""), isBound("none"), isBound(undefined)]).toEqual([true, false, false, false]);
  });

  it("with Bound only: bound commands shown, the rest behind the expander, empty categories folded", () => {
    // thread.rename bound by an override, git.fetch unbound on purpose.
    const values = { "keybindings.thread.rename": "cmd+shift+r", "keybindings.git.fetch": "none" };
    const b = bucketKeybindings(sections, fields, values, true);
    expect(b.categories.map((c) => [c.section.id, c.shown.map((f) => f.key), c.unbound.map((f) => f.key)])).toEqual([
      ["thread", ["keybindings.thread.new", "keybindings.thread.rename"], ["keybindings.thread.archive"]],
      ["view", ["keybindings.view.settings"], []],
    ]);
    expect(b.empty.map((e) => [e.section.id, e.fields.length])).toEqual([
      ["daemon", 1],
      ["git", 1],
    ]);
    expect([b.bound, b.total]).toEqual([3, 6]);
  });

  it("without Bound only: every category with every command, nothing folded", () => {
    const b = bucketKeybindings(sections, fields, {}, false);
    expect(b.categories.map((c) => [c.section.id, c.shown.length, c.unbound.length])).toEqual([
      ["thread", 3, 0],
      ["view", 1, 0],
      ["daemon", 1, 0],
      ["git", 1, 0],
    ]);
    expect(b.empty).toEqual([]);
    expect([b.bound, b.total]).toEqual([3, 6]);
  });
});
