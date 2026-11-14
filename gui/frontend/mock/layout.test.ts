// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { LayoutEventSchema } from "../src/gen/codefoundry/v1/layout_pb";
import { applyOp, canon, decodeState, LayoutError, MockLayout, PORTED_OPS, seqIds, SEEDS, type LayoutEventInit, type Op, type State } from "./layout";

/** internal/layout/testdata/ops: the cases Go's ops are pinned to (docs/notes/shell-1-layout-model.md). */
const dir = new URL("../../../internal/layout/testdata/ops/", import.meta.url);
const files = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, readFileSync(new URL(f, dir), "utf8")]),
);

interface OpCase {
  doc: string;
  state: State;
  op: Op;
  options?: { keep_focus?: boolean; no_smart_swap?: boolean };
  want?: State;
  error?: string;
  result?: { space?: string; pane?: string; tab?: string; existing?: boolean; closed?: string[]; rule?: string; draft?: string; kept?: string[]; swapped?: string[]; placed?: string[] };
}

const cases = Object.entries(files).map(([path, raw]) => ({ name: path.replace(/^.*\//, "").replace(/\.json$/, ""), c: JSON.parse(raw) as OpCase }));

/**
 * Why a case is not run against the mock. The mock does not port the rules, which are tested in
 * Go: the thread ops (open_thread with its restore, close_thread, move_thread, archive, snooze),
 * placement rules 2 to 6 for a linked surface beside its open thread, a thread's remembered
 * set, and smart swap. Nor the terminal ops the daemon's lifecycle glue applies itself
 * (internal/daemon/layout.go; docs/notes/shell-6-lifecycle.md): no GUI sends them. set_quick is
 * ported: the quick terminal's height drag sends it (docs/notes/shell-13-terminals.md).
 */
const TERMINAL_GLUE_OPS = ["drop_terminal", "replace_terminal"];

function notPorted(c: OpCase): string | null {
  if (TERMINAL_GLUE_OPS.includes(c.op.op)) return "the daemon's terminal glue";
  if (!PORTED_OPS.includes(c.op.op)) return `${c.op.op} is a rule`;
  // The reopen history (internal/layout reopen.go) is kept by the mock's verbs, not its state.
  if (c.op.record === true) return "the reopen history";
  if (c.result?.swapped?.length) return "smart swap";
  if (c.result?.rule && /^[2-6]$/.test(c.result.rule)) return "placement rules 2 to 6";
  // A pane moved to another space with threads places their other linked tabs by the rules.
  if (c.op.op === "move_pane" && c.result?.placed?.length) return "linked tabs placed by the rules";
  const remembers = Object.values(c.state.threads ?? {}).some((ts) => ts.remembered);
  if (c.result?.kept?.length || (c.op.op === "open_surface" && remembers)) return "a remembered set";
  return null;
}

/** A state as the cases compare it: keys left out (Decode derives them), sizes to 1e-9. */
function comparable(st: State): string {
  const c = structuredClone(st);
  for (const sp of c.spaces) {
    const walk = (n: (typeof sp)["root"]): void => {
      if (!n) return;
      if (n.sizes) n.sizes = n.sizes.map((s) => Math.round(s * 1e9) / 1e9);
      for (const t of n.tabs ?? []) delete t.key;
      for (const k of n.kids ?? []) walk(k);
    };
    walk(sp.root);
  }
  return canon(c);
}

describe("the mock's layout ops against internal/layout's cases", () => {
  const run = cases.filter(({ c }) => notPorted(c) === null);

  it("reads the cases and runs every ported op at least once", () => {
    expect(cases.length).toBeGreaterThan(100);
    const ran = new Set(run.map(({ c }) => c.op.op));
    expect([...PORTED_OPS].sort()).toEqual([...ran].sort());
  });

  it("skips only the rules", () => {
    const skipped = (why: string) => cases.filter(({ c }) => notPorted(c) === why).map(({ name }) => name).sort();
    const ops = new Set(cases.filter(({ c }) => notPorted(c)?.endsWith("is a rule")).map(({ c }) => c.op.op));
    expect([...ops].sort()).toEqual(["archive_thread", "close_thread", "move_thread", "open_thread", "reopen_closed", "snooze_thread"]);
    expect(skipped("the reopen history")).toEqual(["close_pane-record", "close_tab-record", "close_tab-record-cap", "close_tab-record-empty-composer", "close_tab-record-last"]);
    expect(skipped("smart swap")).toEqual(["close_tab-smart-swap-on-return", "focus_tab-smart-swap", "focus_tab-smart-swap-last", "focus_tab-smart-swap-mru"]);
    // remove_space puts a moved thread's linked tabs into its set (Result.kept).
    expect(skipped("a remembered set")).toEqual(["close_pane-closes-threads", "open_surface-drops-remembered", "remove_space-default", "remove_space-keeps-linked-terminals"]);
    expect(skipped("placement rules 2 to 6").every((n) => /^open_surface-rule[2-6]-/.test(n))).toBe(true);
    expect(skipped("linked tabs placed by the rules")).toEqual(["move_pane-thread-to-space"]);
  });

  it.each(run.map(({ name, c }) => [name, c] as const))("%s", (_name, c) => {
    const st = decodeState(c.state);
    const before = canon(st);
    if (c.error) {
      let code = "";
      try {
        applyOp(st, c.op, seqIds(), c.options);
      } catch (err) {
        code = err instanceof LayoutError ? err.code : String(err);
      }
      expect(code).toBe(c.error);
      expect(canon(st)).toBe(before);
      return;
    }
    const { state, result } = applyOp(st, c.op, seqIds(), c.options);
    expect(canon(st)).toBe(before);
    expect(comparable(state)).toBe(comparable(decodeState(c.want)));
    if (c.result) {
      expect({ space: result.space ?? "", pane: result.pane ?? "", tab: result.tab ?? "", existing: result.existing ?? false, closed: (result.closed ?? []).map((t) => t.id), rule: result.rule ?? "", draft: result.draft ?? "" }).toEqual({
        space: c.result.space ?? "",
        pane: c.result.pane ?? "",
        tab: c.result.tab ?? "",
        existing: c.result.existing ?? false,
        closed: c.result.closed ?? [],
        rule: c.result.rule ?? "",
        draft: c.result.draft ?? "",
      });
    }
  });
});

describe("the mock's LayoutService", () => {
  function service() {
    const events: LayoutEventInit[] = [];
    const layout = new MockLayout({ publish: (ev) => events.push(ev), ids: seqIds() });
    return { layout, events };
  }

  it("publishes one delta per commit, with the next rev and the caller's client id, and none for a no-op", () => {
    const { layout, events } = service();
    layout.seed("thread-and-diff");
    expect(layout.rev).toBe(1);
    const { rev } = layout.apply({ op: "focus_pane", pane: "p-2" }, "win-1");
    expect(rev).toBe(2);
    const last = events.at(-1);
    expect(last?.rev).toBe(2n);
    expect(last?.clientId).toBe("win-1");
    expect(last?.change?.case).toBe("delta");
    // Focusing it again changes nothing: no commit, no event.
    expect(layout.apply({ op: "focus_pane", pane: "p-2" }, "win-1").rev).toBe(2);
    expect(events).toHaveLength(2);
  });

  it("says a newer build wrote the layout in a snapshot at the same rev, and stops saying it on reset", () => {
    const { layout, events } = service();
    layout.seed("one-thread");
    layout.setNewer(["space sp-main: tab t-9 of kind \"notebook\""]);
    const last = events.at(-1);
    expect(last?.rev).toBe(1n);
    expect(last?.change?.case).toBe("snapshot");
    expect(last?.change?.case === "snapshot" ? last.change.value.newer : []).toHaveLength(1);
    expect(layout.get().newer).toHaveLength(1);
    layout.reset();
    expect(layout.get().newer).toEqual([]);
  });

  it("imports once: the mark set in one commit with the layout unchanged, then a no-op; a failure changes nothing", () => {
    const { layout, events } = service();
    layout.seed("one-thread");
    expect(layout.snapshotEvent().change).toMatchObject({ case: "snapshot", value: { legacyImported: false } });
    layout.failImports = 1;
    expect(() => layout.importLegacy("{}", "", "win-1")).toThrow(expect.objectContaining({ code: "failed_precondition" }) as Error);
    expect(layout.legacyImported).toBe(false);
    const first = layout.importLegacy('{"version":3}', '{"version":1}', "win-1");
    expect(first.imported).toBe(true);
    expect(first.layout.legacyImported).toBe(true);
    expect(layout.rev).toBe(2);
    expect(events.at(-1)?.change).toMatchObject({ case: "delta", value: { legacyImported: true, spaces: [] } });
    expect(layout.importLegacy("", "").imported).toBe(false);
    expect(layout.rev).toBe(2);
    expect(layout.imports.map((i) => i.panelJson)).toEqual(["{}", '{"version":3}', ""]);
    // Later commits carry the mark.
    layout.apply({ op: "new_space", name: "Two" });
    expect(events.at(-1)?.change).toMatchObject({ case: "delta", value: { legacyImported: true } });
  });

  it("sends only the spaces a commit changed, the order always", () => {
    const { layout, events } = service();
    layout.seed("spaces");
    layout.apply({ op: "rename_space", space: "sp-review", name: "Later" });
    const ev = events.at(-1);
    const delta = ev?.change?.case === "delta" ? ev.change.value : undefined;
    expect(delta?.spaces?.map((s) => s.id)).toEqual(["sp-review"]);
    expect(delta?.spaceOrder).toEqual(["sp-main", "sp-review"]);
    expect(delta?.currentSpaceId).toBe("sp-main");
  });

  it("refuses with the daemon's codes and changes nothing", () => {
    const { layout } = service();
    layout.seed("one-thread");
    expect(() => layout.apply({ op: "close_tab", tab: "t-gone" })).toThrow(expect.objectContaining({ code: "not_found" }) as Error);
    expect(() => layout.apply({ op: "archive_thread", thread: "s-1" })).toThrow(expect.objectContaining({ code: "unimplemented" }) as Error);
    expect(layout.rev).toBe(1);
  });

  it("encodes every seed as a snapshot the proto reads back", () => {
    for (const name of Object.keys(SEEDS)) {
      const { layout } = service();
      layout.seed(name);
      const ev = create(LayoutEventSchema, layout.snapshotEvent());
      const back = fromBinary(LayoutEventSchema, toBinary(LayoutEventSchema, ev));
      expect(back.change.case).toBe("snapshot");
    }
  });

  it("opens a thread in the focused pane and a linked surface right of it (the simplified rules)", () => {
    const { layout } = service();
    layout.seed("one-thread");
    const diff = layout.apply({ op: "open_surface", tab: { id: "", kind: "diff", thread: "s-1", params: { project: "p", worktree: "w" } }, focus: true });
    expect(diff.result.pane).toBe("p-n1");
    // A second linked surface joins the pane holding the thread's linked tabs.
    const file = layout.apply({ op: "open_surface", tab: { id: "", kind: "file", thread: "s-1", params: { path: "/a" } } });
    expect(file.result.pane).toBe("p-n1");
    const opened = layout.apply({ op: "open_thread", thread: "s-2", focus: true });
    expect(opened.result.pane).toBe("p-n1");
    layout.apply({ op: "close_thread", thread: "s-1" });
    expect(JSON.stringify(layout.state())).not.toMatch(/"thread":"s-1"/);
  });
});
