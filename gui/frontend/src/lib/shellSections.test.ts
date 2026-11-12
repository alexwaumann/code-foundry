import { describe, expect, it } from "vitest";
import { buildShellSections, needsScopeOf, shellRows, shellThreadOrder, type ShellListOptions, type ShellListThread } from "./shellSections";

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
