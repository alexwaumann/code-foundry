/**
 * Plugins (docs/notes/plugins-1-core.md … plugins-5-gui.md) mapped to view models: the
 * plugin list (PluginService.List, the EventService plugin source), a surface's updates
 * (PluginService.WatchSurface), acts, logs and the session environment. The only file that
 * uses the generated plugin types.
 *
 * A surface's view is JSON end to end (SurfaceView.view_json, validated and re-encoded by
 * the daemon). The types below mirror pluginsdk/ui's JSON exactly: lowerCamel names,
 * short enum strings, empty fields left out, an Inline that is plain text as a bare
 * string, and a node as `{key, <kind>: {…}}`.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { fromJsonString, type JsonObject } from "@bufbuild/protobuf";
import {
  PluginInstallPhase,
  PluginService,
  PluginState,
  SurfacePhase,
  InstallPluginResponseSchema,
  type BrowsePluginsResponse,
  type Plugin,
  type PluginIndexEntry,
  type PluginInstallProgress,
  type PluginRegistry,
  type PluginEnvironment,
  type PluginEvent,
  type PluginLogLine,
  type PluginPermissions,
  type PluginSecret,
  type SurfaceUpdate,
} from "@/gen/codefoundry/v1/plugin_pb";
import { toUiContext, type UiContextView } from "./command";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";

// ---------------------------------------------------------------------------------------
// The view model (pluginsdk/ui)

/** Text, pill and notice colour. "" is neutral; "ok" (emerald) shows in pills and status glyphs only. */
export type Tone = "" | "muted" | "attention" | "error" | "ok";
/** A step's or a row's state, drawn as a dot or an icon. */
export type Status = "" | "ok" | "failed" | "attention" | "running" | "pending" | "skipped" | "off";
export type TimeStyle = "relative" | "elapsed" | "countdown";

/** A moment the host formats and ticks (RFC 3339). */
export interface TimeSpan {
  at: string;
  style?: TimeStyle;
}

/** A fixed length the host formats like an elapsed time. */
export interface DurationSpan {
  ms: number;
}

/** One piece of an Inline: text, a ticking time or a duration. */
export interface Span {
  text?: string;
  time?: TimeSpan;
  duration?: DurationSpan;
  tone?: Tone;
  mono?: boolean;
  strong?: boolean;
  /** An http(s) link the host opens. */
  url?: string;
}

/** Text that may mix tones, links and times: a bare string when it is plain text. */
export type Inline = string | { text?: string; spans?: Span[] };

export interface Pill {
  label: string;
  tone?: Tone;
}

export interface Glyph {
  status?: Status;
  /** A kebab lucide name (the host's allowlist; others draw a circle). */
  icon?: string;
  tone?: Tone;
}

export interface CommandRef {
  name: string;
  args?: Record<string, string>;
}

/** What an element does: an event to the plugin, a command, a URL to open or text to copy. */
export interface ViewAction {
  event?: string;
  command?: CommandRef;
  openUrl?: string;
  copy?: string;
  data?: string;
}

export type ButtonStyle = "muted" | "outline" | "attention" | "destructive" | "link";

export interface ViewButton {
  key: string;
  label: string;
  icon?: string;
  style?: ButtonStyle;
  action?: ViewAction;
  disabled?: boolean;
  /** Plugin-owned pending. */
  busy?: boolean;
  iconOnly?: boolean;
}

export interface ViewHeader {
  icon?: string;
  title?: string;
  trailing?: Inline;
  pill?: Pill;
  subline?: Inline;
  sublineIcon?: string;
  actions?: ViewButton[];
  tabTitle?: string;
}

export interface ViewTab {
  key: string;
  label: string;
  badge?: Pill;
}

export interface ViewTabs {
  items: ViewTab[];
  active: string;
}

export interface TextData {
  content: Inline;
  size?: "" | "sm" | "lg";
  copyable?: boolean;
}

export interface MarkdownData {
  source: string;
}

export interface Pair {
  key: string;
  label: string;
  value?: Inline;
  pill?: Pill;
  copyable?: boolean;
}

export interface PairsData {
  items: Pair[];
}

export interface Row {
  key: string;
  glyph?: Glyph;
  title: string;
  titleMeta?: Inline;
  pill?: Pill;
  line2?: Inline;
  trailing?: Inline;
  actions?: ViewButton[];
  action?: ViewAction;
  selected?: boolean;
}

export interface ListData {
  rows?: Row[];
  glyphStyle?: "dot" | "icon";
  dense?: boolean;
  emptyText?: string;
}

export interface Chip {
  key: string;
  label: string;
  status?: Status;
  meta?: Inline;
  selected?: boolean;
  action?: ViewAction;
}

export interface ChipsData {
  chips: Chip[];
}

export interface LogLine {
  text: string;
  tone?: Tone;
}

export interface LogData {
  text?: string;
  lines?: LogLine[];
  noFollow?: boolean;
  rows?: number;
  wrap?: boolean;
  truncated?: boolean;
  title?: string;
}

export interface ActionsData {
  buttons: ViewButton[];
  align?: "start" | "end";
}

export interface ProgressData {
  /** 0..1; absent: indeterminate. */
  value?: number;
  label?: string;
  meta?: Inline;
  tone?: Tone;
}

export interface NoticeData {
  tone?: Tone;
  title?: string;
  body?: Inline;
  detail?: string;
  icon?: string;
  actions?: ViewButton[];
}

export interface EmptyData {
  glyph?: Glyph;
  title?: string;
  body?: Inline;
  actions?: ViewButton[];
}

export interface SectionData {
  title?: string;
  meta?: Inline;
  pill?: Pill;
  actions?: ViewButton[];
  collapsible?: boolean;
  collapsed?: boolean;
  card?: boolean;
  tone?: Tone;
  stale?: boolean;
  children: ViewNode[];
}

export interface InputControl {
  kind?: "text" | "secret";
  value?: string;
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
  mono?: boolean;
  hasValue?: boolean;
  store?: string;
}

export interface SelectOption {
  key: string;
  value: string;
  label: string;
  description?: Inline;
  disabled?: boolean;
}

export type OptionsSource = "projects" | "threads";

export interface SelectControl {
  options?: SelectOption[];
  value?: string[];
  multiple?: boolean;
  style?: "dropdown" | "list";
  placeholder?: string;
  optionsSource?: OptionsSource;
}

export interface ToggleControl {
  value: boolean;
}

export interface FieldsetControl {
  label?: string;
  hint?: Inline;
  error?: string;
  fields: Field[];
}

export interface Field {
  key: string;
  name?: string;
  label?: string;
  description?: Inline;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  change?: ViewAction;
  input?: InputControl;
  select?: SelectControl;
  toggle?: ToggleControl;
  fieldset?: FieldsetControl;
}

export interface FormNodeData {
  fields: Field[];
  submit?: ViewButton;
  secondary?: ViewButton[];
  error?: string;
  busy?: boolean;
  resetToken?: string;
}

/** A thread or terminal node's height: "auto" (the default), "fill" (the rest of the panel) or pixels. */
export type NodeHeight = "auto" | "fill" | number;

/** The plugin's own Claude thread, inline: the thread view and (unless readOnly) its composer. */
export interface ThreadData {
  threadId: string;
  readOnly?: boolean;
  placeholder?: string;
  height?: NodeHeight;
}

/** The plugin's own terminal, inline, with "Open in bottom panel" and up to 2 buttons of the plugin's. */
export interface TerminalData {
  terminalId: string;
  /** Text rows (4..60, default 16) when height is "auto". */
  rows?: number;
  title?: string;
  height?: NodeHeight;
  actions?: ViewButton[];
}

/** Each node kind's data, by the JSON field that names the kind. */
export interface NodeData {
  text: TextData;
  markdown: MarkdownData;
  pairs: PairsData;
  list: ListData;
  chips: ChipsData;
  log: LogData;
  actions: ActionsData;
  progress: ProgressData;
  notice: NoticeData;
  empty: EmptyData;
  section: SectionData;
  form: FormNodeData;
  thread: ThreadData;
  terminal: TerminalData;
}

export type NodeKind = keyof NodeData;

/** The kinds this GUI knows, in pluginsdk/ui's order. */
export const NODE_KINDS: readonly NodeKind[] = ["text", "markdown", "pairs", "list", "chips", "log", "actions", "progress", "notice", "empty", "section", "form", "thread", "terminal"];

/** A body node: a key unique in the view and exactly one kind field. */
export type ViewNode = { key: string } & Partial<NodeData>;

/** One version of a surface's view. */
export interface PluginViewModel {
  header?: ViewHeader;
  tabs?: ViewTabs;
  nodes: ViewNode[];
}

/** A node's kind (its one kind field), or null for a node this GUI does not know. */
export function nodeKind(n: ViewNode): NodeKind | null {
  for (const k of NODE_KINDS) if (n[k] !== undefined) return k;
  return null;
}

/** Parses a view's JSON; null when it is not a view (no nodes array). */
export function parseView(json: string): PluginViewModel | null {
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== "object" || v === null || !Array.isArray((v as { nodes?: unknown }).nodes)) return null;
    return v as PluginViewModel;
  } catch {
    return null;
  }
}

/** An Inline's spans: a bare string is one text span. */
export function inlineSpans(v: Inline | undefined): Span[] {
  if (v === undefined) return [];
  if (typeof v === "string") return v ? [{ text: v }] : [];
  if (v.spans && v.spans.length > 0) return v.spans;
  return v.text ? [{ text: v.text }] : [];
}

/** An Inline as plain text (copy, titles): times and durations as their raw values. */
export function inlineText(v: Inline | undefined): string {
  return inlineSpans(v)
    .map((s) => s.text ?? (s.duration ? `${String(Math.round(s.duration.ms / 1000))}s` : (s.time?.at ?? "")))
    .join("");
}

// ---------------------------------------------------------------------------------------
// Plugins

export type PluginStateView = "disabled" | "starting" | "running" | "crashed" | "stopping" | "stopped" | "failed" | "unknown";

const pluginStates: Record<PluginState, PluginStateView> = {
  [PluginState.UNSPECIFIED]: "unknown",
  [PluginState.DISABLED]: "disabled",
  [PluginState.STARTING]: "starting",
  [PluginState.RUNNING]: "running",
  [PluginState.CRASHED]: "crashed",
  [PluginState.STOPPING]: "stopping",
  [PluginState.STOPPED]: "stopped",
  [PluginState.FAILED]: "failed",
};

/** plugin.json's permissions. */
export interface PluginPermissionsView {
  commands: string[];
  events: string[];
  threadStatus: boolean;
  sessionEnv: boolean;
  secrets: boolean;
  threads: boolean;
  terminals: boolean;
  api: boolean;
}

export interface PluginCommandView {
  name: string;
  title: string;
  description: string;
}

/** One manifest surface. Availability is its show command's (the commands store). */
export interface PluginSurfaceView {
  id: string;
  title: string;
  /** A kebab lucide name. */
  icon: string;
  /** global, thread, project, worktree or pr. */
  scope: string;
  when: string;
  /** plugin.<plugin>.show.<id>. */
  showCommand: string;
  /** The panel surface kind and ShowView stem: plugin.<plugin>.<id>. */
  kind: string;
}

export interface PluginView {
  name: string;
  displayName: string;
  version: string;
  description: string;
  state: PluginStateView;
  enabled: boolean;
  disabledReason: string;
  dev: boolean;
  devPath: string;
  dir: string;
  lastError: string;
  issues: string[];
  permissions: PluginPermissionsView;
  /** What the user consented to; null when never. */
  granted: PluginPermissionsView | null;
  consentedAtMs: number | null;
  needsConsent: boolean;
  consentText: string;
  pid: number;
  startedAtMs: number | null;
  nextRestartAtMs: number | null;
  restarts: number;
  commands: PluginCommandView[];
  surfaces: PluginSurfaceView[];
  logPath: string;
  /** Where `plugin install` got the package; null for one put in the plugins folder by hand. */
  install: PluginInstallView | null;
  /** A registry lists a newer version (updateVersion, from updateRegistry). */
  updateAvailable: boolean;
  updateVersion: string;
  updateRegistry: string;
}

function toPermissions(p: PluginPermissions | undefined): PluginPermissionsView {
  return {
    commands: [...(p?.commands ?? [])],
    events: [...(p?.events ?? [])],
    threadStatus: p?.threadStatus ?? false,
    sessionEnv: p?.sessionEnv ?? false,
    secrets: p?.secrets ?? false,
    threads: p?.threads ?? false,
    terminals: p?.terminals ?? false,
    api: p?.api ?? false,
  };
}

export function toPluginView(p: Plugin): PluginView {
  return {
    name: p.name,
    displayName: p.displayName || p.name,
    version: p.version,
    description: p.description,
    state: pluginStates[p.state],
    enabled: p.enabled,
    disabledReason: p.disabledReason,
    dev: p.dev,
    devPath: p.devPath,
    dir: p.dir,
    lastError: p.lastError,
    issues: [...p.issues],
    permissions: toPermissions(p.permissions),
    granted: p.granted ? toPermissions(p.granted) : null,
    consentedAtMs: p.consentedAt ? timestampMs(p.consentedAt) : null,
    needsConsent: p.needsConsent,
    consentText: p.consentText,
    pid: p.pid,
    startedAtMs: p.startedAt ? timestampMs(p.startedAt) : null,
    nextRestartAtMs: p.nextRestartAt ? timestampMs(p.nextRestartAt) : null,
    restarts: p.restarts,
    commands: p.commands.map((c) => ({ name: c.name, title: c.title, description: c.description })),
    surfaces: p.surfaces.map((s) => ({ id: s.id, title: s.title, icon: s.icon, scope: s.scope, when: s.when, showCommand: s.showCommand, kind: s.kind })),
    logPath: p.logPath,
    install: p.install
      ? { kind: p.install.kind, source: p.install.source, version: p.install.version, sha256: p.install.sha256, installedAtMs: p.install.installedAt ? timestampMs(p.install.installedAt) : null }
      : null,
    updateAvailable: p.updateAvailable,
    updateVersion: p.updateVersion,
    updateRegistry: p.updateRegistry,
  };
}

/** One item of the plugin source (EventService) or PluginService.Watch. */
export type PluginEventView =
  | { kind: "snapshot"; plugins: PluginView[] }
  | { kind: "updated"; plugin: PluginView }
  | { kind: "removed"; name: string }
  /** Availability may have changed: re-list commands. */
  | { kind: "availability"; epoch: number }
  /** A step of an install or update (docs/notes/plugins-7-registry.md). */
  | { kind: "install-progress"; progress: InstallProgressView }
  /** The registries' merged index changed: Browse again. */
  | { kind: "registry"; epoch: number };

export function toPluginEventView(ev: PluginEvent): PluginEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", plugins: e.value.plugins.map(toPluginView) };
    case "updated":
      return { kind: "updated", plugin: toPluginView(e.value) };
    case "removedName":
      return { kind: "removed", name: e.value };
    case "availabilityEpoch":
      return { kind: "availability", epoch: Number(e.value) };
    case "installProgress":
      return { kind: "install-progress", progress: toInstallProgress(e.value) };
    case "registryEpoch":
      return { kind: "registry", epoch: Number(e.value) };
    default:
      return null;
  }
}

/** The daemon's consent text (plugin.ConsentText) as a lead sentence and its "  - " items. */
export function consentLines(text: string): { lead: string; items: string[] } {
  const lines = text.split("\n");
  const items: string[] = [];
  const lead: string[] = [];
  for (const l of lines) {
    const m = /^\s+-\s+(.*)$/.exec(l);
    if (m?.[1] !== undefined) items.push(m[1]);
    else if (l.trim()) lead.push(l.trim());
  }
  return { lead: lead.join(" "), items };
}

export async function listPlugins(signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<PluginView[]> {
  const c = await conn.client(PluginService);
  const res = await c.list({}, { signal });
  return res.plugins.map(toPluginView);
}

export interface PluginLogLineView {
  seq: number;
  timeMs: number | null;
  /** stderr, log or host. */
  source: string;
  level: string;
  text: string;
}

function toLogLine(l: PluginLogLine): PluginLogLineView {
  return { seq: Number(l.seq), timeMs: l.time ? timestampMs(l.time) : null, source: l.source, level: l.level, text: l.text };
}

/** Where the daemon keeps plugins: the packages, and the parent of each plugin's data dir (<dataDir>/<name>). */
export interface PluginDirsView {
  pluginsDir: string;
  dataDir: string;
}

/** The daemon's plugin directories (PluginService.List; "" from a daemon that does not say). */
export async function pluginDirs(signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<PluginDirsView> {
  const c = await conn.client(PluginService);
  const res = await c.list({}, { signal });
  return { pluginsDir: res.pluginsDir, dataDir: res.dataDir };
}

/** A secret a plugin keeps in the Keychain: its name and when it was set; never its value. */
export interface PluginSecretView {
  key: string;
  updatedAtMs: number | null;
}

export function toSecretView(s: PluginSecret): PluginSecretView {
  return { key: s.key, updatedAtMs: s.updatedAt ? timestampMs(s.updatedAt) : null };
}

/** A plugin's secrets, names only (PluginService.ListSecrets), sorted by name. */
export async function listPluginSecrets(name: string, signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<PluginSecretView[]> {
  const c = await conn.client(PluginService);
  const res = await c.listSecrets({ name }, { signal });
  return res.secrets.map(toSecretView).sort((a, b) => a.key.localeCompare(b.key));
}

/** The tail of a plugin's log and the log file's path. */
export async function pluginLogs(name: string, lines = 200, signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<{ lines: PluginLogLineView[]; path: string }> {
  const c = await conn.client(PluginService);
  const res = await c.logs({ name, lines }, { signal });
  return { lines: res.lines.map(toLogLine), path: res.path };
}

/** What one plugin adds to new Claude threads, as applied. */
export interface PluginEnvironmentView {
  plugin: string;
  env: { key: string; value: string }[];
  pathPrepend: string[];
  addDirs: string[];
  /** Empty: every project. */
  projects: string[];
  noProject: boolean;
  issues: string[];
  updatedAtMs: number | null;
}

function toEnvironment(e: PluginEnvironment): PluginEnvironmentView {
  return {
    plugin: e.plugin,
    env: e.env.map((v) => ({ key: v.key, value: v.value })),
    pathPrepend: [...e.pathPrepend],
    addDirs: [...e.addDirs],
    projects: [...e.projects],
    noProject: e.noProject,
    issues: [...e.issues],
    updatedAtMs: e.updatedAt ? timestampMs(e.updatedAt) : null,
  };
}

/** Every plugin's contribution to new threads (PluginService.Environment, all plugins). */
export async function pluginEnvironments(signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<PluginEnvironmentView[]> {
  const c = await conn.client(PluginService);
  const res = await c.environment({ name: "" }, { signal });
  return res.environments.map(toEnvironment);
}

// ---------------------------------------------------------------------------------------
// Surfaces

/** The instance's host-side phase. */
export type SurfacePhaseView = "opening" | "live" | "not-responding" | "plugin-down" | "failed";

const phases: Record<SurfacePhase, SurfacePhaseView> = {
  [SurfacePhase.UNSPECIFIED]: "opening",
  [SurfacePhase.OPENING]: "opening",
  [SurfacePhase.LIVE]: "live",
  [SurfacePhase.NOT_RESPONDING]: "not-responding",
  [SurfacePhase.PLUGIN_DOWN]: "plugin-down",
  [SurfacePhase.FAILED]: "failed",
};

export type ToastLevel = "info" | "attention" | "error";

/** One update of WatchSurface. */
export type SurfaceUpdateView =
  | { kind: "state"; instance: string; phase: SurfacePhaseView; message: string; pluginState: PluginStateView }
  /** view null: the JSON did not parse (never from a sane daemon). */
  | { kind: "view"; instance: string; version: number; view: PluginViewModel | null; hostRendered: boolean }
  | { kind: "append"; instance: string; version: number; key: string; text: string; lines: LogLine[] }
  | { kind: "toast"; instance: string; level: ToastLevel; text: string };

export function toSurfaceUpdateView(u: SurfaceUpdate): SurfaceUpdateView | Heartbeat | null {
  const e = u.update;
  switch (e.case) {
    case "state":
      return { kind: "state", instance: e.value.instance, phase: phases[e.value.phase], message: e.value.message, pluginState: pluginStates[e.value.pluginState] };
    case "view":
      return { kind: "view", instance: e.value.instance, version: Number(e.value.version), view: parseView(e.value.viewJson), hostRendered: e.value.hostRendered };
    case "append":
      return {
        kind: "append",
        instance: e.value.instance,
        version: Number(e.value.version),
        key: e.value.key,
        text: e.value.text,
        lines: e.value.lines.map((l) => (l.tone ? { text: l.text, tone: l.tone as Tone } : { text: l.text })),
      };
    case "toast":
      return { kind: "toast", instance: e.value.instance, level: e.value.level === "error" || e.value.level === "attention" ? e.value.level : "info", text: e.value.text };
    case "heartbeat":
      return HEARTBEAT;
    default:
      return null;
  }
}

/** Which surface, for which context (the scope's part of it is what the daemon reads). */
export interface SurfaceRefView {
  plugin: string;
  surface: string;
  context: UiContextView;
}

/** Holds a surface instance open, yielding its updates (HEARTBEAT for heartbeats). */
export async function* watchSurface(ref: SurfaceRefView, signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<SurfaceUpdateView | Heartbeat> {
  const c = await conn.client(PluginService);
  for await (const u of c.watchSurface({ ref: { plugin: ref.plugin, surface: ref.surface, context: toUiContext(ref.context) } }, { signal })) {
    const v = toSurfaceUpdateView(u);
    if (v) yield v;
  }
}

/** A form value: text and selects are strings, toggles booleans, multiple selects lists. */
export type FieldValue = string | boolean | string[];

export interface ActRequestView {
  instance: string;
  /** The view version acted on. */
  version: number;
  /** The element's key. */
  key: string;
  /** A change's value. */
  value?: string;
  values?: Readonly<Record<string, FieldValue>>;
  /** The acting panel's context: the plugin learns which thread a click came from. */
  context?: UiContextView;
}

/** Sends a user's act on an element to the plugin; rejects with the plugin's message. */
export async function actOnSurface(req: ActRequestView, conn: DaemonConnection = daemon): Promise<number> {
  const c = await conn.client(PluginService);
  const values: JsonObject | undefined = req.values && Object.keys(req.values).length > 0 ? { ...req.values } : undefined;
  const res = await c.act({
    instance: req.instance,
    version: BigInt(req.version),
    key: req.key,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(values ? { values } : {}),
    ...(req.context ? { context: toUiContext(req.context) } : {}),
  });
  return Number(res.version);
}

// ---------------------------------------------------------------------------------------
// Registries (docs/notes/plugins-7-registry.md): Browse, install progress

/** Where an installed package came from. */
export interface PluginInstallView {
  /** registry, github or path. */
  kind: string;
  /** The registry's URL, owner/repo, or the linked folder. */
  source: string;
  version: string;
  sha256: string;
  installedAtMs: number | null;
}

export type InstallPhaseView = "resolving" | "downloading" | "verifying" | "extracting" | "installing" | "done" | "failed" | "unknown";

const installPhases: Record<PluginInstallPhase, InstallPhaseView> = {
  [PluginInstallPhase.UNSPECIFIED]: "unknown",
  [PluginInstallPhase.RESOLVING]: "resolving",
  [PluginInstallPhase.DOWNLOADING]: "downloading",
  [PluginInstallPhase.VERIFYING]: "verifying",
  [PluginInstallPhase.EXTRACTING]: "extracting",
  [PluginInstallPhase.INSTALLING]: "installing",
  [PluginInstallPhase.DONE]: "done",
  [PluginInstallPhase.FAILED]: "failed",
};

/** One step of an install: phase, the daemon's words (or the failure), bytes downloaded. */
export interface InstallProgressView {
  /** What was asked for: a registry name, owner/repo or a folder. */
  ref: string;
  /** The plugin, once resolved (else ""). */
  name: string;
  version: string;
  phase: InstallPhaseView;
  message: string;
  bytes: number;
}

export function toInstallProgress(p: PluginInstallProgress): InstallProgressView {
  return { ref: p.ref, name: p.name, version: p.version, phase: installPhases[p.phase], message: p.message, bytes: Number(p.bytes) };
}

/** One registry's state after the last read. */
export interface RegistryView {
  url: string;
  fetchedAtMs: number | null;
  cached: boolean;
  /** The last fetch's failure ("" when it worked). */
  error: string;
  plugins: number;
  issues: string[];
}

function toRegistry(r: PluginRegistry): RegistryView {
  return { url: r.url, fetchedAtMs: r.fetchedAt ? timestampMs(r.fetchedAt) : null, cached: r.cached, error: r.error, plugins: r.plugins, issues: [...r.issues] };
}

/** A plugin a registry lists (its latest version) and what is installed of it. */
export interface IndexEntryView {
  name: string;
  displayName: string;
  description: string;
  /** The source repository, owner/name on github.com ("" when the entry has none). */
  repo: string;
  version: string;
  permissions: PluginPermissionsView;
  /** The permissions in the consent dialog's words. */
  permissionLines: string[];
  /** The registry listing it. */
  registry: string;
  /** There is a build for this machine. */
  available: boolean;
  /** The installed version, null when it is not installed. */
  installedVersion: string | null;
  installedDev: boolean;
  updateAvailable: boolean;
}

export function toIndexEntry(e: PluginIndexEntry): IndexEntryView {
  return {
    name: e.name,
    displayName: e.displayName || e.name,
    description: e.description,
    repo: e.repo,
    version: e.version,
    permissions: toPermissions(e.permissions),
    permissionLines: [...e.permissionLines],
    registry: e.registry,
    available: e.available,
    installedVersion: e.installed ? e.installed.version : null,
    installedDev: e.installed?.dev ?? false,
    updateAvailable: e.updateAvailable,
  };
}

/** Every registry's plugins merged by name, the registries' states, and this machine's platform. */
export interface BrowseView {
  entries: IndexEntryView[];
  registries: RegistryView[];
  platform: string;
}

export function toBrowse(r: BrowsePluginsResponse): BrowseView {
  return { entries: r.entries.map(toIndexEntry), registries: r.registries.map(toRegistry), platform: r.platform };
}

/** PluginService.Browse: from each registry's cache (1 h) unless refresh. */
export async function browsePlugins(refresh = false, signal?: AbortSignal, conn: DaemonConnection = daemon): Promise<BrowseView> {
  const c = await conn.client(PluginService);
  return toBrowse(await c.browse({ refresh }, { signal }));
}

/** What plugin.install's result JSON (an InstallPluginResponse) says of the plugin now. */
export interface InstallOutcomeView {
  name: string;
  version: string;
  changed: boolean;
  enabled: boolean;
  needsConsent: boolean;
}

export function installOutcome(resultJson: string): InstallOutcomeView | null {
  try {
    const r = fromJsonString(InstallPluginResponseSchema, resultJson, { ignoreUnknownFields: true });
    return { name: r.plugin?.name ?? "", version: r.version, changed: r.changed, enabled: r.plugin?.enabled ?? false, needsConsent: r.plugin?.needsConsent ?? false };
  } catch {
    return null;
  }
}
