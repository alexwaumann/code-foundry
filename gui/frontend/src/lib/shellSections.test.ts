import { describe, expect, it } from "vitest";
import { buildShellSections, needsBySpace, needsList, needsScopeOf, shellRows, shellThreadOrder, type ShellListOptions, type ShellListThread } from "./shellSections";

/**
 * The shell sidebar's sections (docs/notes/shell-model.md, "Sidebar"). Threads come in creation
 * order (oldest first), as the threads store keeps them; "A" is the current space.
 */

const t = (id: string, o: Partial<ShellListThread> = {}): ShellListThread => ({
  id,
  pinned: false,
  group: "idle",
  archivedAtMs: null,
  snoozedUntilMs: null,
  spaceId: "A",
  ...o,
});

const OPTS: ShellListOptions = { currentSpaceId: "A", needsScope: "all" };

/** Rows as short strings: "# Label count" for a header, "<section>:<id>" for a thread, "draft:<id>" for a draft. */
function view(threads: ShellListThread[], opts: Partial<ShellListOptions> = {}): string[] {
  return shellRows(buildShellSections(threads, { ...OPTS, ...opts })).map((r) => {
    if (r.kind === "header") return `# ${r.label} ${String(r.count)}${r.collapsed ? " collapsed" : ""}`;
    if (r.kind === "draft") return `draft:${r.draftId}`;
    return `${r.section}:${r.threadId}`;
  });
}

const WORLD: ShellListThread[] = [
  t("idle-a", { lastActivityAtMs: 100 }),
  t("ask-a", { group: "prompt", statusChangedAtMs: 10 }),
  t("ask-b", { group: "prompt", statusChangedAtMs: 20, spaceId: "B" }),
  t("done-a", { group: "done", statusChangedAtMs: 5 }),
  t("idle-b", { spaceId: "B" }),
  t("work-a", { group: "working" }),
  t("work-b", { group: "working", spaceId: "B" }),
  t("err-a", { group: "error", statusChangedAtMs: 1 }),
  t("pin-a", { pinned: true }),
  t("snooze-a", { snoozedUntilMs: Date.now() + 60_000 }),
  t("snooze-b", { snoozedUntilMs: Date.now() + 60_000, spaceId: "B" }),
  t("arch-a", { archivedAtMs: 2 }),
  t("arch-b", { archivedAtMs: 3, spaceId: "B" }),
];

describe("the shell sidebar's sections", () => {
  it("Needs you, then Active in today's order (pinned, failed, finished, idle), then Working, Snoozed and Archived", () => {
    expect(view(WORLD)).toEqual([
      "# Needs you 2",
      "needs:ask-b",
      "needs:ask-a",
      "# Active 4",
      "pinned:pin-a",
      "attention:err-a",
      "done:done-a",
      "idle:idle-a",
      "# Working 1",
      "working:work-a",
      "# Snoozed 1",
      "snoozed:snooze-a",
      "# Archived 2",
      "archived:arch-b",
      "archived:arch-a",
    ]);
  });

  it("Active, Working and Snoozed hold the current space's threads only; Archived every space's", () => {
    const rows = view(WORLD);
    for (const id of ["idle-b", "work-b", "snooze-b"]) expect(rows.join(" ")).not.toContain(id);
    expect(rows).toContain("archived:arch-b");
    // Another space current: its threads, the same Archived.
    expect(view(WORLD, { currentSpaceId: "B" }).filter((r) => !r.startsWith("needs") && !r.startsWith("archived") && !r.startsWith("#"))).toEqual([
      "idle:idle-b",
      "working:work-b",
      "snoozed:snooze-b",
    ]);
  });

  it("a thread that needs you is listed there and never also under Active, even pinned", () => {
    const rows = view([t("p", { pinned: true, group: "prompt" }), t("i")]);
    expect(rows).toEqual(["# Needs you 1", "needs:p", "# Active 1", "idle:i"]);
  });

  it("lists only the user's own threads: one another thread started is in no section", () => {
    const rows = view([t("mine", { group: "prompt" }), t("child", { group: "prompt", hidden: true }), t("child-idle", { hidden: true })]);
    expect(rows).toEqual(["# Needs you 1", "needs:mine"]);
  });

  it("an archived or snoozed thread never needs you", () => {
    const rows = view([t("a", { group: "prompt", archivedAtMs: 1 }), t("s", { group: "prompt", snoozedUntilMs: Date.now() + 1000 })]);
    expect(rows.filter((r) => r.startsWith("needs") || r.startsWith("# Needs"))).toEqual([]);
  });

  it("the scope: every space's asks, or this space's; with none here the header stays for its button", () => {
    expect(view(WORLD, { needsScope: "all" }).filter((r) => r.startsWith("needs"))).toEqual(["needs:ask-b", "needs:ask-a"]);
    expect(view(WORLD, { needsScope: "space" }).filter((r) => r.startsWith("needs") || r.startsWith("# Needs"))).toEqual(["# Needs you 1", "needs:ask-a"]);
    // B's ask is not listed under A's Active either way: it lives in B.
    expect(view(WORLD, { needsScope: "space" })).not.toContain("idle:ask-b");
    const onlyElsewhere = [t("ask-b", { group: "prompt", spaceId: "B" }), t("i")];
    expect(view(onlyElsewhere, { needsScope: "space" })).toEqual(["# Needs you 0", "# Active 1", "idle:i"]);
    expect(view([t("i")])).toEqual(["# Active 1", "idle:i"]);
  });

  it("the most recent ask first; one without a time after, newest created first", () => {
    const rows = view([t("old", { group: "prompt", statusChangedAtMs: 1 }), t("none1", { group: "prompt" }), t("new", { group: "prompt", statusChangedAtMs: 9 }), t("none2", { group: "prompt" })]);
    expect(rows.slice(1)).toEqual(["needs:new", "needs:old", "needs:none2", "needs:none1"]);
  });

  it("the space's drafts sit at the top of Active, below the pinned threads, newest first as listed", () => {
    const drafts = [
      { id: "d-2", label: "Second" },
      { id: "d-1", label: "" },
    ];
    expect(view([t("pin", { pinned: true }), t("i")], { drafts })).toEqual(["# Active 4", "pinned:pin", "draft:d-2", "draft:d-1", "idle:i"]);
    // A space with only drafts still has Active.
    expect(view([], { drafts })).toEqual(["# Active 2", "draft:d-2", "draft:d-1"]);
  });

  it("collapsed headers keep their count and hide their rows", () => {
    const rows = view([t("a", { group: "prompt" }), t("i")], { needsCollapsed: true, activeCollapsed: true });
    expect(rows).toEqual(["# Needs you 1 collapsed", "# Active 1 collapsed"]);
  });

  it("the keys' order is the rows' (cmd+1..9): Needs you, Active, then the footers' shown rows", () => {
    expect(shellThreadOrder(WORLD, { ...OPTS, snoozedCollapsed: true, archivedCollapsed: true })).toEqual(["ask-b", "ask-a", "pin-a", "err-a", "done-a", "idle-a", "work-a"]);
  });

  it("sidebar.needs_scope's values", () => {
    expect(needsScopeOf("space")).toBe("space");
    expect(needsScopeOf("all")).toBe("all");
    expect(needsScopeOf(undefined)).toBe("all");
    expect(needsScopeOf("junk")).toBe("all");
  });
});

describe("the Needs you list (the top bar's control and cmd+shift+a)", () => {
  it("is the section's threads in its order, whether the section is collapsed or not", () => {
    expect(needsList(WORLD, OPTS)).toEqual({ ids: ["ask-b", "ask-a"], any: true });
    const rows = view(WORLD, { needsCollapsed: true });
    expect(rows[0]).toBe("# Needs you 2 collapsed");
  });

  it("follows the scope: this space's only, while any space's keeps it reachable", () => {
    expect(needsList(WORLD, { ...OPTS, needsScope: "space" })).toEqual({ ids: ["ask-a"], any: true });
    expect(needsList(WORLD, { currentSpaceId: "C", needsScope: "space" })).toEqual({ ids: [], any: true });
  });

  it("only the user's own threads that wait, never a thread's threads, archived or snoozed ones", () => {
    const ts = [t("mine", { group: "prompt" }), t("child", { group: "prompt", hidden: true }), t("gone", { group: "prompt", archivedAtMs: 1 }), t("later", { group: "prompt", snoozedUntilMs: Date.now() + 60_000 }), t("err", { group: "error" })];
    expect(needsList(ts, OPTS)).toEqual({ ids: ["mine"], any: true });
    expect(needsList([t("child", { group: "prompt", hidden: true })], OPTS)).toEqual({ ids: [], any: false });
  });
});

describe("a space tab's count (needsBySpace)", () => {
  it("is, for each space, the threads Needs you lists for that space: a finished turn counts in neither", () => {
    const ts = [...WORLD, t("child-b", { group: "prompt", hidden: true, spaceId: "B" }), t("done-b", { group: "done", spaceId: "B", statusChangedAtMs: 40 })];
    const counts = needsBySpace(ts);
    expect(counts).toEqual({ A: 1, B: 1 });
    for (const space of ["A", "B", "C"]) expect(counts[space] ?? 0).toBe(needsList(ts, { currentSpaceId: space, needsScope: "space" }).ids.length);
  });

  it("has no entry for a space where nothing waits", () => {
    expect(needsBySpace([t("done-a", { group: "done" }), t("idle-b", { spaceId: "B" })])).toEqual({});
  });
});

describe("a thread that calls without blocking: woken, a notification, an API error, a plugin's flag (docs/notes/shell-25c-keys-drafts.md)", () => {
  const woke = (id: string, o: Partial<ShellListThread> = {}) => t(id, { group: "prompt", nudge: true, ...o });
  const W: ShellListThread[] = [
    t("idle-a", { lastActivityAtMs: 100 }),
    t("ask-a", { group: "prompt", statusChangedAtMs: 10 }),
    woke("woke-old", { statusChangedAtMs: 30 }),
    woke("woke-new", { statusChangedAtMs: 40 }),
    woke("woke-b", { statusChangedAtMs: 50, spaceId: "B" }),
    woke("woke-pin", { pinned: true, statusChangedAtMs: 60 }),
    t("err-a", { group: "error", statusChangedAtMs: 1 }),
    t("pin-a", { pinned: true }),
  ];

  it("is not under Needs you: it tops Active below the pinned threads and the drafts, most recent first", () => {
    expect(view(W, { drafts: [{ id: "d-1", label: "x" }] })).toEqual([
      "# Needs you 1",
      "needs:ask-a",
      "# Active 7",
      "pinned:pin-a",
      "pinned:woke-pin",
      "draft:d-1",
      "attention:woke-new",
      "attention:woke-old",
      "attention:err-a",
      "idle:idle-a",
    ]);
  });

  it("stays in its own space's Active, whatever the Needs you scope", () => {
    expect(view(W, { currentSpaceId: "B" })).toEqual(["# Needs you 1", "needs:ask-a", "# Active 1", "attention:woke-b"]);
  });

  it("counts in no Needs you number: the list, the space tabs, the top bar's control, cmd+shift+a", () => {
    expect(needsList(W, OPTS)).toEqual({ ids: ["ask-a"], any: true });
    expect(needsBySpace(W)).toEqual({ A: 1 });
    // Only threads that call without blocking: nothing waits on the user, so Needs you has no header and the top bar no control.
    const only = [woke("w-1", { statusChangedAtMs: 1 }), t("i")];
    expect(needsList(only, OPTS)).toEqual({ ids: [], any: false });
    expect(needsBySpace(only)).toEqual({});
    expect(view(only)).toEqual(["# Active 2", "attention:w-1", "idle:i"]);
  });

  it("walks in the keys' order where it is drawn", () => {
    expect(shellThreadOrder(W, OPTS)).toEqual(["ask-a", "pin-a", "woke-pin", "woke-new", "woke-old", "err-a", "idle-a"]);
  });
});
