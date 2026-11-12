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
import { layoutRpcError, panes, type MockLayout, type Node, type Op, type Space, type State } from "./layout";

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
  /** Whether a thread exists. */
  hasThread(id: string): boolean;
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

const DIRS: { name: Direction; title: string; words: string }[] = [
  { name: "left", title: "Left", words: "left of" },
  { name: "down", title: "Down", words: "below" },
  { name: "up", title: "Up", words: "above" },
  { name: "right", title: "Right", words: "right of" },
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
        description: "Open a thread's tab, or focus it when it is open: in the focused pane of the thread's space (--pane: that pane), in place of the space's composer when that is all the space shows.",
        keybindings: [],
        noPalette: true,
        args: [str("id", "The thread", { required: true, positional: true }), str("pane", "The pane its tab opens in"), focusArg],
      },
      when: always,
      run: (_c, a) => {
        const id = a.id ?? "";
        if (!world.hasThread(id)) refuse(`not found: thread ${id}`, "notfound");
        return run({ op: "open_thread", thread: id, ...(a.pane ? { pane: resolvePane(L.state(), a.pane).pane.id } : {}), focus: a.focus !== "false" }, (r) => `opened thread ${id} as tab ${r.result.tab ?? ""}`);
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
      cmd: {
        name: "tab.move",
        title: "Move Tab",
        category: CATEGORY,
        description: "Move a tab: into another pane's strip (--pane, at --index), into a new pane on an edge of a pane (--split with --edge), onto an edge of the whole pane area (--outer), or to another space (--space).",
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
      cmd: { name: "tab.close", title: "Close Tab", category: CATEGORY, description: "Close a tab (default: the focused tab); the focus returns to what had it before. A thread's tab closes the thread from its space.", keybindings: [], args: [str("tab", "The tab (default: the focused one)", { positional: true })] },
      when: always,
      run: (_c, a) => {
        const { tab } = resolveTab(L.state(), a.tab);
        return run(tab.kind === "thread" ? { op: "close_thread", thread: tab.thread ?? "" } : { op: "close_tab", tab: tab.id }, () => `closed tab ${tab.id}`);
      },
    },
    ...([
      ["tab.next", "Next Tab", 1],
      ["tab.previous", "Previous Tab", -1],
    ] as const).map(([name, title, step]): Entry => ({
      cmd: { name, title, category: CATEGORY, description: `Focus the ${step > 0 ? "next" : "previous"} tab in the pane (default: the focused pane), going round the strip.`, keybindings: [], args: [str("pane", "The pane (default: the focused one)"), focusArg] },
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
    ...DIRS.flatMap(({ name, title, words }): Entry[] => [
      {
        cmd: {
          name: `pane.focus.${name}`,
          title: `Focus Pane ${title}`,
          category: CATEGORY,
          description: `Give the focus to the pane ${words} the focused pane (of several, the one focused last).`,
          keybindings: [],
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
        cmd: { name: `pane.move.${name}`, title: `Move Pane ${title}`, category: CATEGORY, description: `Swap the focused pane with the pane ${words} it: each takes the other's place and size.`, keybindings: [], args: [str("pane", "The pane to move from (default: the focused one)"), str("to", "The neighbour, when the caller has resolved it")] },
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
      cmd: { name: "pane.close", title: "Close Pane", category: CATEGORY, description: "Close a pane and its tabs (default: the focused pane). Each thread in it closes as thread.close closes it.", keybindings: [], args: [str("pane", "The pane (default: the focused one)", { positional: true })] },
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
  ];
  return entries;
}

