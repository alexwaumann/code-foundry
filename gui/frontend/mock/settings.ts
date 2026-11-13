/**
 * Mock settings store. The schema mirrors internal/store/settings (staticFields plus one
 * keybinding field per bindable registry command, and the pages they show on);
 * validation mirrors Field.parse closely enough for the UI's error paths. "Hand edits" to
 * the file are simulated with POST /__mock/settings/external?<key>=<value>[&loadError=…].
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { SettingType, type SettingFieldSchema, type SettingGroupSchema, type SettingsSnapshotSchema } from "../src/gen/codefoundry/v1/settings_pb";
import { DEFAULT_DARK, DEFAULT_LIGHT, themesFor } from "../src/themes";
import { MODELS } from "./models";
import { FIXTURE_REGISTRY } from "./pluginRegistry";

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
  noPalette?: boolean;
}

export const PATH = "/Users/dev/.code-foundry/settings.toml";

export const groups: GroupInit[] = [
  { id: "threads", title: "Threads", description: "Defaults for new threads." },
  { id: "models", title: "Models", description: "The models Code Foundry uses for its own jobs." },
  { id: "github", title: "GitHub", description: "Pull requests and checks, read with your gh login." },
  { id: "projects", title: "Projects", description: "Background fetching, fast-forwarding checkouts on the default branch, and new worktrees' branches: how they are named and whether they start from origin." },
  { id: "gitops", title: "Git operations", description: "How worktrees are handed to other apps." },
  { id: "appearance", title: "Appearance", description: "Scheme, themes, terminal font, density and backdrop. Applied live in every window." },
  { id: "notifications", title: "Notifications", description: "How the Dock tells you a thread needs you. macOS banners aren't available to this app." },
  { id: "layout", title: "Layout", description: "How the window's panes follow the thread you focus." },
  { id: "sidebar", title: "Sidebar", description: "What the sidebar lists." },
  { id: "keybindings", title: "Keybindings", description: 'Override a command\'s chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.' },
  { id: "update", title: "Updates", description: "Which releases the app checks for and offers to install." },
  { id: "plugins", title: "Plugins", description: "Where plugins are installed from." },
  { id: "ember", title: "Ember", description: "The resident agent: whether it runs, its models, and when it starts a fresh session." },
  { id: "dictation", title: "Dictation", description: "Voice dictation into the composers, transcribed on this Mac." },
  { id: "advanced", title: "Advanced", description: "Executables and logging." },
];

const S = SettingType;

export const MODEL_VALUES: string[] = MODELS.map((m) => m.value);

/** Thread.context_window: the registry's window for a model value, 0 when it is not listed. */
export function contextWindow(model: string): bigint {
  return BigInt(MODELS.find((m) => m.value === model)?.contextWindow ?? 0);
}

/** Like settings.Pages: display order; the keybindings page's sections come from the command categories (pages()). */
export const staticPages: PageInit[] = [
  {
    id: "general",
    title: "General",
    sections: [
      { id: "threads", title: "Threads" },
      { id: "textgen", title: "Text generation", description: "Models for small jobs like naming a thread." },
      { id: "lifecycle", title: "Lifecycle" },
      { id: "dictation", title: "Dictation", description: "Speak into any composer. Transcribed on this Mac with Whisper; audio never leaves it." },
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
      { id: "panes", title: "Panes and sidebar" },
      { id: "terminal", title: "Terminal" },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    description: "How the Dock tells you a thread needs you. macOS banners aren't available to this app.",
    sections: [{ id: "alerts", title: "" }],
  },
  {
    id: "source",
    title: "Source control",
    sections: [
      { id: "github", title: "GitHub", description: "Pull requests and checks, read with your gh login." },
      { id: "projects", title: "Projects", description: "Fetching, branches and worktrees." },
    ],
  },
  {
    id: "ember",
    title: "Ember",
    description: "A resident agent that plans work, runs worker threads and reports back in its own chat.",
    sections: [
      { id: "experiment", title: "Experiment" },
      { id: "models", title: "Models" },
      { id: "epochs", title: "Epochs", description: "When Ember starts a fresh session, seeded with its memory, task board and recent messages. Checked after each turn." },
    ],
  },
  { id: "keybindings", title: "Keybindings", description: "Change or remove a command's shortcut. App shortcuts like cmd+k, cmd+b and cmd+1..9 are reserved." },
  {
    id: "advanced",
    title: "Advanced",
    sections: [
      { id: "executables", title: "Executables" },
      { id: "logging", title: "Logging" },
    ],
  },
  {
    id: "plugins",
    title: "Plugins",
    description: "Programs that add commands, panels and thread options to Code Foundry.",
    sections: [{ id: "registries", title: "Registries", description: "Where Browse finds plugins to install." }],
  },
];

/** Commands a chord is no use for (command.Command.NoKeybinding): no keybinding field. */
export const NO_KEYBINDING = new Set([
  "action.list", "action.runs", "action.stop", "action.wait", "app.version", "daemon.status", "daemon.version", "dictation.status", "file.export",
  "memory.add", "memory.clear", "memory.remove", "memory.show", "plugin.browse", "plugin.reload", "project.list",
  "search.agent", "search.clear", "search.find", "search.forget", "search.get", "search.open-hit", "search.promote", "search.recent", "search.seen", "search.stop",
  "pane.focus", "pane.move", "pane.resize",
  "settings.get", "settings.path", "settings.reset", "settings.set", "skill.browse", "terminal.list",
  "composer.draft.clear", "composer.draft.discard", "composer.draft.label", "composer.draft.open", "composer.draft.start", "space.move", "space.rename", "space.switch", "tab.focus", "tab.move",
  "theme.check", "theme.list", "theme.restore", "theme.save", "theme.show",
  "thread.agent.open", "thread.agents", "thread.info", "thread.open", "thread.space.move", "thread.checkouts", "thread.commands", "thread.flag.clear", "thread.focus", "thread.items", "thread.list", "thread.mcp",
  "thread.move.open", "thread.new-like", "thread.respond", "thread.setup.cancel", "thread.setup.discard", "thread.setup.retry", "thread.shell.stop",
  "thread.stop-waiting", "thread.unsubscribe", "thread.wait",
  "ui.focus.project", "ui.focus.terminal", "ui.notify", "ui.palette.open", "usage.show",
  "view.open.diff", "view.open.file", "view.open.gallery", "view.open.page", "view.open.pr", "view.open.url", "view.panel.gallery", "view.panel.page", "workspace.list",
]);

/** A category's keybindings section id ("Pull Request" -> "pull-request"). */
function categorySection(category: string): string {
  return category.trim().toLowerCase().replaceAll(" ", "-");
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS = ["Low", "Medium", "High", "Extra high", "Max"];
/** ember.effort's levels (emberEfforts). */
const EMBER_EFFORTS = EFFORTS.slice(0, 3);
/** model.EmberWorkersDefault. */
const EMBER_WORKERS_DEFAULT = "claude-opus-4-7[1m],claude-opus-4-8[1m]";

/** checkModelList: a comma-separated list of model registry values, at least one, each once. */
export function checkModelList(v: string): void {
  const ids = v.split(",").map((p) => p.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("want at least one model id");
  ids.forEach((id, i) => {
    if (!MODEL_VALUES.includes(id)) throw new Error(`unknown model ${JSON.stringify(id)}; want ids from ${MODEL_VALUES.map((m) => JSON.stringify(m)).join(", ")}`);
    if (ids.slice(0, i).includes(id)) throw new Error(`model ${JSON.stringify(id)} is listed twice`);
  });
}

/** Field.check beyond the type's parse, by key. */
const checks: Record<string, (v: string) => void> = { "ember.worker_models": checkModelList };

const staticFields: FieldInit[] = [
  {
    key: "threads.default_model",
    group: "threads",
    page: "general",
    section: "threads",
    row: "model",
    type: S.ENUM,
    title: "Model",
    description: "The default for new threads. Every model runs with the 1M context window.",
    enumValues: MODEL_VALUES,
    enumLabels: MODELS.map((m) => m.label),
    defaultValue: "claude-sonnet-5[1m]",
  },
  {
    key: "threads.default_effort",
    group: "threads",
    page: "general",
    section: "threads",
    row: "model",
    type: S.ENUM,
    title: "Effort",
    description: "The default effort for new threads.",
    enumValues: EFFORTS,
    enumLabels: EFFORT_LABELS,
    defaultValue: "medium",
  },
  {
    key: "threads.default_worktree",
    group: "threads",
    page: "general",
    section: "threads",
    type: S.ENUM,
    title: "New threads work in",
    description: "A fresh copy gives each thread its own folder and branch, so several can run at once. The project folder itself edits your files in place.",
    enumValues: ["new", "current"],
    enumLabels: ["A fresh copy of the project", "The project folder itself"],
    defaultValue: "current",
  },
  { key: "threads.auto_name", group: "threads", page: "general", section: "threads", type: S.BOOL, title: "Name threads automatically", description: "Give each new thread a name based on its first message.", defaultValue: "true" },
  {
    key: "models.utility",
    group: "models",
    page: "general",
    section: "textgen",
    type: S.ENUM,
    title: "Utility model",
    description: "The model Code Foundry uses for its own small jobs. Always runs at low effort.",
    enumValues: MODEL_VALUES,
    enumLabels: MODELS.map((m) => m.label),
    defaultValue: "claude-sonnet-4-6[1m]",
  },
  { key: "threads.cache_ttl_seconds", group: "threads", page: "general", section: "lifecycle", unit: "s", type: S.INT, title: "Prompt cache lifetime", description: "How long the Claude API keeps a conversation's prompt cache (1 hour on Bedrock and the Anthropic API). Code Foundry uses this to tell when a thread's cache has expired. It doesn't change the API.", defaultValue: "3600", min: 60n, max: 86400n },
  { key: "threads.close_grace_seconds", group: "threads", page: "general", section: "lifecycle", unit: "s", type: S.INT, title: "Close grace", description: "How long a closing thread waits for Claude to exit before it is force-quit.", defaultValue: "10", min: 1n, max: 120n, restartRequired: true },
  { key: "update.channel", group: "update", page: "general", section: "updates", type: S.ENUM, title: "Channel", description: "Stable gets releases chosen by hand. Tip gets every build of main. Switching never installs an older version.", enumValues: ["stable", "tip"], enumLabels: ["Stable", "Tip"], defaultValue: "stable" },
  { key: "appearance.theme", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Scheme", description: "Dark or light. System follows the macOS appearance.", enumValues: ["system", "dark", "light"], enumLabels: ["System", "Dark", "Light"], defaultValue: "system" },
  // Like internal/store/settings themeField: the catalog's themes of one scheme.
  { key: "appearance.theme_dark", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Dark theme", description: "Colours used when the scheme is dark.", enumValues: themesFor("dark").map((t) => t.id), enumLabels: themesFor("dark").map((t) => t.name), defaultValue: DEFAULT_DARK },
  { key: "appearance.theme_light", group: "appearance", page: "appearance", section: "theme", type: S.ENUM, title: "Light theme", description: "Colours used when the scheme is light.", enumValues: themesFor("light").map((t) => t.id), enumLabels: themesFor("light").map((t) => t.name), defaultValue: DEFAULT_LIGHT },
  { key: "appearance.zoom", group: "appearance", page: "appearance", section: "window", unit: "%", type: S.INT, title: "Zoom", description: "Scale of the whole window. ⌘=, ⌘- and ⌘0 change it too.", defaultValue: "100", min: 90n, max: 200n },
  { key: "appearance.density", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Density", description: "Spacing in the sidebar and lists.", enumValues: ["compact", "comfortable"], enumLabels: ["Compact", "Comfortable"], defaultValue: "comfortable" },
  { key: "appearance.thread_width", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Thread width", description: "Width of the conversation column.", enumValues: ["compact", "comfortable", "full"], enumLabels: ["Compact", "Comfortable", "Full"], defaultValue: "comfortable" },
  { key: "appearance.backdrop", group: "appearance", page: "appearance", section: "window", type: S.ENUM, title: "Backdrop", description: "Faint artwork behind the new-thread composer.", enumValues: ["forest", "none", "custom"], enumLabels: ["Forest", "None", "Custom"], defaultValue: "forest" },
  { key: "appearance.backdrop_file", group: "appearance", page: "appearance", section: "window", type: S.STRING, title: "Backdrop image", description: "The file the Custom backdrop shows, from the backdrops folder of the Code Foundry home. Add and remove images on the settings page.", defaultValue: "" },
  { key: "layout.smart_swap", group: "layout", page: "appearance", section: "panes", type: S.BOOL, title: "Smart swap", description: "When a thread's tab gains focus, panes showing another thread's diff, pull request or terminal switch to this thread's, if it is already open there. Nothing opens or closes.", defaultValue: "true" },
  { key: "layout.thread_info", group: "layout", page: "appearance", section: "panes", type: S.BOOL, title: "Thread info by default", description: "Show the thread info card beside a thread's conversation when its pane is wide enough, for every thread you have not toggled it on. The header's button and ⌘⇧I show or hide it for one thread, and that thread keeps its choice.", defaultValue: "true" },
  { key: "sidebar.needs_scope", group: "sidebar", page: "appearance", section: "panes", type: S.ENUM, title: "Needs you lists", description: "Which threads the sidebar's Needs you section lists: those of every space, or only the current space's. Its header's button switches it too.", enumValues: ["all", "space"], enumLabels: ["All spaces", "This space"], defaultValue: "all" },
  { key: "appearance.font_family", group: "appearance", page: "appearance", section: "terminal", type: S.STRING, title: "Font family", description: "Fonts to try, separated by commas; the first one installed is used. JetBrainsMono Nerd Font Mono ships with the app, and Menlo is always the last fallback.", defaultValue: "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo", placeholder: "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo" },
  { key: "appearance.font_size", group: "appearance", page: "appearance", section: "terminal", unit: "pt", type: S.INT, title: "Font size", description: "Size of terminal text, before zoom.", defaultValue: "13", min: 9n, max: 28n },
  { key: "appearance.scrollback_lines", group: "appearance", page: "appearance", section: "terminal", type: S.INT, title: "Scrollback rows", description: "Rows of history each terminal keeps. A long line takes several, more when the terminal is narrow.", defaultValue: "30000", min: 1000n, max: 100000n, restartRequired: true },
  { key: "notifications.dock_badge", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Dock badge", description: "Count the threads that need you on the Dock icon.", defaultValue: "true" },
  { key: "notifications.bounce", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Bounce the Dock icon", description: "Bounce once when a thread needs you and Code Foundry is in the background.", defaultValue: "true" },
  { key: "notifications.sound", group: "notifications", page: "notifications", section: "alerts", type: S.BOOL, title: "Alert sound", description: "Play a short sound when a thread needs you and Code Foundry is in the background.", defaultValue: "false" },
  { key: "notifications.sound_volume", group: "notifications", page: "notifications", section: "alerts", dependsOn: "notifications.sound", unit: "%", type: S.INT, title: "Alert volume", description: "Volume of the alert sound, relative to the Mac's output volume.", defaultValue: "50", min: 0n, max: 100n },
  { key: "notifications.cooldown_seconds", group: "notifications", page: "notifications", section: "alerts", unit: "s", type: S.INT, title: "Alert cooldown", description: "Shortest gap between bounces and sounds. The badge always updates. 0 alerts every time.", defaultValue: "60", min: 0n, max: 3600n },
  { key: "github.dashboards_enabled", group: "github", page: "source", section: "github", type: S.BOOL, title: "Pull request dashboards", description: "Keep the Pull Requests page up to date with the pull requests you wrote, reviewed or are asked to review. Off still checks default-branch CI and watched branches.", defaultValue: "true" },
  { key: "github.poll_interval_seconds", group: "github", page: "source", section: "github", unit: "s", type: S.INT, title: "Poll interval", description: "How often GitHub is checked for changes while the window is visible. A hidden window checks every 5 minutes and a closed app every 15, or at this interval if longer.", defaultValue: "60", min: 15n, max: 3600n },
  { key: "projects.fetch_interval_seconds", group: "projects", page: "source", section: "projects", unit: "s", type: S.INT, title: "Fetch interval", description: "How often projects with an active thread fetch from origin. Idle projects fetch every 15 minutes, or at this interval if longer. 0 turns background fetching off.", defaultValue: "120", min: 0n, max: 86400n, restartRequired: true },
  {
    key: "projects.auto_pull",
    group: "projects",
    page: "source",
    section: "projects",
    type: S.BOOL,
    title: "Pull the default branch automatically",
    description:
      "After each fetch, fast-forward checkouts that sit on the default branch and are only behind it. A checkout with staged or modified files, a rebase or merge in progress, a working thread or a running action is left alone. Needs background fetching.",
    defaultValue: "true",
  },
  {
    key: "projects.branch_naming",
    group: "projects",
    page: "source",
    section: "projects",
    type: S.ENUM,
    title: "Branch names",
    description: "How a new worktree's branch is named.",
    enumValues: ["semantic", "prefix", "custom"],
    enumLabels: ["Semantic", "Prefix", "Custom instructions"],
    enumDescriptions: ["The model picks a type like feat or fix, then a short slug.", "Your own word first, then a short slug from the model.", "You tell the model how to write the whole name."],
    enumExamples: ["feat/add-filter", "cf/add-filter", ""],
    defaultValue: "semantic",
  },
  { key: "projects.branch_prefix", group: "projects", page: "source", section: "projects", type: S.STRING, dependsOn: "projects.branch_naming", dependsOnValue: "prefix", title: "Branch prefix", description: "The part before the slash. none gives a bare slug.", defaultValue: "cf", placeholder: "cf" },
  { key: "projects.branch_instructions", group: "projects", page: "source", section: "projects", type: S.STRING, dependsOn: "projects.branch_naming", dependsOnValue: "custom", title: "Branch instructions", description: "Your custom instructions to the utility model. Spaces become dashes; a name git refuses falls back to cf/<thread id>.", defaultValue: "", placeholder: "ab/<slug of 2 to 4 words>" },
  { key: "projects.base_from_origin", group: "projects", page: "source", section: "projects", type: S.BOOL, title: "Branch from origin unless local is ahead", description: "Start a new worktree's branch from origin's copy of its base branch (the default branch when none is given), fetched first, unless the local branch is ahead of it or has diverged: then from the local branch. Off always starts from the local branch, and new branches are not fetched from origin; checking out a branch only origin has still fetches it. A remote branch, tag or commit given as the base is always used as is.", defaultValue: "true" },
  { key: "gitops.editor_command", group: "gitops", page: "source", section: "projects", type: S.STRING, title: "Editor command", description: "Command for Open in Editor, e.g. \"code\" or \"open -a Zed\". {path} stands for the worktree path; without it the path is appended. Empty picks an editor automatically.", defaultValue: "", placeholder: "auto-detect" },
  // General › Dictation (docs/notes/dictation-2-daemon.md); the rest of the section is DictationService's state.
  { key: "dictation.enabled", group: "dictation", page: "general", section: "dictation", type: S.BOOL, title: "Dictation", description: "Adds a microphone button to every composer.", defaultValue: "false" },
  { key: "dictation.anywhere", group: "dictation", page: "general", section: "dictation", type: S.BOOL, title: "Dictate anywhere", description: "The hold key works in every app and the text is pasted where you're typing. Code Foundry stays in the menu bar when you close its window. Off, the key works only while Code Foundry is in front.", defaultValue: "false" },
  {
    key: "dictation.hold_key",
    group: "dictation",
    page: "general",
    section: "dictation",
    dependsOn: "dictation.enabled",
    type: S.ENUM,
    title: "Hold key",
    description: "Hold to dictate, release to finish. Both means either Option key works.",
    enumValues: ["left", "right", "both"],
    enumLabels: ["Left ⌥", "Right ⌥", "Both ⌥"],
    defaultValue: "both",
  },
  { key: "dictation.microphone", group: "dictation", page: "general", section: "dictation", dependsOn: "dictation.enabled", type: S.STRING, title: "Microphone", description: "Follows the input chosen in System Settings.", defaultValue: "" },
  { key: "dictation.sounds", group: "dictation", page: "general", section: "dictation", dependsOn: "dictation.enabled", type: S.BOOL, title: "Sounds", description: "Plays a sound as dictation starts and stops, at the alert volume.", defaultValue: "true" },
  {
    key: "dictation.other_audio",
    group: "dictation",
    page: "general",
    section: "dictation",
    dependsOn: "dictation.enabled",
    type: S.ENUM,
    title: "Other audio",
    description: "What audio from this Mac does while you dictate.",
    enumValues: ["do_nothing", "lower"],
    enumLabels: ["Do nothing", "Lower"],
    defaultValue: "do_nothing",
  },
  { key: "dictation.avoid_bluetooth", group: "dictation", page: "general", section: "dictation", dependsOn: "dictation.enabled", type: S.BOOL, title: "Avoid Bluetooth microphones", description: "When the system default is Bluetooth, use the Mac’s microphone, so headphones stay out of low-quality call audio.", defaultValue: "true" },
  { key: "dictation.spoken_symbols", group: "dictation", page: "general", section: "dictation", dependsOn: "dictation.enabled", type: S.BOOL, title: "Spoken symbols", description: "Words like “underscore”, “hashtag” and “comma” become the symbol: “my underscore variable” is my_variable.", defaultValue: "false" },
  { key: "dictation.spoken_formatting", group: "dictation", page: "general", section: "dictation", dependsOn: "dictation.enabled", type: S.BOOL, title: "Spoken formatting", description: "“New line”, “new paragraph”, “open quote” and “close quote” become line breaks and quotation marks.", defaultValue: "true" },
  // Ember (docs/notes/ember-2-store.md).
  {
    key: "ember.enabled",
    group: "ember",
    page: "ember",
    section: "experiment",
    type: S.BOOL,
    title: "Enable Ember",
    description:
      "Experimental. A resident agent pinned above your threads: tell it what you want done and it plans the work, runs worker threads and reports back in its own chat. Its memory and task board live under ~/.code-foundry/residents/ember. Nothing else changes while it is off.",
    defaultValue: "false",
  },
  { key: "ember.model", group: "ember", page: "ember", section: "models", row: "ember-model", type: S.ENUM, title: "Model", description: "The model Ember runs on. Changes apply at once.", enumValues: MODEL_VALUES, enumLabels: MODELS.map((m) => m.label), defaultValue: "claude-opus-4-8[1m]" },
  { key: "ember.effort", group: "ember", page: "ember", section: "models", row: "ember-model", type: S.ENUM, title: "Effort", description: "Ember's effort level.", enumValues: EMBER_EFFORTS, enumLabels: EFFORT_LABELS.slice(0, 3), defaultValue: "high" },
  { key: "ember.worker_models", group: "ember", page: "ember", section: "models", type: S.STRING, title: "Worker threads", description: "Models for Ember's worker threads. With several, new workers take turns.", defaultValue: EMBER_WORKERS_DEFAULT, placeholder: EMBER_WORKERS_DEFAULT },
  { key: "ember.worker_effort", group: "ember", page: "ember", section: "models", type: S.ENUM, title: "Worker effort", description: "Effort for Ember's worker threads.", enumValues: EFFORTS, enumLabels: EFFORT_LABELS, defaultValue: "high" },
  { key: "ember.epoch_context_tokens", group: "ember", page: "ember", section: "epochs", unit: "tokens", type: S.INT, title: "Context limit", description: "Start a fresh session once Ember's context passes this many tokens.", defaultValue: "400000", min: 20000n, max: 1000000n },
  { key: "ember.epoch_max_hours", group: "ember", page: "ember", section: "epochs", unit: "h", type: S.INT, title: "Session age limit", description: "Start a fresh session once the current one is this many hours old.", defaultValue: "24", min: 1n, max: 720n },
  { key: "advanced.claude_path", group: "advanced", page: "advanced", section: "executables", type: S.PATH, title: "claude executable", description: "Path to claude. Empty finds it on PATH.", defaultValue: "", placeholder: "claude (from PATH)", restartRequired: true },
  { key: "advanced.gh_path", group: "advanced", page: "advanced", section: "executables", type: S.PATH, title: "gh executable", description: "Path to gh. Empty finds it on PATH or where Homebrew installs it.", defaultValue: "", placeholder: "gh (from PATH)", restartRequired: true },
  { key: "plugins.registries", group: "plugins", page: "plugins", section: "registries", type: S.STRING, title: "Plugin registries", description: 'Where Browse and plugin install look for plugins, in order; the first registry listing a name wins. Each is a GitHub repository URL (private ones work through your gh login) or an https URL of an index.json, separated by commas. Empty means no registry: Browse lists nothing and install needs a release or a folder.', defaultValue: "", placeholder: "https://github.com/<owner>/<repo>" },
  { key: "advanced.log_level", group: "advanced", page: "advanced", section: "logging", type: S.ENUM, title: "Log level", description: "Lowest level written to logs/daemon.log.", enumValues: ["debug", "info", "warn", "error"], enumLabels: ["Debug", "Info", "Warn", "Error"], defaultValue: "info" },
];

const reserved = new Set([
  "cmd+k", "cmd+shift+p", "cmd+b", "cmd+shift+a", "cmd+1", "cmd+2", "cmd+3", "cmd+4", "cmd+5", "cmd+6", "cmd+7", "cmd+8", "cmd+9",
  "cmd+ctrl+1", "cmd+ctrl+2", "cmd+ctrl+3", "cmd+ctrl+4", "cmd+ctrl+5", "cmd+ctrl+6", "cmd+ctrl+7", "cmd+ctrl+8", "cmd+ctrl+9",
  "cmd+=", "cmd+-", "cmd+0", "cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z", "cmd+shift+c", "cmd+q",
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

/**
 * The "file" the mock starts from: the fixture registry configured explicitly
 * (plugins.registries is empty by default), so Browse has something to list.
 */
function initialRaw(): Record<string, string> {
  return { "plugins.registries": FIXTURE_REGISTRY };
}

export class MockSettings {
  /** Values as written in the "file", by key. */
  raw: Record<string, string> = initialRaw();
  revision = 1;
  loadError = "";
  /** The user's themes of a scheme (world.ts wires mock/userThemes.ts): the theme slots list them first. */
  userThemes?: (scheme: "dark" | "light") => { id: string; name: string }[];
  /** Whether the backdrops folder has an image (world.ts wires mock/backdrops.ts); unset: only "" is missing. */
  backdropExists?: (name: string) => boolean;
  private readonly startup: Record<string, string>;

  constructor(
    private readonly commands: () => MockCommandInfo[],
    private readonly publish: (snap: SettingsSnapshotInit) => void,
  ) {
    this.startup = Object.fromEntries(staticFields.map((f) => [f.key, f.defaultValue]));
  }

  reset(): void {
    this.raw = initialRaw();
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
    return [...staticFields.map((f) => this.withUserThemes(f)), ...kb];
  }

  /** A theme slot's field with the user's themes first, as the daemon's withThemes. */
  private withUserThemes(f: FieldInit): FieldInit {
    const scheme = f.key === "appearance.theme_dark" ? "dark" : f.key === "appearance.theme_light" ? "light" : null;
    const user = scheme && this.userThemes ? this.userThemes(scheme) : [];
    if (user.length === 0) return f;
    return { ...f, enumValues: [...user.map((t) => t.id), ...(f.enumValues ?? [])], enumLabels: [...user.map((t) => t.name), ...(f.enumLabels ?? [])] };
  }

  /** staticPages with one keybindings section per category that has a bindable command. */
  pages(): PageInit[] {
    const cats = [...new Set(this.bindable().map((c) => c.category))];
    return staticPages.map((p) => (p.id === "keybindings" ? { ...p, sections: cats.map((c) => ({ id: categorySection(c), title: c })) } : p));
  }

  /** One static field's effective value, without the keybinding fields (which need the commands). */
  value(key: string): string {
    return this.raw[key] ?? staticFields.find((f) => f.key === key)?.defaultValue ?? "";
  }

  /** Effective values (defaults included). */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.fields()) {
      const v = this.raw[f.key] ?? f.defaultValue;
      // A theme slot naming a theme that is gone shows the default, as the daemon does.
      out[f.key] = f.key.startsWith("appearance.theme_") && !(f.enumValues ?? []).includes(v) ? f.defaultValue : v;
    }
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
        checks[k]?.(next[k]);
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
    // Like the daemon's cross check (internal/store/settings, checkBackdropChoice).
    const choiceKey = ["appearance.backdrop", "appearance.backdrop_file"].find((k) => k in partial);
    const file = next["appearance.backdrop_file"] ?? "";
    if (choiceKey && next["appearance.backdrop"] === "custom") {
      if (file === "") issues.push({ key: choiceKey, message: "custom needs an image: add one under Settings › Appearance › Backdrop first" });
      else if (this.backdropExists && !this.backdropExists(file)) issues.push({ key: choiceKey, message: `custom needs an image, and "${file}" is not in the backdrops folder` });
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
