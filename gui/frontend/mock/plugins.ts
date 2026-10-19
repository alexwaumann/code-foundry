/**
 * Plugins in the mock daemon (docs/notes/plugins-5-gui.md): three installed plugins, the
 * hello example's demo surface driven from the captured views of the real one
 * (internal/store/plugin/testdata/hello-demo), and PluginService.
 *
 *   hello       running, dev; surfaces demo (any thread), pinned (a thread the demo's Pin
 *               button pinned: availability flips) and checks (never available here)
 *   crasher     crashed (restarts 3, last error), surface "status" (global)
 *   acme-data   disabled, never consented: enabling asks (plugin.enable's confirm is the
 *               consent text); once enabled its global "access" surface shows
 *
 * The demo acts like the real plugin (plugins/examples/hello/surface.go): tabs, a click
 * counter in the header, Pin, a form whose save needs a name (else the plugin refuses)
 * and toasts "saved", a build that appends six log lines 300 ms apart.
 *
 * Controls (mock/server.ts): POST /__mock/plugin/state?name=hello&state=crashed|running|failed
 * (the plugin goes down or comes back; its open surfaces follow), POST /__mock/plugin/toast?text=…
 * (a view/toast without an instance: a Notify intent), POST /__mock/plugin/invoke?command=…
 * (a host/invoke with confirm "ask": an InvokeCommand intent), POST /__mock/plugin/demotab?tab=…
 * (the demo shows a tab, "stress" included: two threads and a terminal), GET /__mock/plugin/acts.
 */
import { readFileSync } from "node:fs";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import {
  PluginState,
  SurfacePhase,
  type PluginEventSchema,
  type PluginSchema,
  type PluginEnvironmentSchema,
  type SurfaceActRequest,
  type SurfaceRef,
  type SurfaceUpdateSchema,
} from "../src/gen/codefoundry/v1/plugin_pb";
import { UiIntent_Notify_Level } from "../src/gen/codefoundry/v1/ui_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import { Hub } from "./hub";
import { MockRegistry, type InstallSpec } from "./pluginRegistry";
import type { UiIntentInit } from "./world";

export type PluginEventInit = MessageInitShape<typeof PluginEventSchema>;
type PluginInit = MessageInitShape<typeof PluginSchema>;
type SurfaceUpdateInit = MessageInitShape<typeof SurfaceUpdateSchema>;
type EnvironmentInit = MessageInitShape<typeof PluginEnvironmentSchema>;

interface ArgDef {
  name: string;
  type: ArgType;
  required: boolean;
  description: string;
}

/** A command as World's registry takes it (mock/world.ts CmdDef + when + run). */
export interface PluginCommand {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    args: ArgDef[];
    confirm?: (ctx: UiContext | undefined, args: Record<string, string>) => string;
    confirmIf?: (ctx: UiContext | undefined, args: Record<string, string>) => boolean;
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
}

interface SurfaceDef {
  id: string;
  title: string;
  icon: string;
  scope: "global" | "thread";
  /** Beyond the scope's context. */
  when?: (ctx: UiContext | undefined) => boolean;
}

interface MockPlugin {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: PluginState;
  enabled: boolean;
  dev: boolean;
  needsConsent: boolean;
  /** Whether the user consented before (a re-consent then says "more than before"). */
  granted: boolean;
  disabledReason: string;
  lastError: string;
  restarts: number;
  pid: number;
  startedAt: Date;
  permissions: { commands: string[]; events: string[]; threadStatus: boolean; sessionEnv: boolean; secrets: boolean; threads?: boolean; terminals?: boolean };
  commands: { name: string; title: string; description: string }[];
  surfaces: SurfaceDef[];
  /** Where plugin install got it (mock/pluginRegistry.ts); none for hand-placed or dev plugins. */
  install?: { kind: string; source: string };
}

/** The hello plugin's own thread and terminal in the default world (mock/world.ts seeds them; the demo's Assistant and Shell tabs show them). */
export const HELLO_THREAD = "s-hello-assistant";
export const HELLO_TERMINAL = "t-hello-clock";

/** The views were captured at this moment; their times shift by (now - this). */
const CAPTURED_AT = Date.parse("2026-10-18T09:02:16.311-05:00");

function fixture(name: string): Record<string, unknown> {
  const url = new URL(`../../../internal/store/plugin/testdata/hello-demo/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

/** Every `"at": "<RFC 3339>"` in a JSON value moved by `shiftMs`. */
function shiftTimes(v: unknown, shiftMs: number): unknown {
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, shiftMs));
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = k === "at" && typeof x === "string" ? new Date(Date.parse(x) + shiftMs).toISOString() : shiftTimes(x, shiftMs);
  }
  return out;
}

type Node = Record<string, unknown> & { key: string };

/** The node lists a node holds: a section's children, each column's, a pane's, each grid item's, a group's items, a container's, a master-detail's detail, a tabs node's children (api/plugin.ts childLists). */
function childListsOf(n: Node): Node[][] {
  const sec = n.section as { children?: Node[] } | undefined;
  const cols = n.columns as { items?: { children?: Node[] }[] } | undefined;
  const pane = n.pane as { children?: Node[] } | undefined;
  const grid = n.grid as { items?: { children?: Node[] }[] } | undefined;
  const group = n.group as { items?: Node[] } | undefined;
  const box = n.container as { children?: Node[] } | undefined;
  const md = n.masterDetail as { detail?: Node[] } | undefined;
  const tabs = n.tabs as { children?: Node[] } | undefined;
  return [sec?.children, ...(cols?.items ?? []).map((c) => c.children), pane?.children, ...(grid?.items ?? []).map((it) => it.children), group?.items, box?.children, md?.detail, tabs?.children].filter(
    (l): l is Node[] => Array.isArray(l),
  );
}

/** A view's node lists: the toolbar, the body and the footer (api/plugin.ts VIEW_LISTS). */
function viewListsOf(view: Record<string, unknown>): Node[][] {
  return [view.toolbar, view.nodes, view.footer].filter((l): l is Node[] => Array.isArray(l));
}

/** Applies f to the node with `key` (at any depth); returns whether it found it. */
function patchNode(nodes: Node[], key: string, f: (n: Node) => void): boolean {
  for (const n of nodes) {
    if (n.key === key) {
      f(n);
      return true;
    }
    for (const children of childListsOf(n)) if (patchNode(children, key, f)) return true;
  }
  return false;
}

interface Element {
  key: string;
  kind: "click" | "submit" | "change" | "tab" | "select" | "host";
  event: string;
  /** The event's data (a chip's status, a row's id). */
  data?: string;
  /** A node tab's tabs node, a select's master-detail (SurfaceAct.node). */
  node?: string;
}

/** The elements of a view that act, by key (like the daemon's actionIndex). */
function elementsOf(view: Record<string, unknown>): Map<string, Element> {
  const out = new Map<string, Element>();
  const action = (key: string, a: unknown, kind: Element["kind"]) => {
    const act = a as { event?: string; data?: string } | undefined;
    if (!act) return;
    out.set(key, { key, kind: act.event ? kind : "host", event: act.event ?? "", ...(act.data ? { data: act.data } : {}) });
  };
  const button = (b: unknown, kind: Element["kind"] = "click") => {
    const x = b as { key: string; action?: unknown };
    action(x.key, x.action, kind);
  };
  const header = view.header as { actions?: unknown[] } | undefined;
  header?.actions?.forEach((b) => {
    button(b);
  });
  const tabs = view.tabs as { items?: { key: string }[] } | undefined;
  tabs?.items?.forEach((t) => out.set(t.key, { key: t.key, kind: "tab", event: "tab" }));
  const fields = (fs: { key: string; change?: unknown; fieldset?: { fields: unknown[] } }[]) => {
    for (const f of fs) {
      if (f.change) action(f.key, f.change, "change");
      if (f.fieldset) fields(f.fieldset.fields as typeof fs);
    }
  };
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      const any = n as Record<string, { buttons?: unknown[]; actions?: unknown[]; rows?: { key: string; action?: unknown; actions?: unknown[] }[]; chips?: { key: string; action?: unknown }[]; children?: Node[]; submit?: unknown; secondary?: unknown[]; fields?: unknown[] }>;
      any.actions?.buttons?.forEach((b) => {
        button(b);
      });
      for (const k of ["notice", "empty", "section"]) any[k]?.actions?.forEach((b) => {
        button(b);
      });
      any.list?.rows?.forEach((r) => {
        action(r.key, r.action, "click");
        r.actions?.forEach((b) => {
          button(b);
        });
      });
      any.chips?.chips?.forEach((c) => {
        action(c.key, c.action, "click");
      });
      const md = n.masterDetail as { list?: { rows?: { key: string; action?: unknown; actions?: unknown[] }[] }; emptyDetail?: { actions?: unknown[] } } | undefined;
      md?.list?.rows?.forEach((r) => {
        if (r.action) action(r.key, r.action, "click");
        else out.set(r.key, { key: r.key, kind: "select", event: "select", node: n.key });
        r.actions?.forEach((b) => {
          button(b);
        });
      });
      md?.emptyDetail?.actions?.forEach((b) => {
        button(b);
      });
      (n.tabs as { items?: { key: string }[] } | undefined)?.items?.forEach((t) => out.set(t.key, { key: t.key, kind: "tab", event: "tab", node: n.key }));
      if (any.form) {
        if (any.form.submit) button(any.form.submit, "submit");
        any.form.secondary?.forEach((b) => {
          button(b);
        });
        fields((any.form.fields ?? []) as Parameters<typeof fields>[0]);
      }
      for (const children of childListsOf(n)) walk(children);
    }
  };
  for (const nodes of viewListsOf(view)) walk(nodes);
  return out;
}

/** The Runs tab's runs (the real plugin's layoutRuns) and how long each took (runs.go runTook). */
const RUNS = [
  { n: 6, status: "running", branch: "main" },
  { n: 5, status: "failed", branch: "cf/fix" },
  { n: 4, status: "ok", branch: "main" },
  { n: 3, status: "failed", branch: "cf/retry" },
  { n: 2, status: "ok", branch: "cf/fix" },
  { n: 1, status: "ok", branch: "main" },
] as const;

function runKey(n: number): string {
  return `runs-run-${String(n)}`;
}

/** A run's log lines (runs.go runLog): a failed run's last step is an error, the running one stops at step 9. */
function runLog(r: (typeof RUNS)[number]): { text: string; tone?: string }[] {
  const lines: { text: string; tone?: string }[] = Array.from({ length: 12 }, (_, i) => ({ text: `build ${String(r.n)}  step ${String(i + 1).padStart(2, "0")}  ok` }));
  if (r.status === "failed") lines[11] = { text: `build ${String(r.n)}  step 12  FAIL: 1 test failed`, tone: "error" };
  if (r.status === "running") return [...lines.slice(0, 8), { text: `build ${String(r.n)}  step 09  running…`, tone: "muted" }];
  return lines;
}

/**
 * The Runs tab as the real plugin renders it (plugins/examples/hello/runs.go): the chosen
 * row and its detail (facts, then the detail's own tabs: Overview with the note form, Log
 * with a pane of the run's log). The captured view has nothing chosen.
 */
function patchRuns(nodes: Node[], st: { selected: string; tab: string; notes: Record<string, string> }): void {
  patchNode(nodes, "runs-md", (n) => {
    const md = n.masterDetail as Record<string, unknown>;
    const r = RUNS.find((x) => runKey(x.n) === st.selected);
    if (!r) return;
    md.selected = st.selected;
    const pill = r.status === "running" ? { label: "running" } : r.status === "failed" ? { label: "failed", tone: "error" } : { label: "passed", tone: "ok" };
    const took = { spans: [{ duration: { ms: (60 + 37 * r.n) * 1000 } }] };
    const tab = st.tab === "runs-tab-log" ? "runs-tab-log" : "runs-tab-overview";
    const log = runLog(r);
    const note = st.notes[st.selected];
    const children =
      tab === "runs-tab-log"
        ? [{ key: "runs-log-pane", pane: { height: 240, children: [{ key: "runs-log", log: { title: `build ${String(r.n)}`, lines: log } }] } }]
        : [
            { key: "runs-summary", markdown: { source: `**Build #${String(r.n)}** on \`${r.branch}\`: ${String(log.length)} steps. A **tabs** node gives the detail its own tabs; the note below keeps its draft per run and per tab.` } },
            {
              key: "runs-note-form",
              form: {
                fields: [{ key: "runs-note", name: "note", label: "Note", input: { placeholder: "Add a note to this run", ...(note ? { value: note } : {}) } }],
                submit: { key: "runs-note-save", label: "Save note", action: { event: "runs-note" } },
              },
            },
          ];
    md.detail = [
      {
        key: "runs-facts",
        pairs: {
          items: [
            { key: "runs-f-branch", label: "Branch", value: { spans: [{ text: r.branch, mono: true }] } },
            { key: "runs-f-status", label: "Status", pill },
            { key: "runs-f-took", label: "Took", value: took },
          ],
        },
      },
      {
        key: "runs-tabs",
        tabs: {
          items: [{ key: "runs-tab-overview", label: "Overview" }, { key: "runs-tab-log", label: "Log", ...(r.status === "failed" ? { badge: { label: "1 error", tone: "error" } } : {}) }],
          active: tab,
          children,
        },
      },
    ];
  });
}


/**
 * Layout fuzzing controls (e2e/plugins-layout-fuzz.spec.ts; POST /__mock/plugin/demotab with
 * a `__` tab): `__viewdelay:<ms>` publishes each new view that long after the act returns
 * (the daemon coalesces views, DefaultCoalesce 100 ms, so its act answers first);
 * `__actdelay:<ms>` makes every act take that long; `__failnext:<key>` refuses the next act
 * on that key; `view:<json>` shows a custom view ({view, details?, tabChildren?}): a
 * master-detail's select sets its selected row and detail (details[node][row], else a
 * text), a node tab its active tab and children (tabChildren[node][tab], else a text), a
 * view tab its active tab; other acts re-render. Reset with the mock.
 */
export const fuzzControl = { viewDelayMs: 0, actDelayMs: 0, failNext: new Set<string>() };

interface CustomSpec {
  view: Record<string, unknown>;
  details?: Record<string, Record<string, Node[]>>;
  tabChildren?: Record<string, Record<string, Node[]>>;
  selected: Record<string, string>;
  active: Record<string, string>;
  viewTab?: string;
}

/** The custom view with the user's choices applied (selected rows, node tabs, the view tab). */
function customView(spec: CustomSpec): Record<string, unknown> {
  const v = JSON.parse(JSON.stringify(spec.view)) as Record<string, unknown>;
  if (spec.viewTab !== undefined && v.tabs) (v.tabs as { active: string }).active = spec.viewTab;
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      const md = n.masterDetail as { selected?: string; detail: Node[] } | undefined;
      if (md && n.key in spec.selected) {
        const sel = spec.selected[n.key] ?? "";
        if (sel !== (md.selected ?? "")) md.detail = spec.details?.[n.key]?.[sel] ?? [{ key: `${n.key}-d-${sel}`, text: { content: `Detail of ${sel}` } }];
        md.selected = sel;
      }
      const tabs = n.tabs as { active: string; children: Node[] } | undefined;
      if (tabs && n.key in spec.active) {
        const act = spec.active[n.key] ?? "";
        if (act !== tabs.active) tabs.children = spec.tabChildren?.[n.key]?.[act] ?? [{ key: `${n.key}-c-${act}`, text: { content: `Tab ${act}` } }];
        tabs.active = act;
      }
      for (const children of childListsOf(n)) walk(children);
    }
  };
  for (const l of viewListsOf(v)) walk(l);
  return v;
}

/** One open demo instance: the real plugin's state, the view it renders, its watchers. */
class DemoInstance {
  tab = "overview";
  clicks = 0;
  pinned = false;
  saved: Record<string, unknown> | null = null;
  tokenStored = false;
  resetToken = 0;
  build = 0;
  running = false;
  /** The Layout tab's toolbar filter (the real plugin's layoutFilter). */
  layoutFilter = { status: "", query: "", resets: 0 };
  /** The Runs tab's state (the real plugin's runsState): the chosen run, the detail's tab, notes by run. */
  runs: { selected: string; tab: string; notes: Record<string, string> } = { selected: "", tab: "", notes: {} };
  buildLog = "";
  /** A custom view (fuzzControl's `view:<json>`), shown while tab is "custom". */
  custom: CustomSpec | null = null;
  version = 0;
  view: Record<string, unknown> | null = null;
  phase = SurfacePhase.OPENING;
  message = "";
  readonly openedAt = Date.now();
  readonly hub = new Hub<SurfaceUpdateInit>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    readonly key: string,
    readonly threadId: string,
    private readonly onPin: (threadId: string, pinned: boolean) => void,
    private readonly send: (threadId: string, text: string) => void = () => undefined,
  ) {}

  state(pluginState: PluginState): SurfaceUpdateInit {
    return { update: { case: "state", value: { instance: this.key, phase: this.phase, message: this.message, pluginState } } };
  }

  viewUpdate(): SurfaceUpdateInit | null {
    return this.view ? { update: { case: "view", value: { instance: this.key, version: BigInt(this.version), viewJson: JSON.stringify(this.view) } } } : null;
  }

  render(): void {
    if (this.tab === "custom" && this.custom) {
      this.view = customView(this.custom);
      this.version++;
      this.phase = SurfacePhase.LIVE;
      this.message = "";
      this.publishView();
      return;
    }
    const shift = this.openedAt - CAPTURED_AT;
    // "stress" (POST /__mock/plugin/demotab?tab=stress; not in the captured views): two
    // thread nodes and a terminal in one view, more live streams than the GUI's budget.
    const v = shiftTimes(fixture(this.tab === "stress" ? "assistant" : this.tab), shift) as Record<string, unknown>;
    if (this.tab === "stress") {
      (v.tabs as { items: { key: string; label: string }[] }).items.push({ key: "stress", label: "Stress" });
      v.nodes = [
        { key: "stress-a", thread: { threadId: HELLO_THREAD, height: 200 } },
        { key: "stress-b", thread: { threadId: "s-1", readOnly: true, height: 200 } },
        { key: "stress-t", terminal: { terminalId: HELLO_TERMINAL, title: "Clock", rows: 6 } },
        { key: "stress-bar", actions: { buttons: [{ key: "click", label: "Click", action: { event: "click" } }] } },
      ];
    }
    const header = v.header as Record<string, unknown>;
    header.trailing = { spans: [{ text: `${String(this.clicks)} ${this.clicks === 1 ? "click" : "clicks"}`, tone: "muted" }] };
    const subline = header.subline as { spans: { text?: string; mono?: boolean }[] };
    const idSpan = subline.spans.find((s) => s.mono);
    if (idSpan) idSpan.text = this.threadId;
    (v.tabs as { active: string }).active = this.tab;
    const nodes = v.nodes as Node[];
    if (this.tab === "overview") {
      patchNode(nodes, "bar", (n) => {
        const buttons = (n.actions as { buttons: { key: string; label: string }[] }).buttons;
        const click = buttons.find((b) => b.key === "click");
        if (click) click.label = `Click (${String(this.clicks)})`;
        const pin = buttons.find((b) => b.key === "pin");
        if (pin) pin.label = this.pinned ? "Unpin from this thread" : "Pin to this thread";
      });
    } else if (this.tab === "form") {
      patchNode(nodes, "form-intro", (n) => {
        n.text = { content: this.saved ? `Saved: ${JSON.stringify(this.saved)}` : "Nothing saved yet." };
      });
      patchNode(nodes, "settings", (n) => {
        const form = n.form as { resetToken: string; fields: { key: string; input?: Record<string, unknown> }[] };
        form.resetToken = String(this.resetToken);
        const token = form.fields.find((f) => f.key === "f-token");
        if (token?.input && this.tokenStored) token.input.hasValue = true;
      });
    } else if (this.tab === "assistant") {
      patchNode(nodes, "assistant-thread", (n) => {
        (n.thread as { threadId: string }).threadId = HELLO_THREAD;
      });
    } else if (this.tab === "layout") {
      patchNode(nodes, "layout-thread", (n) => {
        (n.thread as { threadId: string }).threadId = HELLO_THREAD;
      });
      this.patchLayoutFilter(v);
    } else if (this.tab === "run-list") {
      patchRuns(nodes, this.runs);
    } else if (this.tab === "shell") {
      patchNode(nodes, "clock", (n) => {
        (n.terminal as { terminalId: string }).terminalId = HELLO_TERMINAL;
      });
    } else {
      patchNode(nodes, "log-state", (n) => {
        n.text = { content: this.running ? `Building ${String(this.build)}…` : this.build > 0 ? `Build ${String(this.build)} finished.` : "Idle. Start a build to stream its log." };
      });
      patchNode(nodes, "log-actions", (n) => {
        const start = (n.actions as { buttons: { key: string; busy?: boolean }[] }).buttons.find((b) => b.key === "log-start");
        if (start && this.running) start.busy = true;
      });
      patchNode(nodes, "build-log", (n) => {
        n.log = { ...(n.log as object), title: `build ${String(this.build)}`, ...(this.buildLog ? { text: this.buildLog } : {}) };
      });
    }
    this.view = v;
    this.version++;
    this.phase = SurfacePhase.LIVE;
    this.message = "";
    this.publishView();
  }

  /** Publishes the current view, fuzzControl.viewDelayMs later when set (the daemon's coalescing). */
  private publishView(): void {
    const u = this.viewUpdate();
    if (!u) return;
    if (fuzzControl.viewDelayMs > 0) {
      this.timers.push(
        setTimeout(() => {
          this.hub.publish(u);
        }, fuzzControl.viewDelayMs),
      );
    }
    else this.hub.publish(u);
  }

  /**
   * The Layout tab after its toolbar's filter, as the real plugin renders it (plugins/
   * examples/hello/layout.go): the runs that match, the chosen chip, the footer's count and
   * Clear filter, the search's value and reset token. The captured view is unfiltered.
   */
  private patchLayoutFilter(v: Record<string, unknown>): void {
    const f = this.layoutFilter;
    const status = f.status === "" ? "all" : f.status;
    const q = f.query.trim().toLowerCase();
    const states: Record<string, string> = { running: "running", failed: "failed", ok: "ok" };
    type Row = { key: string; title: string; glyph?: { status?: string }; trailing?: string };
    let shown = 0;
    let total = 0;
    patchNode(v.nodes as Node[], "layout-runs", (n) => {
      const list = n.list as { rows: Row[] };
      total = list.rows.length;
      list.rows = list.rows.filter((r) => (status === "all" || states[r.glyph?.status ?? ""] === status) && (q === "" || `${r.title} ${r.trailing ?? ""}`.toLowerCase().includes(q)));
      shown = list.rows.length;
    });
    const toolbar = (v.toolbar ?? []) as Node[];
    const footer = (v.footer ?? []) as Node[];
    patchNode(toolbar, "layout-search-form", (n) => {
      const form = n.form as { resetToken?: string; fields: { input?: { value?: string } }[] };
      form.resetToken = String(f.resets);
      const input = form.fields[0]?.input;
      if (input) {
        if (f.query) input.value = f.query;
        else delete input.value;
      }
    });
    patchNode(toolbar, "layout-status", (n) => {
      for (const c of (n.chips as { chips: { key: string; selected?: boolean }[] }).chips) {
        if (c.key === `layout-st-${status}`) c.selected = true;
        else delete c.selected;
      }
    });
    patchNode(footer, "layout-count", (n) => {
      (n.text as { content: unknown }).content = `${String(shown)} of ${String(total)} runs`;
    });
    patchNode(footer, "layout-footer-bar", (n) => {
      const clear = (n.actions as { buttons: { key: string; disabled?: boolean }[] }).buttons.find((b) => b.key === "layout-clear");
      if (clear) clear.disabled = status === "all" && q === "";
    });
  }

  /** The plugin's surface/act. Throws the plugin's refusal as Aborted, like the daemon. */
  act(el: Element, values: Record<string, unknown>, toast: (text: string) => void, viewer = ""): void {
    if (fuzzControl.failNext.delete(el.key)) throw new ConnectError(`plugin refused: ${el.key} (failnext)`, Code.Aborted);
    if (this.tab === "custom" && this.custom) {
      if (el.kind === "select" && el.node) this.custom.selected[el.node] = el.key;
      else if (el.kind === "tab" && el.node) this.custom.active[el.node] = el.key;
      else if (el.kind === "tab") this.custom.viewTab = el.key;
      this.render();
      return;
    }
    switch (`${el.kind}:${el.event}`) {
      case "click:send-hello":
        this.send(HELLO_THREAD, "say hello in one line");
        toast("sent to the assistant");
        return;
      case "click:ask-main":
        // The act's context: the thread the acting panel shows.
        this.send(viewer || this.threadId, "The hello plugin says hi from its Assistant tab. Answer in one short line.");
        toast("sent to the thread");
        return;
      case "click:restart-shell":
        break;
      case "tab:tab":
        if (el.node === "runs-tabs") this.runs = { ...this.runs, tab: el.key };
        else this.tab = el.key;
        break;
      case "select:select":
        if (!RUNS.some((r) => runKey(r.n) === el.key)) throw new ConnectError(`plugin refused: no run "${el.key}"`, Code.Aborted);
        this.runs = { ...this.runs, selected: el.key };
        break;
      case "submit:runs-note":
        if (!this.runs.selected) throw new ConnectError("plugin refused: no run chosen", Code.Aborted);
        this.runs = { ...this.runs, notes: { ...this.runs.notes, [this.runs.selected]: typeof values.note === "string" ? values.note.trim() : "" } };
        toast("note saved");
        break;
      case "click:click":
      case "click:refresh":
        this.clicks++;
        break;
      case "click:goto-form":
        this.tab = "form";
        break;
      case "click:pin":
        this.pinned = !this.pinned;
        this.onPin(this.threadId, this.pinned);
        break;
      case "submit:save": {
        const name = typeof values.name === "string" ? values.name.trim() : "";
        if (!name) throw new ConnectError("plugin refused: a name is required", Code.Aborted);
        const saved: Record<string, unknown> = { ...values };
        if ("token" in saved) {
          saved.token = { key: "token", stored: true };
          this.tokenStored = true;
        }
        this.saved = saved;
        toast("saved");
        break;
      }
      case "click:reset":
        this.saved = null;
        this.resetToken++;
        break;
      case "click:start-log":
        if (!this.running) {
          this.running = true;
          this.build++;
          this.tab = "log";
          this.buildLog = "";
          this.stream(this.build);
        }
        break;
      case "click:clear-log":
        this.buildLog = "";
        break;
      case "submit:layout-filter":
        this.layoutFilter = { ...this.layoutFilter, query: typeof values.q === "string" ? values.q : "" };
        break;
      case "click:layout-status":
        this.layoutFilter = { ...this.layoutFilter, status: el.data ?? "" };
        break;
      case "click:layout-clear":
        this.layoutFilter = { status: "", query: "", resets: this.layoutFilter.resets + 1 };
        break;
      case "click:layout-rerun":
        toast("build #6 queued again");
        return;
      case "change:project-changed":
      case "click:stage":
      case "click:open-run":
      case "click:cancel-run":
        return;
      default:
        throw new ConnectError(`plugin refused: the demo does not know ${el.kind} "${el.event}"`, Code.Aborted);
    }
    this.render();
  }

  private stream(build: number): void {
    const steps = ["fetching sources", "compiling 12 packages", "running 48 tests", "ok: 48 passed", "uploading artifacts", "done"];
    steps.forEach((s, i) => {
      this.timers.push(
        setTimeout(
          () => {
            if (this.build !== build) return;
            const text = `[${String(i + 1)}/${String(steps.length)}] ${s}\n`;
            this.buildLog += text;
            this.hub.publish({ update: { case: "append", value: { instance: this.key, version: BigInt(this.version), key: "build-log", text } } });
            if (i === steps.length - 1) {
              this.running = false;
              this.render();
            }
          },
          300 * (i + 1),
        ),
      );
    });
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.hub.endAll();
  }
}

const HELLO_COMMANDS = [
  { name: "plugin.hello.greet", title: "Say Hello", description: "Answer with a greeting." },
  { name: "plugin.hello.forget", title: "Forget the Word", description: "Remove the remembered word from the Keychain." },
];

function seedPlugins(): MockPlugin[] {
  const started = new Date(Date.now() - 12 * 60_000);
  return [
    {
      name: "acme-data",
      displayName: "Acme Data",
      version: "1.2.0",
      description: "Signs you in to Acme's data warehouse and gives new threads a read-only token.",
      state: PluginState.DISABLED,
      enabled: false,
      dev: false,
      needsConsent: true,
      granted: false,
      disabledReason: "",
      lastError: "",
      restarts: 0,
      pid: 0,
      startedAt: started,
      permissions: { commands: ["thread.send"], events: [], threadStatus: false, sessionEnv: true, secrets: true },
      commands: [],
      surfaces: [{ id: "access", title: "Data access", icon: "database", scope: "global" }],
      // Acme's own registry, which the mock does not configure; the loopback registry lists
      // another acme-data (mock/pluginRegistry.ts LOOPBACK_REGISTRY).
      install: { kind: "registry", source: "https://plugins.acme.dev/index.json" },
    },
    {
      name: "crasher",
      displayName: "Crasher",
      version: "0.0.1",
      description: "Exits at start: a plugin the daemon keeps restarting.",
      state: PluginState.CRASHED,
      enabled: true,
      dev: false,
      needsConsent: false,
      granted: true,
      disabledReason: "",
      lastError: "exited with status 1: crasher: cannot read config",
      restarts: 3,
      pid: 0,
      startedAt: started,
      permissions: { commands: [], events: [], threadStatus: false, sessionEnv: false, secrets: false },
      commands: [],
      surfaces: [],
    },
    {
      name: "hello",
      displayName: "Hello",
      version: "0.1.0",
      description: "The example plugin: greets, sends a message to a thread through the host, keeps a word in the Keychain, follows the thread list, flags threads, gives new threads CF_HELLO=1, and runs a Claude thread and a terminal of its own.",
      state: PluginState.RUNNING,
      enabled: true,
      dev: true,
      needsConsent: false,
      granted: true,
      disabledReason: "",
      lastError: "",
      restarts: 0,
      pid: 48213,
      startedAt: started,
      permissions: { commands: ["thread.send", "pr.checks"], events: ["threads"], threadStatus: true, sessionEnv: true, secrets: true, threads: true, terminals: true },
      commands: HELLO_COMMANDS,
      surfaces: [
        { id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread" },
        { id: "pinned", title: "Hello Pinned", icon: "pin", scope: "thread" },
        { id: "checks", title: "Actions Checks", icon: "workflow", scope: "thread", when: () => false },
      ],
    },
    {
      // Installed from the fixture registry, which now lists 0.1.0 (mock/pluginRegistry.ts).
      name: "test-watcher",
      displayName: "Test Watcher",
      version: "0.0.9",
      description: "Runs the project's tests in a thread's worktree whenever files change, shows failures and output in the side panel, flags the thread while tests fail, and sends failures to Claude.",
      state: PluginState.RUNNING,
      enabled: true,
      dev: false,
      needsConsent: false,
      granted: true,
      disabledReason: "",
      lastError: "",
      restarts: 0,
      pid: 48344,
      startedAt: started,
      permissions: { commands: ["thread.send"], events: ["project", "threads"], threadStatus: true, sessionEnv: false, secrets: false },
      commands: [],
      surfaces: [],
      install: { kind: "registry", source: "https://github.com/alexwaumann/code-foundry-plugins" },
    },
  ];
}

function describe(p: MockPlugin): string[] {
  const out: string[] = [];
  if (p.permissions.commands.length > 0) out.push(`run Code Foundry commands: ${p.permissions.commands.join(", ")}`);
  if (p.permissions.events.length > 0) out.push(`follow these events: ${p.permissions.events.join(", ")}`);
  if (p.permissions.threadStatus) out.push("flag threads as needing attention");
  if (p.permissions.sessionEnv) out.push("add environment variables to new Claude threads");
  if (p.permissions.secrets) out.push("keep secrets in your Keychain (its own, under code-foundry-plugin)");
  return out;
}

/** The daemon's plugin.ConsentText. */
export function consentText(p: MockPlugin): string {
  const perms = describe(p);
  const head = `Enable ${p.displayName} ${p.version}? It runs bin/${p.name} as you`;
  return perms.length === 0 ? `${head} and asks for no permissions.` : `${head} and may:${perms.map((x) => `\n  - ${x}`).join("")}`;
}

export interface PluginDeps {
  publish: (ev: PluginEventInit) => void;
  emit: (i: UiIntentInit) => number;
  threadExists: (id: string) => boolean;
  /** thread.send (the demo's Send hello to its own thread, Ask the main thread through host/invoke). */
  sendToThread: (id: string, text: string) => void;
  /** The plugins.registries setting (mock/pluginRegistry.ts). */
  registries: () => string;
}

/** The daemon's home for the plugin directories (PluginService.List; POST /__mock/plugin/dirs?home=…). */
export const MOCK_HOME = "/Users/dev/.code-foundry";

/** Secrets the plugins keep in the Keychain, names only (PluginService.ListSecrets). */
function seedSecrets(): Map<string, { key: string; updatedAt: Date }[]> {
  const ago = (ms: number) => new Date(Date.now() - ms);
  return new Map([
    ["hello", [{ key: "word", updatedAt: ago(2 * 3_600_000) }]],
    [
      "acme-data",
      [
        { key: "token", updatedAt: ago(3 * 86_400_000) },
        { key: "refresh-token", updatedAt: ago(3 * 86_400_000) },
      ],
    ],
  ]);
}

export class MockPlugins {
  private plugins = new Map<string, MockPlugin>();
  private instances = new Map<string, DemoInstance>();
  /** Threads the demo's Pin button pinned (hello's context fact `pinned`). */
  private pinned = new Set<string>();
  private epoch = 0;
  /** Acts the GUI sent: "<instance> <key> [viewer=<the acting panel's thread>] <json values>". */
  acts: string[] = [];
  /** The registries, Browse and plugin.install / update / uninstall (mock/pluginRegistry.ts). */
  readonly registry: MockRegistry = new MockRegistry({
    registries: () => this.deps.registries(),
    installed: (name) => {
      const p = this.plugins.get(name);
      return p ? { version: p.version, dev: p.dev, install: p.install } : null;
    },
    install: (spec) => {
      this.install(spec);
    },
    uninstall: (name) => {
      this.uninstall(name);
    },
    publish: (ev) => {
      this.deps.publish(ev);
    },
    republish: () => {
      for (const p of this.plugins.values()) this.changed(p);
    },
  });

  constructor(private readonly deps: PluginDeps) {
    this.reset();
  }

  /** The home the plugin directories are under (PluginService.List's plugins_dir and data_dir). */
  home = MOCK_HOME;
  private secrets = seedSecrets();

  reset(): void {
    for (const i of this.instances.values()) i.close();
    this.instances.clear();
    this.pinned.clear();
    this.acts = [];
    fuzzControl.viewDelayMs = 0;
    fuzzControl.actDelayMs = 0;
    fuzzControl.failNext.clear();
    this.plugins = new Map(seedPlugins().map((p) => [p.name, p]));
    this.registry.reset();
    this.home = MOCK_HOME;
    this.secrets = seedSecrets();
  }

  /** PluginService.List's directories. */
  dirs(): { pluginsDir: string; dataDir: string } {
    return { pluginsDir: `${this.home}/plugins`, dataDir: `${this.home}/plugin-data` };
  }

  /** A plugin's secrets, names and when set (PluginService.ListSecrets). */
  listSecrets(name: string): { key: string; updatedAt: ReturnType<typeof timestampFromDate> }[] {
    this.plugin(name);
    return (this.secrets.get(name) ?? []).map((x) => ({ key: x.key, updatedAt: timestampFromDate(x.updatedAt) }));
  }

  /** Deletes one secret (PluginService.DeleteSecret, plugin.secrets.delete); NOT_FOUND when it has none by that name. */
  deleteSecret(name: string, key: string): void {
    this.plugin(name);
    const list = this.secrets.get(name) ?? [];
    if (!list.some((x) => x.key === key)) throw new CommandError("notfound", `plugin ${name} has no secret ${key}`);
    this.secrets.set(
      name,
      list.filter((x) => x.key !== key),
    );
  }

  /** Puts an installed (or updated) package in place: a new plugin is disabled pending consent; an update keeps its state. */
  private install(spec: InstallSpec): void {
    const had = this.plugins.get(spec.name);
    if (had) {
      had.version = spec.version;
      had.install = { kind: "registry", source: spec.registry };
      this.changed(had);
      return;
    }
    const p: MockPlugin = {
      name: spec.name,
      displayName: spec.displayName,
      version: spec.version,
      description: spec.description,
      state: PluginState.DISABLED,
      enabled: false,
      dev: false,
      needsConsent: true,
      granted: false,
      disabledReason: "",
      lastError: "",
      restarts: 0,
      pid: 0,
      startedAt: new Date(),
      permissions: { ...spec.permissions },
      commands: [],
      surfaces: [],
      install: { kind: "registry", source: spec.registry },
    };
    this.plugins.set(p.name, p);
    this.changed(p);
  }

  private uninstall(name: string): void {
    if (!this.plugins.delete(name)) throw new CommandError("notfound", `no plugin named ${name}`);
    this.deps.publish({ event: { case: "removedName", value: name } });
  }

  private msg(p: MockPlugin, ctx?: UiContext): PluginInit {
    const granted = p.granted ? { ...p.permissions } : undefined;
    return {
      name: p.name,
      displayName: p.displayName,
      version: p.version,
      description: p.description,
      state: p.state,
      enabled: p.enabled,
      disabledReason: p.disabledReason,
      dev: p.dev,
      devPath: p.dev ? `/Users/dev/src/code-foundry/plugins/examples/${p.name}` : "",
      dir: `/Users/dev/.code-foundry/plugins/${p.name}`,
      lastError: p.lastError,
      issues: [],
      permissions: { ...p.permissions },
      ...(granted ? { granted, consentedAt: timestampFromDate(p.startedAt) } : {}),
      needsConsent: p.needsConsent,
      consentText: p.needsConsent ? consentText(p) : "",
      pid: p.state === PluginState.RUNNING ? p.pid : 0,
      ...(p.state === PluginState.RUNNING ? { startedAt: timestampFromDate(p.startedAt) } : {}),
      ...(p.state === PluginState.CRASHED ? { nextRestartAt: timestampFromDate(new Date(Date.now() + 4000)) } : {}),
      restarts: p.restarts,
      protocol: 1,
      capabilities: [],
      commands: p.commands,
      surfaces: p.surfaces.map((s) => ({
        id: s.id,
        title: s.title,
        icon: s.icon,
        scope: s.scope,
        placements: ["panel"],
        when: s.when ? "…" : "",
        showCommand: `plugin.${p.name}.show.${s.id}`,
        kind: `plugin.${p.name}.${s.id}`,
        available: this.surfaceAvailable(p, s, ctx),
      })),
      logPath: `/Users/dev/.code-foundry/logs/plugins/${p.name}.log`,
      ...(p.install ? { install: { kind: p.install.kind, source: p.install.source, version: p.version, sha256: "", installedAt: timestampFromDate(p.startedAt) } } : {}),
      ...this.registry.offer(p.name),
    };
  }

  snapshot(): PluginEventInit {
    return { event: { case: "snapshot", value: { plugins: this.list() } } };
  }

  list(ctx?: UiContext): PluginInit[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => this.msg(p, ctx));
  }

  private plugin(name: string): MockPlugin {
    const p = this.plugins.get(name);
    if (!p) throw new CommandError("notfound", `no plugin named ${name}`);
    return p;
  }

  private changed(p: MockPlugin): void {
    this.deps.publish({ event: { case: "updated", value: this.msg(p) } });
  }

  private bumpEpoch(): void {
    this.epoch++;
    this.deps.publish({ event: { case: "availabilityEpoch", value: BigInt(this.epoch) } });
  }

  private surfaceAvailable(p: MockPlugin, s: SurfaceDef, ctx: UiContext | undefined): boolean {
    if (!p.enabled) return false;
    if (s.scope === "thread" && !(ctx?.activeThreadId && this.deps.threadExists(ctx.activeThreadId))) return false;
    if (p.name === "hello" && s.id === "pinned") return this.pinned.has(ctx?.activeThreadId ?? "");
    return s.when ? s.when(ctx) : true;
  }

  /** Every open hello demo instance switches to `tab` (POST /__mock/plugin/demotab), as if the plugin did. */
  demoTab(tab: string): void {
    if (tab.startsWith("__viewdelay:")) {
      fuzzControl.viewDelayMs = Number(tab.slice(12));
      return;
    }
    if (tab.startsWith("__actdelay:")) {
      fuzzControl.actDelayMs = Number(tab.slice(11));
      return;
    }
    if (tab.startsWith("__failnext:")) {
      fuzzControl.failNext.add(tab.slice(11));
      return;
    }
    if (tab.startsWith("view:")) {
      const spec = JSON.parse(tab.slice(5)) as Omit<CustomSpec, "selected" | "active">;
      for (const inst of this.instances.values()) {
        if (!inst.key.startsWith("hello/demo/")) continue;
        inst.custom = { ...spec, selected: {}, active: {} };
        inst.tab = "custom";
        inst.render();
      }
      return;
    }
    for (const inst of this.instances.values()) {
      if (!inst.key.startsWith("hello/demo/")) continue;
      inst.tab = tab;
      inst.render();
    }
  }

  /** The plugin goes down or comes back (POST /__mock/plugin/state); open instances follow. */
  setState(name: string, state: "running" | "crashed" | "failed"): void {
    const p = this.plugin(name);
    p.state = state === "running" ? PluginState.RUNNING : state === "crashed" ? PluginState.CRASHED : PluginState.FAILED;
    if (state !== "running") {
      p.restarts++;
      p.lastError = state === "crashed" ? "was killed by a signal" : "crashed 5 times in 10m, last: was killed by a signal";
    } else {
      p.startedAt = new Date();
      p.pid++;
    }
    this.changed(p);
    for (const inst of this.instances.values()) {
      if (!inst.key.startsWith(`${name}/`)) continue;
      if (state === "running") {
        inst.render();
        inst.hub.publish(inst.state(p.state));
      } else {
        inst.phase = SurfacePhase.PLUGIN_DOWN;
        inst.message = state === "crashed" ? `${p.displayName} crashed (was killed by a signal); next try in 2s` : `${p.displayName} failed: run code-foundry plugin restart ${name}`;
        inst.hub.publish(inst.state(p.state));
      }
    }
  }

  /** A plugin's view/toast without an instance: a Notify intent titled with its name. */
  toast(name: string, text: string): number {
    return this.deps.emit({ intent: { case: "notify", value: { level: UiIntent_Notify_Level.INFO, title: this.plugin(name).displayName, body: text } } });
  }

  /** A host/invoke with confirm "ask": the GUI runs the command through its confirm. */
  invokeAsk(name: string, command: string, ctx: UiContext | undefined, args: Record<string, string>): number {
    return this.deps.emit({ intent: { case: "invokeCommand", value: { name: command, args, ...(ctx ? { context: ctx } : {}), caller: `plugin:${name}` } } });
  }

  environment(): EnvironmentInit[] {
    const hello = this.plugins.get("hello");
    if (!hello?.enabled) return [];
    return [{ plugin: "hello", env: [{ key: "CF_HELLO" }], pathPrepend: [], addDirs: [], projects: [], noProject: true, issues: [], updatedAt: timestampFromDate(hello.startedAt) }];
  }

  logs(name: string): { lines: { seq: bigint; time: ReturnType<typeof timestampFromDate>; source: string; level: string; text: string }[]; path: string } {
    const p = this.plugin(name);
    const t = (ago: number) => timestampFromDate(new Date(Date.now() - ago * 1000));
    const lines =
      p.state === PluginState.CRASHED
        ? [
            { seq: 1n, time: t(40), source: "host", level: "", text: `starting ${name} ${p.version} (pid 4210)` },
            { seq: 2n, time: t(40), source: "stderr", level: "", text: "crasher: cannot read config" },
            { seq: 3n, time: t(39), source: "host", level: "", text: "exited with status 1" },
            { seq: 4n, time: t(39), source: "host", level: "", text: "restarting in 4s" },
          ]
        : [
            { seq: 1n, time: t(720), source: "host", level: "", text: `starting ${name} ${p.version} (pid ${String(p.pid)})` },
            { seq: 2n, time: t(720), source: "host", level: "", text: "running" },
            { seq: 3n, time: t(719), source: "log", level: "info", text: `${name} is up dev=${String(p.dev)}` },
            { seq: 4n, time: t(30), source: "log", level: "warn", text: "the demo backend is slow today" },
          ];
    return { lines, path: `/Users/dev/.code-foundry/logs/plugins/${name}.log` };
  }

  // -------------------------------------------------------------------------------------
  // Surfaces

  private surfaceOf(ref: SurfaceRef): { p: MockPlugin; s: SurfaceDef } {
    const p = this.plugin(ref.plugin);
    const s = p.surfaces.find((x) => x.id === ref.surface);
    if (!s) throw new ConnectError(`plugin ${ref.plugin} has no surface ${ref.surface}`, Code.NotFound);
    if (!this.surfaceAvailable(p, s, ref.context)) throw new ConnectError(`plugin.${p.name}.show.${s.id}: not available in this context`, Code.FailedPrecondition);
    return { p, s };
  }

  private instanceFor(ref: SurfaceRef): DemoInstance {
    const { p, s } = this.surfaceOf(ref);
    const thread = s.scope === "thread" ? (ref.context?.activeThreadId ?? "") : "";
    const key = `${p.name}/${s.id}/${thread ? `thread:${thread}` : "global"}`;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = new DemoInstance(
        key,
        thread,
        (id, on) => {
          if (on) this.pinned.add(id);
          else this.pinned.delete(id);
          this.bumpEpoch();
        },
        (id, text) => {
          this.deps.sendToThread(id, text);
        },
      );
      this.instances.set(key, inst);
      const created = inst;
      if (p.name === "hello" && s.id === "demo") setTimeout(() => {
        if (p.state === PluginState.RUNNING) created.render();
      }, 150);
      else setTimeout(() => {
        created.view = simpleView(p, s, thread);
        created.version++;
        created.phase = SurfacePhase.LIVE;
        const u = created.viewUpdate();
        if (u) created.hub.publish(u);
        created.hub.publish(created.state(p.state));
      }, 150);
    }
    return inst;
  }

  async *watch(ref: SurfaceRef, signal: AbortSignal): AsyncGenerator<SurfaceUpdateInit> {
    const inst = this.instanceFor(ref);
    const p = this.plugin(ref.plugin);
    const initial: SurfaceUpdateInit[] = [inst.state(p.state)];
    const v = inst.viewUpdate();
    if (v) initial.push(v);
    for await (const u of inst.hub.subscribe(signal, initial)) {
      // The real daemon sends the live state after the first view.
      yield u;
      if (u.update?.case === "view" && inst.phase === SurfacePhase.LIVE) yield inst.state(p.state);
    }
  }

  act(req: SurfaceActRequest): bigint | Promise<bigint> {
    const inst = this.instances.get(req.instance);
    if (!inst?.view) throw new ConnectError(`${req.instance} is not open (watch it first)`, Code.FailedPrecondition);
    const el = elementsOf(inst.view).get(req.key);
    if (!el) throw new ConnectError(`no acting element "${req.key}" in the view`, Code.InvalidArgument);
    if (el.kind === "host") throw new ConnectError(`${req.key} is a host action: the host runs it, not the plugin`, Code.InvalidArgument);
    const values = (req.values ?? {}) as Record<string, unknown>;
    const viewer = req.context?.activeThreadId ?? "";
    this.acts.push(`${req.instance} ${req.key}${viewer ? ` viewer=${viewer}` : ""} ${JSON.stringify(values)}${req.value !== undefined ? ` value=${req.value}` : ""}`);
    const version = req.version || BigInt(inst.version);
    const run = () => {
      inst.act(el, values, (text) => inst.hub.publish({ update: { case: "toast", value: { instance: inst.key, level: "info", text } } }), viewer);
      return version;
    };
    if (fuzzControl.actDelayMs > 0) {
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(run());
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, fuzzControl.actDelayMs),
      );
    }
    return run();
  }

  // -------------------------------------------------------------------------------------
  // Commands

  commands(): PluginCommand[] {
    const thread = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId && this.deps.threadExists(ctx.activeThreadId));
    const nameArg: ArgDef = { name: "name", type: ArgType.STRING, required: true, description: "The plugin" };
    const out: PluginCommand[] = [
      {
        cmd: {
          name: "plugin.enable",
          title: "Enable Plugin",
          category: "Plugin",
          description: "Turn a plugin on; the first time (or when it asks for more) you consent to its permissions.",
          keybindings: [],
          args: [nameArg],
          confirm: (_c, a) => consentText(this.plugin(a.name ?? "")),
          confirmIf: (_c, a) => this.plugins.get(a.name ?? "")?.needsConsent ?? false,
        },
        when: () => true,
        run: (_c, a) => {
          const p = this.plugin(a.name ?? "");
          p.enabled = true;
          p.needsConsent = false;
          p.granted = true;
          p.disabledReason = "";
          p.state = PluginState.RUNNING;
          p.pid = 50_000 + Math.floor(Math.random() * 1000);
          p.startedAt = new Date();
          this.changed(p);
          return `enabled ${p.name} ${p.version} (starting)`;
        },
      },
      {
        cmd: { name: "plugin.disable", title: "Disable Plugin", category: "Plugin", description: "Stop a plugin and remove its commands.", keybindings: [], args: [nameArg] },
        when: () => true,
        run: (_c, a) => {
          const p = this.plugin(a.name ?? "");
          p.enabled = false;
          p.state = PluginState.DISABLED;
          for (const [k, i] of this.instances) {
            if (!k.startsWith(`${p.name}/`)) continue;
            i.phase = SurfacePhase.PLUGIN_DOWN;
            i.message = `${p.displayName} is disabled`;
            i.hub.publish(i.state(p.state));
          }
          this.changed(p);
          return `disabled ${p.name}`;
        },
      },
      {
        cmd: { name: "plugin.restart", title: "Restart Plugin", category: "Plugin", description: "Re-read the manifest and start the plugin afresh.", keybindings: [], args: [nameArg] },
        when: () => true,
        run: (_c, a) => {
          const p = this.plugin(a.name ?? "");
          if (!p.enabled) throw new CommandError("unavailable", `plugin ${p.name} is disabled`);
          p.restarts = 0;
          p.lastError = "";
          this.setState(p.name, "running");
          return `restarted ${p.name} (starting)`;
        },
      },
      {
        cmd: {
          name: "plugin.dev",
          title: "Add Dev Plugin",
          category: "Plugin",
          description: "Link a plugin folder (with a plugin.json) as a dev plugin and enable it.",
          keybindings: [],
          args: [{ name: "path", type: ArgType.PATH, required: true, description: "The plugin's folder" }],
          confirm: (_c, a) => `Enable Echo 0.0.1? It runs bin/echo as you and may:\n  - run Code Foundry commands: thread.send\n\n(from ${a.path ?? ""})`,
        },
        when: () => true,
        run: (_c, a) => `linked ${a.path ?? ""} as dev plugin echo; enabled echo 0.0.1 (starting)`,
      },
    ];
    out.push({
      cmd: {
        name: "plugin.secrets.delete",
        title: "Delete Plugin Secret",
        category: "Plugin",
        description: "Delete one of a plugin's secrets from the Keychain.",
        keybindings: [],
        args: [nameArg, { name: "key", type: ArgType.STRING, required: true, description: "Secret name (plugin secrets list)" }],
        confirm: (_c, a) => `Delete secret ${a.key ?? ""} of plugin ${a.name ?? ""} from the Keychain?`,
      },
      when: () => true,
      run: (_c, a) => {
        this.deleteSecret(a.name ?? "", a.key ?? "");
        return `deleted secret ${a.key ?? ""} of plugin ${a.name ?? ""}`;
      },
    });
    out.push(...this.registry.commands());
    for (const p of this.plugins.values()) {
      if (!p.enabled) continue;
      for (const s of p.surfaces) {
        out.push({
          cmd: { name: `plugin.${p.name}.show.${s.id}`, title: `Show ${s.title}`, category: p.displayName, description: `Open ${s.title} in the side panel.`, keybindings: [], args: s.scope === "thread" ? [{ name: "thread", type: ArgType.STRING, required: false, description: "The thread" }] : [] },
          when: (ctx) => this.surfaceAvailable(p, s, ctx),
          run: (ctx, a) => {
            const id = a.thread || ctx?.activeThreadId || "";
            const name = `panel.plugin.${p.name}.${s.id}${s.scope === "thread" ? `?thread=${id}` : ""}`;
            return `delivered=${String(this.deps.emit({ intent: { case: "showView", value: { name } } }))}`;
          },
        });
      }
    }
    if (this.plugins.get("hello")?.enabled) {
      out.push(
        {
          cmd: { name: "plugin.hello.greet", title: "Say Hello", category: "Hello", description: "Answer with a greeting.", keybindings: [], args: [{ name: "name", type: ArgType.STRING, required: false, description: "Who to greet" }] },
          when: () => true,
          run: (_c, a) => `Hello, ${a.name || "world"}!`,
        },
        {
          cmd: { name: "plugin.hello.forget", title: "Forget the Word", category: "Hello", description: "Remove the remembered word from the Keychain.", keybindings: [], args: [], confirm: () => "Forget the remembered word?" },
          when: () => true,
          run: () => "forgot the word",
        },
        {
          cmd: { name: "plugin.hello.unpin", title: "Unpin Hello", category: "Hello", description: "Withdraw the pinned surface from a thread.", keybindings: [], args: [] },
          when: (ctx) => thread(ctx) && this.pinned.has(ctx?.activeThreadId ?? ""),
          run: (ctx) => {
            this.pinned.delete(ctx?.activeThreadId ?? "");
            this.bumpEpoch();
            return `unpinned from ${ctx?.activeThreadId ?? ""}`;
          },
        },
      );
    }
    return out;
  }
}

/** The view of a surface other than hello's demo: who it is and where. */
function simpleView(p: MockPlugin, s: SurfaceDef, thread: string): Record<string, unknown> {
  return {
    header: { icon: s.icon, title: s.title, pill: { label: "Signed in", tone: "ok" }, subline: thread ? `thread ${thread}` : "Per user · applies to new threads" },
    nodes: [
      {
        key: "facts",
        pairs: {
          items: [
            { key: "account", label: "Account", value: "alex.w@acme.com" },
            { key: "env", label: "Environment", value: "Production · read-only" },
            { key: "plugin", label: "Plugin", value: { spans: [{ text: `${p.name} ${p.version}`, mono: true }] } },
          ],
        },
      },
      { key: "bar", actions: { buttons: [{ key: "signout", label: "Sign out", icon: "log-out", style: "destructive", action: { event: "sign-out" } }] } },
    ],
  };
}
