/**
 * A seeded generator of plugin views over every node kind and both strips, nested to the
 * depth limit (pluginsdk/ui MaxDepth 4 containers), and the mutations a plugin's next view
 * makes (keys reordered, nodes removed, kinds swapped under the same key, a selected row
 * deleted, a tabs node's active tab removed, strips added and removed, reset tokens). Used
 * by components/plugin/layoutfuzz.test.tsx and e2e/plugins-layout-fuzz.spec.ts. Keys are
 * unique in a view and match the daemon's pattern; numbers include the bounds and some the
 * daemon refuses (stale selected rows, active tabs that are not tabs) so the GUI's own
 * fallbacks are exercised too.
 */
import type { NodeHeight, PluginViewModel, Row, ViewButton, ViewNode, ViewTab } from "@/api/plugin";

/** mulberry32: a small seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The widths the layout thresholds sit at (240 column, 492 two columns, 612 master-detail, 1080 wide container). */
export const FUZZ_WIDTHS = [0, 1, 239, 240, 491, 492, 611, 612, 1079, 1080, 4000] as const;

/** Threads and terminals the fuzz test's stores know (a node naming another shows "gone"). */
export const FUZZ_THREADS = ["s-f1", "s-f2", "s-f3", "s-f4"] as const;
export const FUZZ_TERMINALS = ["t-f1", "t-f2"] as const;

const CONTAINERS = ["section", "columns", "pane", "grid", "container", "masterDetail", "tabs"] as const;
const LEAVES = ["text", "markdown", "pairs", "list", "chips", "log", "actions", "progress", "notice", "empty", "form", "thread", "terminal", "divider", "spacer", "group"] as const;
const GROUP_KINDS = ["text", "chips", "actions", "progress"] as const;
const STRIP_KINDS = ["text", "chips", "actions", "progress", "form", "divider", "spacer", "group"] as const;
export const MAX_DEPTH = 4;

export class Gen {
  private n = 0;
  constructor(
    readonly rand: () => number,
    private readonly prefix = "k",
  ) {}

  key(role = ""): string {
    this.n++;
    return `${this.prefix}${role}${String(this.n)}`;
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)] as T;
  }

  height(): NodeHeight | undefined {
    const r = this.rand();
    if (r < 0.3) return undefined;
    if (r < 0.4) return "auto";
    if (r < 0.7) return "fill";
    return this.pick([120, 180, 240, 600, 1600]);
  }

  button(): ViewButton {
    const key = this.key("b");
    const r = this.rand();
    const action = r < 0.6 ? { event: "click" } : r < 0.75 ? { copy: "copied" } : r < 0.9 ? { openUrl: "https://example.com" } : { command: { name: "plugin.hello.greet" } };
    return { key, label: this.pick(["Run", "Re-run the whole pipeline again", "Go"]), action, ...(this.chance(0.1) ? { busy: true } : {}), ...(this.chance(0.1) ? { disabled: true } : {}) };
  }

  rows(n: number): Row[] {
    return Array.from({ length: n }, () => {
      const key = this.key("r");
      const r = this.rand();
      const action = r < 0.5 ? undefined : r < 0.7 ? { event: "open", data: key } : r < 0.8 ? { openUrl: "https://example.com" } : r < 0.9 ? { copy: key } : { command: { name: "plugin.hello.greet" } };
      return {
        key,
        title: this.chance(0.1) ? "A very long row title that does not fit in the side panel at all, really".repeat(2) : `Row ${key}`,
        ...(action ? { action } : {}),
        ...(this.chance(0.3) ? { glyph: { status: this.pick(["ok", "failed", "running"] as const) } } : {}),
        ...(this.chance(0.2) ? { actions: [this.button()] } : {}),
        ...(this.chance(0.1) ? { selected: true } : {}),
      };
    });
  }

  form(strip: boolean): ViewNode {
    const key = this.key("form");
    const fields = Array.from({ length: this.int(1, 3) }, (_, i) => {
      const fk = this.key("f");
      const r = this.rand();
      if (r < 0.6) return { key: fk, name: `n${String(i)}`, label: "Field", input: { placeholder: "type", ...(this.chance(0.3) ? { value: "v" } : {}) } };
      if (r < 0.8 || strip) return { key: fk, name: `n${String(i)}`, label: "Toggle", toggle: { value: this.chance(0.5) } };
      return { key: fk, name: `n${String(i)}`, label: "Pick", select: { options: [{ key: this.key("o"), value: "a", label: "A" }, { key: this.key("o"), value: "b", label: "B" }] } };
    });
    return {
      key,
      form: {
        fields,
        submit: { key: this.key("submit"), label: "Save", action: { event: "save" } },
        ...(this.chance(0.3) ? { resetToken: String(this.int(0, 3)) } : {}),
        ...(this.chance(0.1) ? { error: "No" } : {}),
        ...(this.chance(0.1) ? { busy: true } : {}),
      },
    };
  }

  leaf(kind: (typeof LEAVES)[number], strip = false): ViewNode {
    const key = this.key(kind.slice(0, 2));
    switch (kind) {
      case "text":
        return { key, text: { content: this.chance(0.2) ? "x".repeat(300) : "Some text", ...(this.chance(0.3) ? { size: this.pick(["sm", "lg"] as const) } : {}) } };
      case "markdown":
        return { key, markdown: { source: "**bold** and `code`\n\n- a\n- b" } };
      case "pairs":
        return { key, pairs: { items: [{ key: this.key("p"), label: "Branch", value: "main" }] } };
      case "list":
        return { key, list: { rows: this.rows(this.chance(0.05) ? 45 : this.int(0, 5)), ...(this.chance(0.3) ? { emptyText: "Nothing" } : {}), ...(this.chance(0.2) ? { dense: true } : {}) } };
      case "chips":
        return { key, chips: { chips: Array.from({ length: this.int(1, 5) }, () => ({ key: this.key("c"), label: "Chip", action: { event: "chip" }, ...(this.chance(0.2) ? { selected: true } : {}) })) } };
      case "log":
        return { key, log: { lines: Array.from({ length: this.int(0, 30) }, (_, i) => ({ text: `line ${String(i)}` })), ...(this.chance(0.3) ? { rows: this.pick([4, 40]) } : {}) } };
      case "actions":
        return { key, actions: { buttons: Array.from({ length: this.int(1, 3) }, () => this.button()), ...(this.chance(0.4) ? { align: this.pick(["start", "end"] as const) } : {}) } };
      case "progress":
        return { key, progress: { ...(this.chance(0.7) ? { value: this.rand() } : {}), ...(this.chance(0.5) ? { label: "Building" } : {}) } };
      case "notice":
        return { key, notice: { title: "Heads up", tone: this.pick(["", "attention", "error"] as const), ...(this.chance(0.3) ? { actions: [this.button()] } : {}) } };
      case "empty":
        return { key, empty: { title: "Nothing here", ...(this.chance(0.4) ? { actions: [this.button()] } : {}) } };
      case "form":
        return this.form(strip);
      case "thread": {
        const h = this.height();
        return { key, thread: { threadId: this.chance(0.9) ? this.pick(FUZZ_THREADS) : "s-unknown", ...(h !== undefined ? { height: h } : {}), ...(this.chance(0.2) ? { readOnly: true } : {}) } };
      }
      case "terminal": {
        const h = this.height();
        return { key, terminal: { terminalId: this.chance(0.9) ? this.pick(FUZZ_TERMINALS) : "t-unknown", ...(h !== undefined ? { height: h } : {}), ...(this.chance(0.3) ? { rows: this.pick([4, 60]) } : {}) } };
      }
      case "divider":
        return { key, divider: strip || this.chance(0.5) ? {} : { label: this.chance(0.2) ? "L".repeat(200) : "Checks" } };
      case "spacer":
        return { key, spacer: { ...(this.chance(0.5) ? { size: this.pick([4, 12, 64]) } : {}), ...(this.chance(0.4) ? { flex: true } : {}) } };
      case "group":
        return {
          key,
          group: {
            items: Array.from({ length: this.int(1, 8) }, () => this.leaf(this.pick(GROUP_KINDS))),
            ...(this.chance(0.6) ? { align: this.pick(["start", "center", "end", "between"] as const) } : {}),
            ...(this.chance(0.3) ? { noWrap: true } : {}),
          },
        };
    }
  }

  /** A tabs node's or the view's tabs: 2..8, the active one usually one of them. */
  tabItems(n: number): ViewTab[] {
    return Array.from({ length: n }, () => ({ key: this.key("tab"), label: this.chance(0.2) ? "A long tab title here" : "Tab", ...(this.chance(0.2) ? { badge: { label: "1 error", tone: "error" as const } } : {}) }));
  }

  children(depth: number, max = 3): ViewNode[] {
    return Array.from({ length: this.int(0, max) }, () => this.node(depth));
  }

  container(kind: (typeof CONTAINERS)[number], depth: number): ViewNode {
    const key = this.key(kind.slice(0, 2));
    const d = depth + 1;
    switch (kind) {
      case "section":
        return { key, section: { title: "Section", children: this.children(d), ...(this.chance(0.4) ? { collapsible: true } : {}), ...(this.chance(0.3) ? { collapsed: true } : {}), ...(this.chance(0.4) ? { card: true } : {}) } };
      case "columns":
        return {
          key,
          columns: {
            items: Array.from({ length: this.int(2, 4) }, () => ({
              key: this.key("col"),
              children: this.children(d),
              ...(this.chance(0.3) ? (this.chance(0.5) ? { weight: this.int(1, 6) } : { width: this.pick([160, 300, 640]) }) : {}),
            })),
            ...(this.chance(0.4) ? { collapse: this.pick(["stack", "first"] as const) } : {}),
          },
        };
      case "pane": {
        const h = this.height();
        return { key, pane: { children: this.children(d), ...(h !== undefined ? { height: h } : {}), ...(this.chance(0.3) ? { minHeight: this.pick([0, 120, 1600]) } : {}), ...(this.chance(0.3) ? { noScroll: true } : {}) } };
      }
      case "grid":
        return {
          key,
          grid: {
            items: Array.from({ length: this.int(1, 6) }, () => ({ key: this.key("gi"), children: this.children(d, 2), ...(this.chance(0.3) ? { span: this.pick([1, 2]) } : {}) })),
            ...(this.chance(0.4) ? { minWidth: this.pick([160, 240, 480]) } : {}),
          },
        };
      case "container":
        return { key, container: { children: this.children(d), ...(this.chance(0.6) ? { width: this.pick(["narrow", "wide", "full"] as const) } : {}) } };
      case "masterDetail": {
        const rows = this.rows(this.int(0, 6));
        const r = this.rand();
        const selected = r < 0.4 || rows.length === 0 ? "" : r < 0.9 ? this.pick(rows).key : "stale-row";
        return {
          key,
          masterDetail: {
            list: { rows, ...(this.chance(0.3) ? { emptyText: "No runs" } : {}) },
            selected,
            detail: selected === "" ? [] : this.children(d),
            ...(this.chance(0.3) ? { listWidth: this.pick([200, 280, 400]) } : {}),
            ...(this.chance(0.5) ? { emptyDetail: { title: "No run chosen", ...(this.chance(0.4) ? { actions: [this.button()] } : {}) } } : {}),
            ...(this.chance(0.4) ? { resetToken: String(this.int(0, 2)) } : {}),
          },
        };
      }
      case "tabs": {
        const items = this.tabItems(this.int(2, 8));
        const active = this.chance(0.9) ? this.pick(items).key : "stale-tab";
        return { key, tabs: { items, active, children: this.children(d) } };
      }
    }
  }

  /** A node `depth` containers deep: a container while one more fits, else a leaf. */
  node(depth: number): ViewNode {
    if (depth < MAX_DEPTH && this.chance(depth === 0 ? 0.55 : 0.4)) return this.container(this.pick(CONTAINERS), depth);
    return this.leaf(this.pick(LEAVES));
  }

  strip(): ViewNode[] {
    return Array.from({ length: this.int(1, 6) }, () => this.leaf(this.pick(STRIP_KINDS), true));
  }

  view(): PluginViewModel {
    const tabs = this.chance(0.5) ? this.tabItems(this.int(1, 4)) : null;
    return {
      header: { title: "Fuzz" },
      ...(tabs ? { tabs: { items: tabs, active: this.pick(tabs).key } } : {}),
      ...(this.chance(0.4) ? { toolbar: this.strip() } : {}),
      nodes: Array.from({ length: this.int(1, 6) }, () => this.node(0)),
      ...(this.chance(0.4) ? { footer: this.strip() } : {}),
    };
  }
}

/** Every node list of a view (a toolbar, the body, a footer, every container's lists), for mutation in place. */
export function nodeListsOf(v: PluginViewModel): ViewNode[][] {
  const out: ViewNode[][] = [];
  const walk = (l: ViewNode[]) => {
    out.push(l);
    for (const n of l) {
      if (n.section) walk(n.section.children);
      if (n.columns) for (const c of n.columns.items) walk(c.children);
      if (n.pane) walk(n.pane.children);
      if (n.grid) for (const it of n.grid.items) walk(it.children);
      if (n.group) walk(n.group.items);
      if (n.container) walk(n.container.children);
      if (n.masterDetail) walk(n.masterDetail.detail);
      if (n.tabs) walk(n.tabs.children);
    }
  };
  if (v.toolbar) walk(v.toolbar);
  walk(v.nodes);
  if (v.footer) walk(v.footer);
  return out;
}

export function allNodes(v: PluginViewModel): ViewNode[] {
  return nodeListsOf(v).flat();
}

function depthOf(v: PluginViewModel, target: ViewNode): number {
  let found = 0;
  const walk = (l: ViewNode[], d: number) => {
    for (const n of l) {
      if (n === target) found = d;
      const inner = n.group ? d : d + 1;
      if (n.section) walk(n.section.children, inner);
      if (n.columns) for (const c of n.columns.items) walk(c.children, inner);
      if (n.pane) walk(n.pane.children, inner);
      if (n.grid) for (const it of n.grid.items) walk(it.children, inner);
      if (n.group) walk(n.group.items, d);
      if (n.container) walk(n.container.children, inner);
      if (n.masterDetail) walk(n.masterDetail.detail, inner);
      if (n.tabs) walk(n.tabs.children, inner);
    }
  };
  walk(v.nodes, 0);
  return found;
}

export const MUTATIONS = ["reorder", "remove", "swapKind", "deleteSelectedRow", "selectOther", "dropActiveTab", "switchNodeTab", "strips", "resetToken", "viewTab", "toggleCollapsed", "heights"] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** The plugin's next view: a copy of v with one mutation (named in the result). */
export function mutateView(v: PluginViewModel, g: Gen): { view: PluginViewModel; what: Mutation } {
  const next = structuredClone(v);
  const what = g.pick(MUTATIONS);
  const lists = nodeListsOf(next);
  const nodes = allNodes(next);
  const mds = nodes.filter((n) => n.masterDetail);
  const tabsNodes = nodes.filter((n) => n.tabs);
  switch (what) {
    case "reorder": {
      const l = g.pick(lists);
      for (let i = l.length - 1; i > 0; i--) {
        const j = Math.floor(g.rand() * (i + 1));
        [l[i], l[j]] = [l[j] as ViewNode, l[i] as ViewNode];
      }
      for (const md of mds) md.masterDetail?.list.rows?.reverse();
      break;
    }
    case "remove": {
      const l = g.pick(lists.filter((x) => x.length > 1).concat([next.nodes]));
      if (l.length > 1) l.splice(Math.floor(g.rand() * l.length), 1);
      break;
    }
    case "swapKind": {
      if (nodes.length === 0) break;
      const n = g.pick(nodes);
      const key = n.key;
      const depth = depthOf(next, n);
      const repl = depth < MAX_DEPTH && g.chance(0.5) ? g.container(g.pick(CONTAINERS), depth) : g.leaf(g.pick(LEAVES));
      for (const k of Object.keys(n)) Reflect.deleteProperty(n, k);
      Object.assign(n, repl, { key });
      break;
    }
    case "deleteSelectedRow": {
      const md = mds.length > 0 ? g.pick(mds).masterDetail : undefined;
      if (!md?.list.rows || !md.selected) break;
      md.list.rows = md.list.rows.filter((r) => r.key !== md.selected);
      // The plugin either keeps its (now stale) selection or clears it.
      if (g.chance(0.6)) {
        md.selected = "";
        md.detail = [];
      }
      break;
    }
    case "selectOther": {
      const md = mds.length > 0 ? g.pick(mds).masterDetail : undefined;
      const rows = md?.list.rows ?? [];
      if (!md || rows.length === 0) break;
      md.selected = g.pick(rows).key;
      md.detail = g.children(1);
      break;
    }
    case "dropActiveTab": {
      const t = tabsNodes.length > 0 ? g.pick(tabsNodes).tabs : undefined;
      if (!t) break;
      t.items = t.items.filter((x) => x.key !== t.active);
      if (t.items.length === 0) t.items = g.tabItems(2);
      break;
    }
    case "switchNodeTab": {
      const t = tabsNodes.length > 0 ? g.pick(tabsNodes).tabs : undefined;
      if (!t) break;
      t.active = g.pick(t.items).key;
      t.children = g.children(1);
      break;
    }
    case "strips": {
      if (next.toolbar && g.chance(0.5)) delete next.toolbar;
      else next.toolbar = g.strip();
      if (next.footer && g.chance(0.5)) delete next.footer;
      else if (g.chance(0.5)) next.footer = g.strip();
      break;
    }
    case "resetToken": {
      for (const n of nodes) {
        if (n.masterDetail) n.masterDetail.resetToken = g.key("tok");
        if (n.form) n.form.resetToken = g.key("tok");
      }
      break;
    }
    case "viewTab": {
      if (next.tabs && next.tabs.items.length > 1) {
        next.tabs.active = g.pick(next.tabs.items).key;
        next.nodes = Array.from({ length: g.int(1, 4) }, () => g.node(0));
      }
      break;
    }
    case "toggleCollapsed": {
      for (const n of nodes) if (n.section) n.section.collapsed = !(n.section.collapsed ?? false);
      break;
    }
    case "heights": {
      for (const n of nodes) {
        if (n.pane) n.pane.height = g.height();
        if (n.thread) n.thread.height = g.height();
      }
      break;
    }
  }
  return { view: next, what };
}

/** Every key of a view that must be unique (nodes, rows, tabs, columns, grid items, buttons, chips, fields), with duplicates. */
export function duplicateKeys(v: PluginViewModel): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  const add = (k: string) => {
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  };
  JSON.stringify(v, (k, x: unknown) => {
    if (k === "key" && typeof x === "string") add(x);
    return x;
  });
  return dup;
}
