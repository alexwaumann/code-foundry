/**
 * Mock settings store. The schema mirrors internal/store/settings (staticFields plus one
 * keybinding field per bindable registry command, and the pages they show on);
 * validation mirrors Field.parse closely enough for the UI's error paths. "Hand edits" to
 * the file are simulated with POST /__mock/settings/external?<key>=<value>[&loadError=…].
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { SettingType, type SettingFieldSchema, type SettingGroupSchema, type SettingsSnapshotSchema } from "../src/gen/codefoundry/v1/settings_pb";
import { DEFAULT_DARK, DEFAULT_LIGHT, themesFor } from "../src/themes";

type FieldInit = MessageInitShape<typeof SettingFieldSchema> & { key: string; type: SettingType; defaultValue: string; group: string; page: string; section: string };
type GroupInit = MessageInitShape<typeof SettingGroupSchema>;
/** A SettingPage init, kept plain so pages() can spread it. */
type PageInit = { id: string; title: string; description?: string; sections?: { id: string; title: string; description?: string }[] };
export type SettingsSnapshotInit = MessageInitShape<typeof SettingsSnapshotSchema>;

export interface MockCommandInfo {
  name: string;
  title: string;
  category: string;
  description: string;
  keybindings: string[];
}

export const PATH = "/Users/dev/.code-foundry/settings.toml";

export const groups: GroupInit[] = [
  { id: "threads", title: "Threads", description: "Defaults for new threads." },
  { id: "github", title: "GitHub", description: "Your pull requests and default-branch checks, polled with gh's login." },
  { id: "repos", title: "Repositories", description: "Git fetching and where new worktrees go." },
  { id: "gitops", title: "Git operations", description: "How worktrees are handed to other apps." },
  { id: "appearance", title: "Appearance", description: "Scheme, themes, terminal font, density, and backdrop. Applied live in every window." },
  { id: "notifications", title: "Notifications", description: "Dock badge and alerts for threads that need you. macOS banners aren't available to an app without a bundle." },
  { id: "keybindings", title: "Keybindings", description: 'Override a command\'s chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.' },
  { id: "update", title: "Updates", description: "Which releases the app checks for and offers to install." },
  { id: "advanced", title: "Advanced", description: "Executables and logging." },
];

const S = SettingType;

/** internal/model's registry, in order: values for --model and their labels. */
export const MODELS: readonly { value: string; label: string }[] = [
  { value: "claude-opus-5-5[1m]", label: "Opus 5.5" },
  { value: "claude-opus-4-8[1m]", label: "Opus 4.8" },
  { value: "claude-opus-4-7[1m]", label: "Opus 4.7" },
  { value: "claude-sonnet-5-5[1m]", label: "Sonnet 5.5" },
  { value: "claude-sonnet-5[1m]", label: "Sonnet 5" },
  { value: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6" },
  { value: "claude-haiku-5-5[1m]", label: "Haiku 5.5" },
  { value: "claude-4.5-haiku[1m]", label: "Haiku 4.5" },
];
export const MODEL_VALUES: string[] = MODELS.map((m) => m.value);

/** Like settings.Pages: display order; the keybindings page's sections come from the command categories (pages()). */
export const staticPages: PageInit[] = [
  {
    id: "general",
    title: "General",
    sections: [
      { id: "threads", title: "Threads" },
      { id: "textgen", title: "Text generation", description: "Models for small side jobs such as naming a thread." },
      { id: "lifecycle", title: "Lifecycle" },
      { id: "updates", title: "Updates" },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    description: "Applied live in every window.",
    sections: [
      { id: "theme", title: "Theme" },
      { id: "window", title: "Window" },
      { id: "terminal", title: "Terminal" },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "Dock badge and alerts for threads that need you. macOS banners aren't available to an app without a bundle.",
    sections: [{ id: "alerts", title: "" }],
  },
  {
    id: "source",
    title: "Source control",
    sections: [
      { id: "github", title: "GitHub", description: "Your pull requests and default-branch checks, polled with gh's login." },
      { id: "repos", title: "Repositories", description: "Fetching, where new worktrees go, and how they open." },
    ],
  },
  { id: "keybindings", title: "Keybindings", description: "Override a command's chord, or unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) can't be bound." },
  {
    id: "advanced",
    title: "Advanced",
    sections: [
      { id: "executables", title: "Executables" },
      { id: "logging", title: "Logging" },
    ],
  },
];

/** Commands a chord is no use for (command.Command.NoKeybinding): no keybinding field. */
export const NO_KEYBINDING = new Set([
  "action.list", "action.runs", "action.wait", "app.version", "daemon.status", "daemon.version",
  "settings.get", "settings.path", "settings.reset", "settings.set", "terminal.list", "theme.list",
  "thread.agents", "thread.commands", "thread.focus", "thread.items", "thread.list", "thread.mcp", "thread.respond",
  "ui.focus.repo", "ui.focus.terminal", "ui.notify", "ui.palette.open", "usage.show", "view.open.url",
  "workspace.list", "workspace.members",
]);

/** A category's keybindings section id ("Pull Request" -> "pull-request"). */
function categorySection(category: string): string {
  return category.trim().toLowerCase().replaceAll(" ", "-");
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const staticFields: FieldInit[] = [
  {
    key: "threads.default_model",
    group: "threads",
    page: "general",
    section: "threads",
    row: "model",
    type: S.ENUM,
    title: "Model",
    description: "Used by new threads unless you pick otherwise. Every model runs with the 1M context window.",
    enumValues: MODEL_VALUES,
    enumLabels: MODELS.map((m) => m.label),
    defaultValue: "claude-opus-4-8[1m]",
  },
  {
    key: "threads.default_effort",
    group: "threads",
    page: "general",
    section: "threads",
    row: "model",
    type: S.ENUM,
    title: "Effort",
    description: "Effort level new threads use unless you pick otherwise.",
    enumValues: EFFORTS,
    enumLabels: ["Low", "Medium", "High", "Extra high", "Max"],
    defaultValue: "high",
  },
  {
    key: "threads.default_worktree",
    group: "threads",
    page: "general",
    section: "threads",
    type: S.ENUM,
    title: "New threads work in",
    description: "A fresh copy keeps each thread on its own branch and folder. The project folder itself edits your files in place.",
    enumValues: ["new", "current"],
    enumLabels: ["A fresh copy of the project", "The project folder itself"],
    defaultValue: "new",
  },
  { key: "threads.auto_name", group: "threads", page: "general", section: "threads", type: S.BOOL, title: "Name threads automatically", description: "Name a new thread from its first message with a short claude -p call to the naming model.", defaultValue: "true" },
  {
    key: "threads.naming_model",
    group: "threads",
    page: "general",
    section: "textgen",
    dependsOn: "threads.auto_name",
    type: S.ENUM,
    title: "Naming model",
    description: "Names a new thread from its first message. Always runs at low effort.",
    enumValues: MODEL_VALUES,
    enumLabels: MODELS.map((m) => m.label),
    defaultValue: "claude-sonnet-5[1m]",
  },
  { key: "threads.cache_ttl_seconds", group: "threads", page: "general", section: "lifecycle", unit: "s", type: S.INT, title: "Prompt cache lifetime", description: "How long the Claude API keeps a conversation's prompt cache after its last request (1 hour on Bedrock and the Anthropic API). Code Foundry uses it to predict when a thread's cache has expired; it does not change the API's behaviour.", defaultValue: "3600", min: 60n, max: 86400n },
  { key: "threads.close_grace_seconds", group: "threads", page: "general", section: "lifecycle", unit: "s", type: S.INT, title: "Close grace", description: "How long closing a thread waits for Claude to exit before terminating it.", defaultValue: "10", min: 1n, max: 120n, restartRequired: true },
  { key: "update.channel", group: "update", page: "general", section: "updates", type: S.ENUM, title: "Channel", description: "Stable is a build promoted on purpose; tip is the newest build of main, published on every push. Switching never installs an older version.", enumValues: ["stable", "tip"], enumLabels: ["Stable", "Tip"], defaultValue: "stable" },
  { key: "appearance.theme", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Scheme", description: "Dark or light. System follows the macOS appearance.", enumValues: ["system", "dark", "light"], enumLabels: ["System", "Dark", "Light"], defaultValue: "system" },
  // Like internal/store/settings themeField: the catalog's themes of one scheme.
  { key: "appearance.theme_dark", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Dark theme", description: "Colours of the window, threads and terminals when the scheme is dark.", enumValues: themesFor("dark").map((t) => t.id), enumLabels: themesFor("dark").map((t) => t.name), defaultValue: DEFAULT_DARK },
  { key: "appearance.theme_light", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Light theme", description: "Colours of the window, threads and terminals when the scheme is light.", enumValues: themesFor("light").map((t) => t.id), enumLabels: themesFor("light").map((t) => t.name), defaultValue: DEFAULT_LIGHT },
  { key: "appearance.zoom", group: "appearance", page: "appearance", section: "window", unit: "%", type: S.INT, title: "Zoom", description: "Scale of the whole window, terminal included. ⌘=, ⌘- and ⌘0 change it too.", defaultValue: "100", min: 90n, max: 200n },
  { key: "appearance.density", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Density", description: "Row height and spacing in the sidebar and lists.", enumValues: ["compact", "comfortable"], enumLabels: ["Compact", "Comfortable"], defaultValue: "compact" },
  { key: "appearance.thread_width", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Thread width", description: "Column width of a rendered thread's conversation and composer.", enumValues: ["compact", "comfortable", "full"], enumLabels: ["Compact", "Comfortable", "Full"], defaultValue: "comfortable" },
  { key: "appearance.backdrop", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Backdrop", description: "Faint artwork behind the start page and the new-thread composer.", enumValues: ["forest", "none"], enumLabels: ["Forest", "None"], defaultValue: "forest" },
  { key: "appearance.font_family", group: "appearance", page: "appearance", section: "terminal", type: S.STRING, title: "Font family", description: "Comma-separated font families; the first one installed wins. JetBrainsMono Nerd Font Mono ships with the app, and ui-monospace and Menlo are always appended.", defaultValue: "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo", placeholder: "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo" },
  { key: "appearance.font_size", group: "appearance", page: "appearance", section: "terminal", unit: "pt", type: S.INT, title: "Font size", description: "Size of terminal text, before zoom.", defaultValue: "13", min: 9n, max: 28n },
  { key: "threads.scrollback_lines", group: "threads", page: "appearance", section: "terminal", type: S.INT, title: "Scrollback lines", description: "Lines of history each terminal keeps, in the daemon and in the window.", defaultValue: "10000", min: 1000n, max: 100000n, restartRequired: true },
  { key: "notifications.dock_badge", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Dock badge", description: "Show how many threads need attention (waiting on you or finished) on the Dock icon.", defaultValue: "true" },
  { key: "notifications.bounce", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Bounce the Dock icon", description: "Bounce once when a thread starts needing attention while Code Foundry is not the active app.", defaultValue: "true" },
  { key: "notifications.sound", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Alert sound", description: "Play a short sound when a thread starts needing attention while Code Foundry is not the active app.", defaultValue: "false" },
  { key: "notifications.sound_volume", group: "notifications", page: "notifications", section: "alerts", dependsOn: "notifications.sound", unit: "%", type: S.INT, title: "Alert volume", description: "Loudness of the alert sound, as a share of the Mac's output volume.", defaultValue: "50", min: 0n, max: 100n },
  { key: "notifications.cooldown_seconds", group: "notifications", page: "notifications", section: "alerts", unit: "s", type: S.INT, title: "Alert cooldown", description: "Minimum gap between alerts (bounce and sound); the badge still updates. 0 alerts every time.", defaultValue: "60", min: 0n, max: 3600n },
  { key: "github.dashboards_enabled", group: "github", page: "source", section: "github", type: S.BOOL, title: "Pull request dashboards", description: "Poll your pull requests (authored, awaiting your review, reviewed, recently merged) for the Pull Requests page. Off leaves only default-branch CI and watched branches.", defaultValue: "true" },
  { key: "github.poll_interval_seconds", group: "github", page: "source", section: "github", unit: "s", type: S.INT, title: "Poll interval", description: "How often one request checks your pull requests, watched branches and tracked default branches for changes while the app's window is visible. Details are fetched only for what changed. With the window hidden it checks every 5 minutes, with the app closed every 15 (or at this interval, if longer).", defaultValue: "60", min: 15n, max: 3600n },
  { key: "repos.fetch_interval_seconds", group: "repos", page: "source", section: "repos", unit: "s", type: S.INT, title: "Fetch interval", description: "How often each repository runs git fetch --prune. 0 turns background fetching off.", defaultValue: "120", min: 0n, max: 86400n, restartRequired: true },
  { key: "repos.worktree_dir", group: "repos", page: "source", section: "repos", type: S.PATH, title: "Worktree directory", description: "Where New Worktree puts worktrees; {repo} is the repository's name. Empty uses ~/.code-foundry/worktrees/<owner>/<repo>.", defaultValue: "", placeholder: "~/worktrees/{repo}" },
  { key: "gitops.editor_command", group: "gitops", page: "source", section: "repos", type: S.STRING, title: "Editor command", description: "Opens a worktree (Open in Editor), e.g. \"code\" or \"open -a Zed\"; {path} is the worktree path, else the path is appended. Empty detects an editor.", defaultValue: "", placeholder: "auto-detect" },
  { key: "advanced.claude_path", group: "advanced", page: "advanced", section: "executables", type: S.PATH, title: "claude executable", description: "Absolute path to claude. Empty finds it on PATH.", defaultValue: "", placeholder: "claude (from PATH)", restartRequired: true },
  { key: "advanced.gh_path", group: "advanced", page: "advanced", section: "executables", type: S.PATH, title: "gh executable", description: "Absolute path to gh. Empty finds it on PATH or in Homebrew's locations.", defaultValue: "", placeholder: "gh (from PATH)", restartRequired: true },
  { key: "advanced.log_level", group: "advanced", page: "advanced", section: "logging", type: S.ENUM, title: "Log level", description: "Minimum level written to the daemon's log file (logs/daemon.log).", enumValues: ["debug", "info", "warn", "error"], enumLabels: ["Debug", "Info", "Warn", "Error"], defaultValue: "info" },
];

const reserved = new Set([
  "cmd+k", "cmd+shift+p", "cmd+b", "cmd+shift+a", "cmd+1", "cmd+2", "cmd+3", "cmd+4", "cmd+5", "cmd+6", "cmd+7", "cmd+8", "cmd+9",
  "cmd+=", "cmd+-", "cmd+0", "cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z", "cmd+w", "cmd+shift+c", "cmd+q",
  "cmd+h", "cmd+alt+h", "cmd+m", "cmd+ctrl+f",
]);

const order = ["cmd", "ctrl", "alt", "shift"];
function normalize(chord: string): string | null {
  const parts = chord.trim().toLowerCase().split("+");
  const key = parts.pop();
  if (!key) return null;
  const alias: Record<string, string> = { meta: "cmd", command: "cmd", control: "ctrl", opt: "alt", option: "alt" };
  const mods = [...new Set(parts.map((p) => alias[p] ?? p))];
  if (mods.some((m) => !order.includes(m))) return null;
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join("+");
}

function without(r: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));
}

export class SettingsValidation extends Error {
  constructor(readonly issues: { key: string; message: string }[]) {
    super(`invalid settings: ${issues.map((i) => `${i.key}: ${i.message}`).join("; ")}`);
  }
}

export class MockSettings {
  /** Values as written in the "file", by key. */
  raw: Record<string, string> = {};
  revision = 1;
  loadError = "";
  private readonly startup: Record<string, string>;

  constructor(
    private readonly commands: () => MockCommandInfo[],
    private readonly publish: (snap: SettingsSnapshotInit) => void,
  ) {
    this.startup = Object.fromEntries(staticFields.map((f) => [f.key, f.defaultValue]));
  }

  reset(): void {
    this.raw = {};
    this.loadError = "";
    this.revision = 1;
  }

  /** Bindable commands sorted like the palette: by category, then title. */
  private bindable(): MockCommandInfo[] {
    return this.commands()
      .filter((c) => !NO_KEYBINDING.has(c.name))
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
  }

  fields(): FieldInit[] {
    const kb = this.bindable().map<FieldInit>((c) => ({
      key: `keybindings.${c.name}`, group: "keybindings", page: "keybindings", section: categorySection(c.category), type: S.KEYBINDING,
      title: c.title.startsWith(`${c.category}: `) ? c.title.slice(c.category.length + 2) : c.title,
      description: c.description, defaultValue: normalize(c.keybindings[0] ?? "") ?? "", placeholder: c.name,
    }));
    return [...staticFields, ...kb];
  }

  /** staticPages with one keybindings section per category that has a bindable command. */
  pages(): PageInit[] {
    const cats = [...new Set(this.bindable().map((c) => c.category))];
    return staticPages.map((p) => (p.id === "keybindings" ? { ...p, sections: cats.map((c) => ({ id: categorySection(c), title: c })) } : p));
  }

  /** Effective values (defaults included). */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.fields()) out[f.key] = this.raw[f.key] ?? f.defaultValue;
    return out;
  }

  /** Effective chords by command (overrides applied); [] when unbound. */
  keybindings(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const c of this.commands()) {
      const o = this.raw[`keybindings.${c.name}`];
      out[c.name] = o === undefined ? c.keybindings : o === "none" ? [] : [o];
    }
    return out;
  }

  snapshot(): SettingsSnapshotInit {
    const values = this.values();
    const restartPending = staticFields.filter((f) => f.restartRequired && values[f.key] !== this.startup[f.key]).map((f) => f.key);
    return { values, path: PATH, revision: BigInt(this.revision), loadError: this.loadError, issues: [], restartPending };
  }

  private parse(f: FieldInit, v: string): string {
    switch (f.type) {
      case S.INT: {
        if (!/^-?\d+$/.test(v.trim())) throw new Error(`want an integer, got "${v}"`);
        const n = Number(v);
        if (n < Number(f.min) || n > Number(f.max)) throw new Error(`want ${String(f.min)} to ${String(f.max)}, got ${String(n)}`);
        return String(n);
      }
      case S.BOOL:
        if (v !== "true" && v !== "false") throw new Error(`want true or false, got "${v}"`);
        return v;
      case S.ENUM:
        if (!(f.enumValues ?? []).includes(v)) throw new Error(`want one of ${(f.enumValues ?? []).map((e) => JSON.stringify(e)).join(", ")}, got "${v}"`);
        return v;
      case S.PATH:
        if (!v.startsWith("/") && !v.startsWith("~")) throw new Error(`want an absolute path, got "${v}"`);
        return v;
      case S.KEYBINDING: {
        if (v.toLowerCase() === "none") return "none";
        const c = normalize(v);
        if (!c) throw new Error(`unknown key in "${v}"`);
        if (reserved.has(c)) throw new Error(`${c} is reserved by the app`);
        return c;
      }
      default:
        return v;
    }
  }

  update(partial: Record<string, string>): SettingsSnapshotInit {
    if (this.loadError) throw new Error(`settings file has a syntax error: ${this.loadError}`);
    const fields = new Map(this.fields().map((f) => [f.key, f]));
    let next = { ...this.raw };
    const issues: { key: string; message: string }[] = [];
    for (const [k, v] of Object.entries(partial)) {
      const f = fields.get(k);
      if (!f) {
        issues.push({ key: k, message: "unknown setting" });
        continue;
      }
      if (v === "") {
        next = without(next, k);
        continue;
      }
      try {
        next[k] = this.parse(f, v);
      } catch (err) {
        issues.push({ key: k, message: (err as Error).message });
      }
    }
    // Collisions between effective chords.
    const owners = new Map<string, string>();
    for (const c of this.commands()) {
      const o = next[`keybindings.${c.name}`];
      for (const chord of o === undefined ? c.keybindings.map((k) => normalize(k) ?? k) : o === "none" ? [] : [o]) {
        const prev = owners.get(chord);
        if (prev && `keybindings.${c.name}` in partial) issues.push({ key: `keybindings.${c.name}`, message: `${chord} is already bound to ${prev}` });
        else if (prev && `keybindings.${prev}` in partial) issues.push({ key: `keybindings.${prev}`, message: `${chord} is already bound to ${c.name}` });
        else owners.set(chord, c.name);
      }
    }
    if (issues.length > 0) throw new SettingsValidation(issues);
    this.raw = next;
    return this.changed();
  }

  /** A hand edit of the file: merge values ("" deletes a key), or set a parse error. */
  external(values: Record<string, string>, loadError: string | null): SettingsSnapshotInit {
    if (loadError !== null) this.loadError = loadError;
    else {
      this.loadError = "";
      for (const [k, v] of Object.entries(values)) {
        this.raw = v === "" ? without(this.raw, k) : { ...this.raw, [k]: v };
      }
    }
    return this.changed();
  }

  private changed(): SettingsSnapshotInit {
    this.revision++;
    const snap = this.snapshot();
    this.publish(snap);
    return snap;
  }
}
