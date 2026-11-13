/**
 * The layout verbs (internal/command commands_thread_open.go, commands_tab.go, commands_pane.go,
 * commands_space.go, commands_composer_drafts.go) over the mock's layout (mock/layout.ts). Each
 * runs the op its Go command runs through `MockLayout.apply`, defaulting to the stored focus as the
 * user's call does, and answers Go's `LayoutResult` JSON ({rev, changed, ...result}). The mock only
 * sees the app's calls, so focus is the user's (no keep_focus). Refusals that are rules (a call from
 * inside a thread with no ids, `--focus` checks) are tested in Go, not here.
 * See docs/notes/shell-11-pane-grid.md.
 */
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { neighbour, type Direction } from "../src/shell/geometry/neighbours";
import { plainRects } from "../src/shell/geometry/rects";
import type { GeoNode } from "../src/shell/geometry/types";
import { CommandError } from "./errors";
import { identify, layoutRpcError, panes, type MockLayout, type Node, type Op, type Space, type State } from "./layout";

interface Arg {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
  enumValues?: string[];
  defaultValue?: string;
  positional?: boolean;
}

interface Out {
  message: string;
  resultJson: string;
}

interface Entry {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: Arg[]; noPalette?: boolean };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => Out;
}

/** What the verbs need of the world. */
export interface LayoutVerbsWorld {
  readonly layout: MockLayout;
  /** The threads the sidebar lists (the user's, and children whose creator is gone) that are not archived (space.remove moves or archives those in the space). */
  sidebarThreads?(): string[];
  /** Whether a thread is archived (it lives in no space: thread.open puts it in the current one). */
  isArchived?(id: string): boolean;
  /** Archives a thread (space.remove --archive). */
  archiveThread?(id: string): void;
  /** Whether a thread exists. */
  hasThread(id: string): boolean;
  /** A thread's project and worktree ("" without one): its own diff's checkout (view.thread-diff). */
  threadCheckout?(id: string): { projectId: string; worktreePath: string };
}

const CATEGORY = "Layout";
const DEFAULT_AREA = { width: 1180, height: 820 };

const str = (name: string, description: string, extra: Partial<Arg> = {}): Arg => ({ name, type: ArgType.STRING, required: false, description, ...extra });
const focusArg: Arg = { name: "focus", type: ArgType.BOOL, required: false, description: "Take the user's focus there; from inside a thread only when the user asked to be taken there" };
const edges = ["left", "right", "top", "bottom"];
const edgeArg = (name: string, description: string, extra: Partial<Arg> = {}): Arg => ({ name, type: ArgType.ENUM, required: false, description, enumValues: edges, ...extra });

function refuse(message: string, kind: "invalid" | "unavailable" | "notfound" = "invalid"): never {
  throw new CommandError(kind, message);
}

function currentSpace(st: State): Space {
  const sp = st.spaces.find((s) => s.id === st.current_space) ?? st.spaces[0];
  if (!sp) refuse("invalid argument: no space");
  return sp;
}

/** The pane a verb names (an id or a unique suffix), else the current space's focused pane. */
function resolvePane(st: State, given: string | undefined): { sp: Space; pane: Node } {
  if (given) {
    const all = st.spaces.flatMap((sp) => panes(sp.root).map((pane) => ({ sp, pane })));
    const hit = all.filter((x) => x.pane.id === given || x.pane.id.endsWith(given));
    const one = hit.length === 1 ? hit[0] : hit.find((x) => x.pane.id === given);
    if (!one) refuse(`invalid argument: no pane "${given}"`);
    return one;
  }
  const sp = currentSpace(st);
  const pane = panes(sp.root).find((p) => p.id === sp.focus);
  if (!pane) refuse("failed precondition: the space has no pane", "unavailable");
  return { sp, pane };
}

function resolveTab(st: State, given: string | undefined): { sp: Space; pane: Node; tab: NonNullable<Node["tabs"]>[number] } {
  if (given) {
    for (const sp of st.spaces) {
      for (const pane of panes(sp.root)) {
        const tab = (pane.tabs ?? []).find((t) => t.id === given || t.id.endsWith(given));
        if (tab) return { sp, pane, tab };
      }
    }
    refuse(`invalid argument: no tab "${given}"`);
  }
  const { sp, pane } = resolvePane(st, undefined);
  const tab = (pane.tabs ?? []).find((t) => t.id === pane.active) ?? pane.tabs?.[0];
  if (!tab) refuse("failed precondition: the pane has no tab", "unavailable");
  return { sp, pane, tab };
}

/** A space by id, unique id suffix or name (any case), as internal/command's SpaceID. */
function resolveSpace(st: State, given: string): Space {
  const hit = st.spaces.filter((s) => s.id === given || s.id.endsWith(given) || s.name.toLowerCase() === given.toLowerCase());
  const one = hit.length === 1 ? hit[0] : hit.find((s) => s.id === given);
  if (!one) refuse(`invalid argument: no space "${given}"`);
  return one;
}

// key: ctrl+cmd+<letter> and ctrl+cmd+<arrow> focus that way; with shift they move the pane (internal/command commands_pane.go).
const DIRS: { name: Direction; title: string; words: string; letter: string; arrow: string }[] = [
  { name: "left", title: "Left", words: "left of", letter: "h", arrow: "arrowleft" },
  { name: "down", title: "Down", words: "below", letter: "j", arrow: "arrowdown" },
  { name: "up", title: "Up", words: "above", letter: "k", arrow: "arrowup" },
  { name: "right", title: "Right", words: "right of", letter: "l", arrow: "arrowright" },
];

/** The verbs as the world registers them (a result with JSON is a promise there). */
export function layoutCommands(world: LayoutVerbsWorld): (Omit<Entry, "run"> & { run: (ctx: UiContext | undefined, args: Record<string, string>) => Promise<Out> })[] {
  return verbs(world).map((e) => ({
    ...e,
    run: (ctx, args) => {
      try {
        return Promise.resolve(e.run(ctx, args));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  }));
}

function verbs(world: LayoutVerbsWorld): Entry[] {
  const L = world.layout;
  const always = () => true;
  const run = (op: Op, msg: (r: ReturnType<MockLayout["apply"]>) => string): Out => {
    const before = L.rev;
    let out: ReturnType<MockLayout["apply"]>;
    try {
      out = L.apply(op);
    } catch (err) {
      throw layoutRpcError(err) as Error;
    }
    return { message: msg(out), resultJson: JSON.stringify({ rev: out.rev, changed: out.rev !== before, ...out.result }) };
  };
  const area = () => L.viewport ?? DEFAULT_AREA;
  const neighbourOf = (sp: Space, pane: string, dir: Direction): string | null => {
    const { width, height } = area();
    return neighbour(plainRects(sp.root as GeoNode | null, width, height), pane, dir);
  };
  const entries: Entry[] = [
    {
      cmd: {
        name: "thread.open",
        title: "Open Thread",
        category: CATEGORY,
        description: "Open a thread's tab, or focus it when it is open: in the focused pane of the thread's space (--pane: that pane, at --index; --split with --edge: a new pane on that edge of a pane; --outer: a new pane on that edge of the whole pane area), in place of the space's composer when that is all the space shows. An archived thread opens in the current space.",
        keybindings: [],
        noPalette: true,
        args: [
          str("id", "The thread", { required: true, positional: true }),
          str("pane", "The pane its tab opens in"),
          { name: "index", type: ArgType.INT, required: false, description: "With --pane: its place in the strip" },
          str("split", "In a new pane on --edge of this pane"),
          edgeArg("edge", "With --split: the edge"),
          edgeArg("outer", "In a new pane on this edge of the whole area"),
          focusArg,
        ],
      },
      when: always,
      run: (_c, a) => {
        const id = a.id ?? "";
        if (!world.hasThread(id)) refuse(`not found: thread ${id}`, "notfound");
        const st = L.state();
        if ([a.pane, a.split, a.outer].filter(Boolean).length > 1) refuse("invalid argument: give one of --pane, --split (with --edge) or --outer");
        if (a.split && !a.edge) refuse("invalid argument: --split needs --edge");
        if (a.edge && !a.split) refuse("invalid argument: --edge goes with --split; an edge of the whole area is --outer");
        const pane = a.pane || a.split ? resolvePane(st, a.pane || a.split || "").pane.id : "";
        const op: Op = { op: "open_thread", thread: id, focus: a.focus !== "false" };
        if (pane) op.pane = pane;
        if (a.index !== undefined && a.index !== "") op.index = Number(a.index);
        if (a.split) op.edge = a.edge;
        if (a.outer) op.edge = a.outer;
        if (world.isArchived?.(id)) op.archived = true;
        return run(op, (r) => `opened thread ${id} as tab ${r.result.tab ?? ""}`);
      },
    },
    {
      cmd: { name: "thread.close", title: "Close Thread Tab", category: CATEGORY, description: "Close a thread's tab from its space, with its linked tabs there.", keybindings: [], args: [str("id", "The thread (default: the active one)", { positional: true })] },
      when: always,
      run: (ctx, a) => {
        const id = a.id || ctx?.activeThreadId || "";
        if (!id) refuse("invalid argument: name a thread");
        return run({ op: "close_thread", thread: id }, () => `closed thread ${id}`);
      },
    },
    {
      cmd: { name: "tab.focus", title: "Focus Tab", category: CATEGORY, description: "Make a tab active in its pane and give it the focus.", keybindings: [], noPalette: true, args: [str("tab", "The tab", { required: true, positional: true }), focusArg] },
      when: always,
      run: (_c, a) => {
        const { tab } = resolveTab(L.state(), a.tab);
        return run({ op: "focus_tab", tab: tab.id }, () => `focused tab ${tab.id}`);
      },
    },
    {
      // internal/command commands_view_open.go threadDiffCommand: the thread's diff, focused; from that diff, the thread.
      cmd: {
        name: "view.thread-diff",
        title: "Toggle Thread Diff",
        category: "View",
        description: "Go to the focused thread's diff, opening it beside the thread when it is not open; from that diff, go back to the thread.",
        keybindings: ["cmd+shift+d"],
        args: [str("tab", "The tab to start from (default: the focused tab)"), focusArg],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const { sp, tab } = resolveTab(st, a.tab);
        const thread = tab.thread ?? "";
        if (!thread) refuse(`failed precondition: tab ${tab.id} belongs to no thread`, "unavailable");
        if (tab.kind === "diff") return run({ op: "open_thread", thread, focus: true }, (r) => `back to thread ${thread} (tab ${r.result.tab ?? ""})`);
        const c = world.threadCheckout?.(thread);
        if (!c?.projectId || !c.worktreePath) refuse(`failed precondition: thread ${thread} runs in no project worktree, so it has no diff`, "unavailable");
        const want = { kind: "diff", thread, params: { project: c.projectId, worktree: c.worktreePath, own: "1" } };
        const key = identify({ id: "", title: "", name: "", ...want }).key;
        const open = panes(sp.root)
          .flatMap((p) => p.tabs ?? [])
          .find((t) => t.key === key);
        // Focus an open one as it is (its chosen file and sides stay); else open it by the rules.
        if (open) return run({ op: "focus_tab", tab: open.id }, () => `thread ${thread}'s diff is tab ${open.id}`);
        return run({ op: "open_surface", tab: want, focus: true }, (r) => `thread ${thread}'s diff is tab ${r.result.tab ?? ""}`);
      },
    },
    {
      cmd: {
        name: "tab.move",
        title: "Move Tab",
        category: CATEGORY,
        description: "Move a tab: into another pane's strip (--pane, at --index), into a new pane on an edge of a pane (--split with --edge), onto an edge of the whole pane area (--outer), or to another space (--space). A pane moved to another space goes whole: each thread whose tab it holds moves there too, with its linked tabs (as thread.space.move).",
        keybindings: [],
        noPalette: true,
        args: [str("tab", "The tab to move", { required: true, positional: true }), str("pane", "Into this pane's strip"), { name: "index", type: ArgType.INT, required: false, description: "Its place in the strip" }, str("split", "Into a new pane on --edge of this pane"), edgeArg("edge", "With --split: the edge"), edgeArg("outer", "An edge of the whole area"), str("space", "To this space"), str("frac", "The share the new pane takes"), focusArg],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const { tab } = resolveTab(st, a.tab);
        const op: Op = { op: "move_tab", tab: tab.id };
        if (a.pane) op.pane = resolvePane(st, a.pane).pane.id;
        if (a.index !== undefined && a.index !== "") op.index = Number(a.index);
        if (a.split) {
          op.pane = resolvePane(st, a.split).pane.id;
          op.edge = a.edge;
        }
        if (a.outer) op.edge = a.outer;
        if (a.space) op.space = a.space;
        if (a.frac) op.frac = Number(a.frac);
        return run(op, (r) => `moved tab ${tab.id} to pane ${r.result.pane ?? ""}`);
      },
    },
    {
      cmd: { name: "tab.close", title: "Close Tab", category: CATEGORY, description: "Close a tab (default: the focused tab); the focus returns to what had it before. A thread's tab closes the thread from its space.", keybindings: ["cmd+w"], args: [str("tab", "The tab (default: the focused one)", { positional: true })] },
      when: always,
      run: (_c, a) => {
        const { tab } = resolveTab(L.state(), a.tab);
        return run(tab.kind === "thread" ? { op: "close_thread", thread: tab.thread ?? "" } : { op: "close_tab", tab: tab.id }, () => `closed tab ${tab.id}`);
      },
    },
    ...([
      ["tab.next", "Next Tab", 1, "cmd+shift+]"],
      ["tab.previous", "Previous Tab", -1, "cmd+shift+["],
    ] as const).map(([name, title, step, chord]): Entry => ({
      cmd: { name, title, category: CATEGORY, description: `Focus the ${step > 0 ? "next" : "previous"} tab in the pane (default: the focused pane), going round the strip.`, keybindings: [chord], args: [str("pane", "The pane (default: the focused one)"), focusArg] },
      when: always,
      run: (_c, a) => {
        const { pane } = resolvePane(L.state(), a.pane);
        const tabs = pane.tabs ?? [];
        const i = tabs.findIndex((t) => t.id === pane.active);
        const n = tabs.length;
        const next = tabs[(((i + step) % n) + n) % n]?.id ?? "";
        return run({ op: "focus_tab", tab: next }, () => `focused tab ${next}`);
      },
    })),
    {
      cmd: { name: "pane.focus", title: "Focus Pane", category: CATEGORY, description: "Give a pane the focus (its active tab takes the keyboard).", keybindings: [], noPalette: true, args: [str("pane", "The pane", { required: true }), focusArg] },
      when: always,
      run: (_c, a) => {
        const { pane } = resolvePane(L.state(), a.pane);
        return run({ op: "focus_pane", pane: pane.id }, () => `focused pane ${pane.id}`);
      },
    },
    ...DIRS.flatMap(({ name, title, words, letter, arrow }): Entry[] => [
      {
        cmd: {
          name: `pane.focus.${name}`,
          title: `Focus Pane ${title}`,
          category: CATEGORY,
          description: `Give the focus to the pane ${words} the focused pane (of several, the one focused last).`,
          keybindings: [`cmd+ctrl+${letter}`, `cmd+ctrl+${arrow}`],
          args: [str("pane", "The pane to look from (default: the focused one)"), str("to", "The neighbour, when the caller has resolved it"), focusArg],
        },
        when: always,
        run: (_c, a) => {
          const { sp, pane } = resolvePane(L.state(), a.pane);
          const to = a.to ? resolvePane(L.state(), a.to).pane.id : neighbourOf(sp, pane.id, name);
          if (!to) return { message: "", resultJson: JSON.stringify({ rev: L.rev, changed: false }) };
          return run({ op: "focus_pane", pane: to }, () => `focused pane ${to}`);
        },
      },
      {
        cmd: { name: `pane.move.${name}`, title: `Move Pane ${title}`, category: CATEGORY, description: `Swap the focused pane with the pane ${words} it: each takes the other's place and size.`, keybindings: [`cmd+ctrl+shift+${letter}`, `cmd+ctrl+shift+${arrow}`], args: [str("pane", "The pane to move from (default: the focused one)"), str("to", "The neighbour, when the caller has resolved it")] },
        when: always,
        run: (_c, a) => {
          const { sp, pane } = resolvePane(L.state(), a.pane);
          const to = a.to ? resolvePane(L.state(), a.to).pane.id : neighbourOf(sp, pane.id, name);
          if (!to) return { message: "", resultJson: JSON.stringify({ rev: L.rev, changed: false }) };
          return run({ op: "swap_pane", pane: pane.id, target: to }, () => `swapped pane ${pane.id} with ${to}`);
        },
      },
    ]),
    {
      cmd: {
        name: "pane.move",
        title: "Move Pane",
        category: CATEGORY,
        description: "Move a whole pane: beside another pane (--beside with --edge), into another pane's strip (--into, its tabs join at --index), onto an edge of the whole pane area (--outer), or to another space (--space).",
        keybindings: [],
        noPalette: true,
        args: [
          str("pane", "The pane to move", { required: true, positional: true }),
          str("beside", "Put it beside this pane, on --edge"),
          edgeArg("edge", "The edge of --beside it goes on"),
          str("into", "Merge its tabs into this pane's strip"),
          { name: "index", type: ArgType.INT, required: false, description: "With --into: where its tabs join the strip" },
          edgeArg("outer", "Put it on this edge of the whole pane area"),
          str("space", "Move it to this space"),
          str("frac", "The share it takes"),
          focusArg,
        ],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const { pane } = resolvePane(st, a.pane);
        const given = ["beside", "into", "outer", "space"].filter((k) => a[k]);
        if (given.length !== 1) refuse("invalid argument: give one of --beside (with --edge), --into, --outer or --space");
        const frac = a.frac ? { frac: Number(a.frac) } : {};
        let op: Op;
        if (a.beside) {
          if (!a.edge) refuse("invalid argument: --beside needs --edge");
          op = { op: "move_pane", pane: pane.id, target: resolvePane(st, a.beside).pane.id, edge: a.edge, ...frac };
        } else if (a.into) {
          op = { op: "merge_pane", pane: pane.id, target: resolvePane(st, a.into).pane.id, ...(a.index !== undefined && a.index !== "" ? { index: Number(a.index) } : {}) };
        } else if (a.outer) {
          op = { op: "move_pane", pane: pane.id, edge: a.outer, ...frac };
        } else {
          op = { op: "move_pane", pane: pane.id, space: a.space };
        }
        return run(op, (r) => `moved pane ${pane.id} (now pane ${r.result.pane ?? ""} in space ${r.result.space ?? ""})`);
      },
    },
    {
      cmd: {
        name: "pane.split",
        title: "Split Pane",
        category: CATEGORY,
        description: "Split a tab off a pane (default: the focused pane's active tab) into a new pane on an edge of it.",
        keybindings: [],
        args: [str("pane", "The pane (default: the focused one)"), str("tab", "The tab to split off (default: the pane's active tab)"), edgeArg("edge", "The edge the new pane goes on", { defaultValue: "right" }), str("frac", "The share the new pane takes"), focusArg],
      },
      when: always,
      run: (_c, a) => {
        const { pane } = resolvePane(L.state(), a.pane);
        const tabs = pane.tabs ?? [];
        if (tabs.length < 2) refuse(`failed precondition: pane ${pane.id} has one tab: nothing to split off`, "unavailable");
        const tab = a.tab ? resolveTab(L.state(), a.tab).tab.id : (pane.active ?? "");
        return run({ op: "move_tab", tab, pane: pane.id, edge: a.edge || "right", ...(a.frac ? { frac: Number(a.frac) } : {}) }, (r) => `split tab ${tab} off pane ${pane.id} into pane ${r.result.pane ?? ""}`);
      },
    },
    {
      cmd: { name: "pane.close", title: "Close Pane", category: CATEGORY, description: "Close a pane and its tabs (default: the focused pane). Each thread in it closes as thread.close closes it.", keybindings: ["cmd+shift+w"], args: [str("pane", "The pane (default: the focused one)", { positional: true })] },
      when: always,
      run: (_c, a) => {
        const { pane } = resolvePane(L.state(), a.pane);
        return run({ op: "close_pane", pane: pane.id }, () => `closed pane ${pane.id}`);
      },
    },
    {
      cmd: { name: "pane.resize", title: "Resize Panes", category: CATEGORY, description: "Set the shares of a split's children, e.g. --split s-3k2j --sizes 0.6,0.4.", keybindings: [], noPalette: true, args: [str("split", "The split", { required: true }), str("sizes", "One share per child, comma separated", { required: true })] },
      when: always,
      run: (_c, a) => {
        const sizes = (a.sizes ?? "").split(",").map((s) => Number(s.trim()));
        if (sizes.some((n) => !Number.isFinite(n))) refuse(`invalid argument: --sizes ${a.sizes ?? ""}: comma-separated numbers`);
        return run({ op: "set_sizes", split: a.split ?? "", sizes }, () => `resized split ${a.split ?? ""}`);
      },
    },
    {
      cmd: { name: "space.new", title: "New Space", category: CATEGORY, description: "A new space after the others.", keybindings: [], args: [str("name", "Its name"), focusArg] },
      when: always,
      run: (_c, a) => run({ op: "new_space", ...(a.name ? { name: a.name } : {}), switch: a.focus !== "false" }, (r) => `new space ${r.result.space ?? ""}`),
    },
    {
      cmd: { name: "space.switch", title: "Switch Space", category: CATEGORY, description: "Show another space (by id, name or --index from 1).", keybindings: [], args: [str("space", "The space", { positional: true }), { name: "index", type: ArgType.INT, required: false, description: "The space's place in the top bar, from 1" }, focusArg] },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const sp = a.index ? st.spaces[Number(a.index) - 1] : st.spaces.find((s) => s.id === a.space || s.name.toLowerCase() === (a.space ?? "").toLowerCase());
        if (!sp) refuse(`invalid argument: no space "${a.space ?? a.index ?? ""}"`);
        return run({ op: "switch_space", space: sp.id }, () => `switched to space ${sp.id}`);
      },
    },
    {
      cmd: { name: "space.rename", title: "Rename Space", category: CATEGORY, description: "Rename a space (default: the current one).", keybindings: [], args: [str("name", "The new name", { required: true, positional: true }), str("space", "The space to rename")] },
      when: always,
      run: (_c, a) => {
        const sp = a.space ? resolveSpace(L.state(), a.space) : currentSpace(L.state());
        return run({ op: "rename_space", space: sp.id, name: a.name ?? "" }, () => `space ${sp.id} is "${a.name ?? ""}"`);
      },
    },
    {
      cmd: { name: "space.move", title: "Move Space", category: CATEGORY, description: "Move a space to another place in the top bar (--index, from 1).", keybindings: [], noPalette: true, args: [str("space", "The space", { required: true, positional: true }), { name: "index", type: ArgType.INT, required: true, description: "Its new place, from 1" }] },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const sp = resolveSpace(st, a.space ?? "");
        const i = Number(a.index);
        if (!(i >= 1 && i <= st.spaces.length)) refuse(`invalid argument: index ${a.index ?? ""}: there are ${String(st.spaces.length)} spaces`);
        const order = st.spaces.map((s) => s.id).filter((id) => id !== sp.id);
        order.splice(i - 1, 0, sp.id);
        return run({ op: "reorder_spaces", order }, () => `space ${sp.id} is now ${String(i)} of ${String(order.length)}`);
      },
    },
    {
      cmd: {
        name: "space.remove",
        title: "Remove Space",
        category: CATEGORY,
        description: "Remove a space: its tabs and panes close, and its threads move to another space (--to) or are archived (--archive). The last space cannot be removed.",
        keybindings: [],
        args: [str("space", "The space", { positional: true }), str("to", "The space its threads move to"), { name: "archive", type: ArgType.BOOL, required: false, description: "Archive its threads instead" }],
      },
      when: always,
      run: (_c, a) => {
        const st = L.state();
        const sp = a.space ? resolveSpace(st, a.space) : currentSpace(st);
        if (st.spaces.length < 2) refuse(`failed precondition: space ${sp.id} is the last space`, "unavailable");
        const archive = a.archive === "true";
        const to = archive ? "" : a.to ? resolveSpace(st, a.to).id : "";
        if (archive) {
          const ids = (world.sidebarThreads?.() ?? []).filter((id) => (st.threads?.[id]?.space ?? st.default_space) === sp.id);
          for (const id of ids) world.archiveThread?.(id);
        }
        return run({ op: "remove_space", space: sp.id, ...(to ? { to } : {}) }, () => `removed space ${sp.id} "${sp.name}"`);
      },
    },
    {
      cmd: { name: "thread.space.move", title: "Move Thread to Space", category: CATEGORY, description: "Move a thread to another space, with its linked tabs there.", keybindings: [], args: [str("id", "The thread (default: the active one)", { positional: true }), str("space", "The space", { required: true })] },
      when: always,
      run: (c, a) => {
        const thread = a.id || c?.activeThreadId || "";
        if (!thread) refuse("invalid argument: name a thread");
        const sp = resolveSpace(L.state(), a.space ?? "");
        return run({ op: "move_thread", thread, space: sp.id }, () => `thread ${thread} is in space ${sp.id} "${sp.name}"`);
      },
    },
    {
      cmd: {
        name: "composer.new",
        title: "New Thread in a Tab",
        category: CATEGORY,
        description: "Focus the space's empty composer, or open one in the focused pane. --project, --workspace or --like say what the thread will start from.",
        keybindings: [],
        noPalette: true,
        args: [str("space", "The space"), str("pane", "The pane it opens in"), str("project", "The project the thread starts in"), str("workspace", "The workspace the thread starts in"), str("like", "A thread the new one starts like"), focusArg],
      },
      when: always,
      run: (_c, a) => {
        const params: Record<string, string> = {};
        for (const k of ["project", "workspace", "like"]) if (a[k]) params[k] = a[k];
        return run(
          { op: "new_thread", ...(a.space ? { space: a.space } : {}), ...(a.pane ? { pane: resolvePane(L.state(), a.pane).pane.id } : {}), ...(Object.keys(params).length > 0 ? { params } : {}), focus: a.focus !== "false" },
          (r) => `composer tab ${r.result.tab ?? ""} in pane ${r.result.pane ?? ""}`,
        );
      },
    },
    {
      cmd: { name: "composer.draft.start", title: "Start Draft", category: CATEGORY, description: "Turn an empty composer tab into a draft (its first text was typed). Prints the draft's id.", keybindings: [], noPalette: true, args: [str("tab", "The empty composer's tab", { required: true }), str("id", "The draft's id, when the caller chose one"), str("label", "Its label: the text's first line")] },
      when: always,
      run: (_c, a) => run({ op: "start_draft", tab: a.tab ?? "", ...(a.id ? { draft: a.id } : {}), ...(a.label ? { label: a.label } : {}) }, (r) => `draft ${r.result.draft ?? ""}`),
    },
    {
      cmd: { name: "composer.draft.label", title: "Label Draft", category: CATEGORY, description: "Set a draft's label (one line, at most 80 characters).", keybindings: [], noPalette: true, args: [str("draft", "The draft", { required: true, positional: true }), str("label", "The label", { positional: true })] },
      when: always,
      run: (_c, a) => run({ op: "label_draft", draft: a.draft ?? "", label: a.label ?? "" }, () => `labelled draft ${a.draft ?? ""}`),
    },
    {
      cmd: { name: "composer.draft.clear", title: "Clear Draft", category: CATEGORY, description: "End a draft whose text was deleted: its tab is the space's empty composer again, or closes when the space has one already.", keybindings: [], noPalette: true, args: [str("draft", "The draft", { required: true, positional: true })] },
      when: always,
      run: (_c, a) => run({ op: "clear_draft", draft: a.draft ?? "" }, () => `cleared draft ${a.draft ?? ""}`),
    },
    {
      cmd: { name: "composer.draft.discard", title: "Discard Draft", category: CATEGORY, description: "End a draft and close its tab when it is open.", keybindings: [], noPalette: true, args: [str("draft", "The draft", { required: true, positional: true })] },
      when: always,
      run: (_c, a) => run({ op: "discard_draft", draft: a.draft ?? "" }, () => `discarded draft ${a.draft ?? ""}`),
    },
    {
      cmd: { name: "composer.draft.open", title: "Open Draft", category: CATEGORY, description: "Focus a draft's tab, or open it in its space's focused pane.", keybindings: [], noPalette: true, args: [str("draft", "The draft", { required: true, positional: true }), focusArg] },
      when: always,
      run: (_c, a) => run({ op: "open_draft", draft: a.draft ?? "", focus: a.focus !== "false" }, (r) => `draft ${r.result.draft ?? ""} is tab ${r.result.tab ?? ""}`),
    },
  ];
  return entries;
}

