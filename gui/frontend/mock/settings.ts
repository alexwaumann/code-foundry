/**
 * Mock settings store. The schema mirrors internal/store/settings (staticFields plus one
 * keybinding field per registry command); validation mirrors Field.parse closely enough
 * for the UI's error paths. "Hand edits" to the file are simulated with
 * POST /__mock/settings/external?<key>=<value>[&loadError=…].
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { SettingType, type SettingFieldSchema, type SettingGroupSchema, type SettingsSnapshotSchema } from "../src/gen/codefoundry/v1/settings_pb";

type FieldInit = MessageInitShape<typeof SettingFieldSchema> & { key: string; type: SettingType; defaultValue: string; group: string };
type GroupInit = MessageInitShape<typeof SettingGroupSchema>;
export type SettingsSnapshotInit = MessageInitShape<typeof SettingsSnapshotSchema>;

export interface MockCommandInfo {
  name: string;
  title: string;
  category: string;
  description: string;
  keybindings: string[];
}

export const PATH = "/Users/dev/Library/Application Support/code-foundry/settings.toml";

export const groups: GroupInit[] = [
  { id: "sessions", title: "Sessions", description: "Defaults for new Claude Code sessions." },
  { id: "github", title: "GitHub", description: "Polling of pull requests and checks through gh." },
  { id: "repos", title: "Repositories", description: "Git fetching and where new worktrees go." },
  { id: "gitops", title: "Git operations", description: "How worktrees are handed to other apps." },
  { id: "appearance", title: "Appearance", description: "Theme, terminal font, and density. Applied live in every window." },
  { id: "keybindings", title: "Keybindings", description: 'Override a command\'s chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.' },
  { id: "advanced", title: "Advanced", description: "Executables and logging." },
];

const S = SettingType;
const staticFields: FieldInit[] = [
  { key: "sessions.default_model", group: "sessions", type: S.ENUM, title: "Default model", description: "Model for new sessions when none is picked. Empty uses Claude's own default.", enumValues: ["", "fable", "opus", "sonnet", "haiku"], defaultValue: "" },
  { key: "sessions.default_effort", group: "sessions", type: S.ENUM, title: "Default effort", description: "Effort level for new sessions when none is picked.", enumValues: ["", "low", "medium", "high", "xhigh", "max"], defaultValue: "" },
  { key: "sessions.auto_name", group: "sessions", type: S.BOOL, title: "Name sessions automatically", description: "Name a new session from its first message with a short claude -p call.", defaultValue: "true" },
  { key: "sessions.close_grace_seconds", group: "sessions", type: S.INT, title: "Close grace (seconds)", description: "How long closing a session waits for Claude to exit.", defaultValue: "10", min: 1n, max: 120n, restartRequired: true },
  { key: "sessions.scrollback_lines", group: "sessions", type: S.INT, title: "Scrollback lines", description: "Lines of history each terminal keeps.", defaultValue: "10000", min: 1000n, max: 100000n, restartRequired: true },
  { key: "github.poll_interval_seconds", group: "github", type: S.INT, title: "Poll interval (seconds)", description: "How often pull requests and checks are refreshed.", defaultValue: "60", min: 15n, max: 3600n, restartRequired: true },
  { key: "github.dashboards_enabled", group: "github", type: S.BOOL, title: "Pull request dashboards", description: "Fetch the viewer's dashboards for the Pull Requests page.", defaultValue: "true" },
  { key: "repos.fetch_interval_seconds", group: "repos", type: S.INT, title: "Fetch interval (seconds)", description: "How often each repository runs git fetch --prune. 0 turns it off.", defaultValue: "120", min: 0n, max: 86400n, restartRequired: true },
  { key: "repos.worktree_dir", group: "repos", type: S.PATH, title: "Worktree directory", description: "Where New Worktree puts worktrees. {repo} is replaced by the repository's name.", defaultValue: "", placeholder: "~/worktrees/{repo}" },
  { key: "gitops.editor_command", group: "gitops", type: S.STRING, title: "Editor command", description: "Command that opens a worktree (Open in Editor). {path} is replaced by the worktree path. Empty detects an editor.", defaultValue: "", placeholder: "auto-detect" },
  { key: "appearance.theme", group: "appearance", type: S.ENUM, title: "Theme", description: "System follows the macOS appearance.", enumValues: ["system", "dark", "light"], defaultValue: "system" },
  { key: "appearance.font_family", group: "appearance", type: S.STRING, title: "Terminal font family", description: "Comma-separated font families, first installed wins.", defaultValue: "JetBrains Mono, SF Mono, Menlo", placeholder: "JetBrains Mono, SF Mono, Menlo" },
  { key: "appearance.font_size", group: "appearance", type: S.INT, title: "Terminal font size", description: "In points. cmd+= and cmd+- change it too.", defaultValue: "13", min: 9n, max: 28n },
  { key: "appearance.density", group: "appearance", type: S.ENUM, title: "Density", description: "Row height and spacing in the sidebar and lists.", enumValues: ["compact", "comfortable"], defaultValue: "compact" },
  { key: "advanced.claude_path", group: "advanced", type: S.PATH, title: "claude executable", description: "Absolute path to claude. Empty finds it on PATH.", defaultValue: "", placeholder: "claude (from PATH)", restartRequired: true },
  { key: "advanced.gh_path", group: "advanced", type: S.PATH, title: "gh executable", description: "Absolute path to gh. Empty finds it on PATH.", defaultValue: "", placeholder: "gh (from PATH)", restartRequired: true },
  { key: "advanced.log_level", group: "advanced", type: S.ENUM, title: "Log level", description: "Minimum level written to the daemon's log file.", enumValues: ["debug", "info", "warn", "error"], defaultValue: "info" },
];

const reserved = new Set([
  "cmd+k", "cmd+shift+p", "cmd+b", "cmd+shift+a", "cmd+1", "cmd+2", "cmd+3", "cmd+4", "cmd+5", "cmd+6", "cmd+7", "cmd+8", "cmd+9",
  "cmd+=", "cmd+-", "cmd+0", "cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z", "cmd+w", "cmd+q",
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

  fields(): FieldInit[] {
    const kb = [...this.commands()]
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      .map<FieldInit>((c) => ({
        key: `keybindings.${c.name}`, group: "keybindings", type: S.KEYBINDING, title: `${c.category}: ${c.title}`,
        description: c.description, defaultValue: normalize(c.keybindings[0] ?? "") ?? "", placeholder: c.name,
      }));
    return [...staticFields, ...kb];
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
