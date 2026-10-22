package settings

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/model"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Type is a field's value type. Values travel as strings; the type drives parsing, the
// TOML encoding, and the GUI's input widget.
type Type int

const (
	// String is free text.
	String Type = iota + 1
	// Int is a base-10 integer within [Min, Max].
	Int
	// Bool is "true" or "false".
	Bool
	// Enum is one of Field.Enum. "" in Enum means "no preference".
	Enum
	// Path is a filesystem path, absolute after ~ expansion, or "".
	Path
	// Keybinding is a chord ("cmd+shift+n"), "none" to unbind, or "" for the default.
	Keybinding
)

// Group is a table in the file. Where the settings page shows a field is its Page and
// Section, which need not follow the group.
type Group struct {
	ID          string
	Title       string
	Description string
}

// Page is one page (tab) of the settings page. Display only: pages and sections can
// change without touching the file.
type Page struct {
	ID          string
	Title       string
	Description string
	// Sections in display order.
	Sections []Section
}

// Section is a titled card of fields on a page. Title is empty for a page's single
// unnamed section.
type Section struct {
	ID          string
	Title       string
	Description string
}

// Field describes one setting. Key is "<group>.<name>"; in the file it is <name> under
// [<group>].
type Field struct {
	Key         string
	Title       string
	Description string
	Group       string
	// Page and Section say where the settings page shows the field (Page.ID,
	// Section.ID).
	Page, Section string
	Type          Type
	Enum          []string
	// EnumLabels, when set, names each Enum value for display (parallel to Enum).
	EnumLabels []string
	// Default is the string-encoded value used when the file does not set the key.
	Default string
	// Restart means the daemon reads the value only at start.
	Restart bool
	// Min and Max bound Int fields (inclusive).
	Min, Max    int
	Placeholder string
	// Unit is the suffix shown inside a number input ("s", "pt", "%").
	Unit string
	// DependsOn is the key of a Bool field; while it is false the settings page shows
	// this field indented and dimmed.
	DependsOn string
	// Row groups fields of one section into a single row (model and effort); the
	// first field's description goes under the row.
	Row string

	// bind returns a pointer into s (*string, *int, or *bool) for static fields.
	bind func(s *Settings) any
	// check is extra validation run after parsing (e.g. an executable exists).
	check func(v string) error
	// unlisted, when set, explains an Enum value outside Enum in place of the generic
	// "want one of" (a theme of the other scheme).
	unlisted func(v string) error
}

// Name is the key within its group's table.
func (f Field) Name() string { return strings.TrimPrefix(f.Key, f.Group+".") }

// KeybindingNone unbinds a command.
const KeybindingNone = "none"

// Group ids.
const (
	GroupThreads     = "threads"
	GroupGitHub      = "github"
	GroupProjects    = "projects"
	GroupGitOps      = "gitops"
	GroupAppearance  = "appearance"
	GroupNotify      = "notifications"
	GroupKeybindings = "keybindings"
	GroupUpdate      = "update"
	GroupPlugins     = "plugins"
	GroupEmber       = "ember"
	GroupAdvanced    = "advanced"
)

// Page ids.
const (
	PageGeneral       = "general"
	PageAppearance    = "appearance"
	PageNotifications = "notifications"
	PageSource        = "source"
	PageKeybindings   = "keybindings"
	PageEmber         = "ember"
	PageAdvanced      = "advanced"
	// PagePlugins is drawn by the GUI (Settings → Plugins: installed plugins and Browse)
	// around its one section of fields.
	PagePlugins = "plugins"
)

// Pages in display order. The keybindings page's sections are the command categories
// (see Store.Pages); here it has none.
var Pages = []Page{
	{ID: PageGeneral, Title: "General", Sections: []Section{
		{ID: "threads", Title: "Threads"},
		{ID: "textgen", Title: "Text generation", Description: "Models for small jobs like naming a thread."},
		{ID: "lifecycle", Title: "Lifecycle"},
		{ID: "updates", Title: "Updates"},
	}},
	{ID: PageAppearance, Title: "Appearance", Description: "Applied live in every window.", Sections: []Section{
		{ID: "theme", Title: "Theme"},
		{ID: "window", Title: "Window"},
		{ID: "terminal", Title: "Terminal"},
	}},
	{ID: PageNotifications, Title: "Notifications",
		Description: "How the Dock tells you a thread needs you. macOS banners aren't available to this app.",
		Sections:    []Section{{ID: "alerts"}}},
	{ID: PageSource, Title: "Source control", Sections: []Section{
		{ID: "github", Title: "GitHub", Description: "Pull requests and checks, read with your gh login."},
		{ID: "projects", Title: "Projects", Description: "Fetching, branches and worktrees."},
	}},
	{ID: PageEmber, Title: "Ember", Description: "A resident agent that plans work, runs worker threads and reports back in its own chat.", Sections: []Section{
		{ID: "experiment", Title: "Experiment"},
		{ID: "models", Title: "Models"},
		{ID: "epochs", Title: "Epochs", Description: "When Ember starts a fresh session, seeded with its memory, task board and recent messages. Checked after each turn."},
	}},
	{ID: PageKeybindings, Title: "Keybindings",
		Description: `Change or remove a command's shortcut. App shortcuts like cmd+k, cmd+b and cmd+1..9 are reserved.`},
	{ID: PageAdvanced, Title: "Advanced", Sections: []Section{
		{ID: "executables", Title: "Executables"},
		{ID: "logging", Title: "Logging"},
	}},
	{ID: PagePlugins, Title: "Plugins", Description: "Programs that add commands, panels and thread options to Code Foundry.",
		Sections: []Section{{ID: "registries", Title: "Registries", Description: "Where Browse finds plugins to install."}}},
}

// Groups are the file's tables, in file order. The settings page follows Pages.
var Groups = []Group{
	{GroupThreads, "Threads", "Defaults for new threads."},
	{GroupGitHub, "GitHub", "Pull requests and checks, read with your gh login."},
	{GroupProjects, "Projects", "Background fetching, fast-forwarding checkouts on the default branch, and new worktrees' branches: how they are named and whether they start from origin."},
	{GroupGitOps, "Git operations", "How worktrees are handed to other apps."},
	{GroupAppearance, "Appearance", "Scheme, themes, terminal font, density, backdrop, and the side panel. Applied live in every window."},
	{GroupNotify, "Notifications", "How the Dock tells you a thread needs you. macOS banners aren't available to this app."},
	{GroupKeybindings, "Keybindings", `Override a command's chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.`},
	{GroupUpdate, "Updates", "Which releases the app checks for and offers to install."},
	{GroupPlugins, "Plugins", "Where plugins are installed from."},
	{GroupEmber, "Ember", "The resident agent: whether it runs, its models, and when it starts a fresh session."},
	{GroupAdvanced, "Advanced", "Executables and logging."},
}

// Keys of the static fields that have consumers in the daemon or GUI.
const (
	KeyDefaultModel         = "threads.default_model"
	KeyDefaultEffort        = "threads.default_effort"
	KeyDefaultWorktree      = "threads.default_worktree"
	KeyAutoName             = "threads.auto_name"
	KeyNamingModel          = "threads.naming_model"
	KeyCacheTTL             = "threads.cache_ttl_seconds"
	KeyShowCreatedThreads   = "threads.show_created_threads"
	KeyCloseGrace           = "threads.close_grace_seconds"
	KeyScrollback           = "threads.scrollback_lines"
	KeyGhPollInterval       = "github.poll_interval_seconds"
	KeyDashboards           = "github.dashboards_enabled"
	KeyFetchInterval        = "projects.fetch_interval_seconds"
	KeyAutoPull             = "projects.auto_pull"
	KeyBranchNaming         = "projects.branch_naming"
	KeyBranchPrefix         = "projects.branch_prefix"
	KeyBranchInstructions   = "projects.branch_instructions"
	KeyBaseFromOrigin       = "projects.base_from_origin"
	KeyEditorCommand        = "gitops.editor_command"
	KeyTheme                = "appearance.theme"
	KeyThemeDark            = "appearance.theme_dark"
	KeyThemeLight           = "appearance.theme_light"
	KeyFontFamily           = "appearance.font_family"
	KeyFontSize             = "appearance.font_size"
	KeyZoom                 = "appearance.zoom"
	KeyDensity              = "appearance.density"
	KeyThreadWidth          = "appearance.thread_width"
	KeyBackdrop             = "appearance.backdrop"
	KeyBackdropFile         = "appearance.backdrop_file"
	KeyPanelKeepOpen        = "appearance.panel_keep_open"
	KeyDockBadge            = "notifications.dock_badge"
	KeyBounce               = "notifications.bounce"
	KeySound                = "notifications.sound"
	KeySoundVolume          = "notifications.sound_volume"
	KeyAlertCooldown        = "notifications.cooldown_seconds"
	KeyUpdateChannel        = "update.channel"
	KeyClaudePath           = "advanced.claude_path"
	KeyGhPath               = "advanced.gh_path"
	KeyLogLevel             = "advanced.log_level"
	KeyPluginRegistries     = "plugins.registries"
	KeyEmberEnabled         = "ember.enabled"
	KeyEmberModel           = "ember.model"
	KeyEmberEffort          = "ember.effort"
	KeyEmberWorkerModels    = "ember.worker_models"
	KeyEmberWorkerEffort    = "ember.worker_effort"
	KeyEmberEpochTokens     = "ember.epoch_context_tokens"
	KeyEmberEpochHours      = "ember.epoch_max_hours"
	keybindingKeyPrefix     = GroupKeybindings + "."
	defaultFontFamily       = "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo"
	defaultScrollback       = 10000
	defaultCloseGrace       = 10
	defaultCacheTTL         = 3600
	defaultGhPollSeconds    = 60
	defaultFetchSeconds     = 120
	defaultSoundVolume      = 50
	defaultAlertCooldown    = 60
	defaultEmberEpochTokens = 400000
	defaultEmberEpochHours  = 24
)

// emberEfforts are ember.effort's levels.
var emberEfforts = []string{"low", "medium", "high"}

// checkModelList validates a comma-separated list of model registry values (at least
// one, each listed once).
func checkModelList(v string) error {
	ids := SplitList(v)
	if len(ids) == 0 {
		return errors.New("want at least one model id")
	}
	for i, id := range ids {
		if !model.Known(id) {
			return fmt.Errorf("unknown model %q; want ids from %s", id, enumList(model.Values()))
		}
		if slices.Contains(ids[:i], id) {
			return fmt.Errorf("model %q is listed twice", id)
		}
	}
	return nil
}

// SplitList splits a comma-separated setting, trimming each entry and dropping blanks.
func SplitList(v string) []string {
	var out []string
	for p := range strings.SplitSeq(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// appearance.backdrop values: the bundled forest art, nothing, or the image named by
// appearance.backdrop_file.
const (
	BackdropForest = "forest"
	BackdropNone   = "none"
	BackdropCustom = "custom"
)

// threads.default_worktree values: a new worktree, or the project's main checkout.
const (
	WorktreeNew     = "new"
	WorktreeCurrent = "current"
)

// projects.branch_naming values (thread.BranchMode*).
const (
	BranchNamingPrefix   = "prefix"
	BranchNamingSemantic = "semantic"
	BranchNamingCustom   = "custom"
)

// BranchPrefixNone is the projects.branch_prefix value for no prefix: an empty value
// resets a setting to its default, so "no prefix" needs a word.
const BranchPrefixNone = "none"

// branchPrefixJunk matches what a branch prefix may not contain: anything but ASCII
// letters, digits, '-', '_', '.' and '/'.
var branchPrefixJunk = regexp.MustCompile(`[^A-Za-z0-9._/-]`)

// checkBranchPrefix validates projects.branch_prefix: BranchPrefixNone, or one or more
// components of letters, digits, '-', '_' and '.' (a slash between components).
func checkBranchPrefix(v string) error {
	p := strings.Trim(v, "/")
	switch {
	case v == BranchPrefixNone:
		return nil
	case p == "" || branchPrefixJunk.MatchString(p) || strings.HasPrefix(p, "-") || strings.HasPrefix(p, ".") ||
		strings.Contains(p, "..") || strings.Contains(p, "//") || strings.HasSuffix(p, ".lock") || strings.HasSuffix(p, "."):
		return fmt.Errorf("want letters, digits, -, _, . and / (or %s for no prefix), got %q", BranchPrefixNone, v)
	}
	return nil
}

// KeybindingKey is the settings key of a command's keybinding override.
func KeybindingKey(command string) string { return keybindingKeyPrefix + command }

// staticFields are every field except the per-command keybindings, in display order:
// by page and section as in Pages, then in order within a section.
var staticFields = []Field{
	// General › Threads.
	{
		Key: KeyDefaultModel, Group: GroupThreads, Page: PageGeneral, Section: "threads", Row: "model", Type: Enum, Title: "Model",
		Description: "The default for new threads. Every model runs with the 1M context window.",
		Enum:        command.ThreadModels, EnumLabels: model.Labels(), Default: model.Default,
		bind: func(s *Settings) any { return &s.Threads.DefaultModel },
	},
	{
		Key: KeyDefaultEffort, Group: GroupThreads, Page: PageGeneral, Section: "threads", Row: "model", Type: Enum, Title: "Effort",
		Description: "The default effort for new threads.",
		Enum:        command.ThreadEfforts, EnumLabels: effortLabels(command.ThreadEfforts), Default: "medium",
		bind: func(s *Settings) any { return &s.Threads.DefaultEffort },
	},
	{
		// Read by the GUI only: the composer's "Work in" picker starts from it (a choice
		// remembered per project wins). thread.new itself stays explicit (--new-worktree
		// or --worktree).
		Key: KeyDefaultWorktree, Group: GroupThreads, Page: PageGeneral, Section: "threads", Type: Enum, Title: "New threads work in",
		Description: "A fresh copy gives each thread its own folder and branch, so several can run at once. The project folder itself edits your files in place.",
		Enum:        []string{WorktreeNew, WorktreeCurrent},
		EnumLabels:  []string{"A fresh copy of the project", "The project folder itself"},
		Default:     WorktreeCurrent,
		bind:        func(s *Settings) any { return &s.Threads.DefaultWorktree },
	},
	{
		// Read by the thread store (the archive cascade; docs/notes/hidden-children-1-daemon.md)
		// and the GUI (the sidebar, the Dock badge).
		Key: KeyShowCreatedThreads, Group: GroupThreads, Page: PageGeneral, Section: "threads", Type: Bool,
		Title: "Show threads created by other threads",
		Description: "When off, threads an agent creates stay out of the sidebar and the Dock badge and are archived with their creator. " +
			"They still appear in the creator's Threads tab.",
		Default: "false",
		bind:    func(s *Settings) any { return &s.Threads.ShowCreatedThreads },
	},
	{
		Key: KeyAutoName, Group: GroupThreads, Page: PageGeneral, Section: "threads", Type: Bool, Title: "Name threads automatically",
		Description: "Give each new thread a name based on its first message.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Threads.AutoName },
	},
	// General › Text generation.
	{
		Key: KeyNamingModel, Group: GroupThreads, Page: PageGeneral, Section: "textgen", DependsOn: KeyAutoName, Type: Enum, Title: "Naming model",
		Description: "Writes thread names. Always runs at low effort.",
		Enum:        command.ThreadModels, EnumLabels: model.Labels(), Default: model.NamingDefault,
		bind: func(s *Settings) any { return &s.Threads.NamingModel },
	},
	// General › Lifecycle.
	{
		Key: KeyCacheTTL, Group: GroupThreads, Page: PageGeneral, Section: "lifecycle", Unit: "s", Type: Int, Title: "Prompt cache lifetime",
		Description: "How long the Claude API keeps a conversation's prompt cache (1 hour on Bedrock and the Anthropic API). Code Foundry uses this to tell when a thread's cache has expired. It doesn't change the API.",
		Default:     strconv.Itoa(defaultCacheTTL), Min: 60, Max: 86400,
		bind: func(s *Settings) any { return &s.Threads.CacheTTLSeconds },
	},
	{
		Key: KeyCloseGrace, Group: GroupThreads, Page: PageGeneral, Section: "lifecycle", Unit: "s", Type: Int, Title: "Close grace",
		Description: "How long a closing thread waits for Claude to exit before it is force-quit.",
		Default:     strconv.Itoa(defaultCloseGrace), Min: 1, Max: 120, Restart: true,
		bind: func(s *Settings) any { return &s.Threads.CloseGraceSeconds },
	},
	// General › Updates.
	{
		Key: KeyUpdateChannel, Group: GroupUpdate, Page: PageGeneral, Section: "updates", Type: Enum, Title: "Channel",
		Description: "Stable gets releases chosen by hand. Tip gets every build of main. Switching never installs an older version.",
		Enum:        []string{ChannelStable, ChannelTip}, EnumLabels: []string{"Stable", "Tip"}, Default: ChannelStable,
		bind: func(s *Settings) any { return &s.Update.Channel },
	},
	// Appearance › Theme.
	{
		// The key predates the theme slots: it is the scheme, and the slots below say which
		// theme each scheme uses.
		Key: KeyTheme, Group: GroupAppearance, Page: PageAppearance, Section: "theme", Type: Enum, Title: "Scheme",
		Description: "Dark or light. System follows the macOS appearance.",
		Enum:        []string{"system", "dark", "light"}, EnumLabels: []string{"System", "Dark", "Light"}, Default: "system",
		bind: func(s *Settings) any { return &s.Appearance.Theme },
	},
	themeField(KeyThemeDark, theme.SchemeDark, "Dark theme", "Colours used when the scheme is dark.",
		func(s *Settings) any { return &s.Appearance.ThemeDark }),
	themeField(KeyThemeLight, theme.SchemeLight, "Light theme", "Colours used when the scheme is light.",
		func(s *Settings) any { return &s.Appearance.ThemeLight }),
	// Appearance › Window.
	{
		Key: KeyZoom, Group: GroupAppearance, Page: PageAppearance, Section: "window", Unit: "%", Type: Int, Title: "Zoom",
		Description: "Scale of the whole window. ⌘=, ⌘- and ⌘0 change it too.",
		Default:     "100", Min: 90, Max: 200,
		bind: func(s *Settings) any { return &s.Appearance.Zoom },
	},
	{
		Key: KeyDensity, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Density",
		Description: "Spacing in the sidebar and lists.",
		Enum:        []string{"compact", "comfortable"}, EnumLabels: []string{"Compact", "Comfortable"}, Default: "comfortable",
		bind: func(s *Settings) any { return &s.Appearance.Density },
	},
	{
		Key: KeyThreadWidth, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Thread width",
		Description: "Width of the conversation column.",
		Enum:        []string{"compact", "comfortable", "full"}, EnumLabels: []string{"Compact", "Comfortable", "Full"}, Default: "comfortable",
		bind: func(s *Settings) any { return &s.Appearance.ThreadWidth },
	},
	{
		Key: KeyBackdrop, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Backdrop",
		Description: "Faint artwork behind the start page and the new-thread composer.",
		Enum:        []string{BackdropForest, BackdropNone, BackdropCustom}, EnumLabels: []string{"Forest", "None", "Custom"}, Default: BackdropForest,
		bind: func(s *Settings) any { return &s.Appearance.Backdrop },
	},
	{
		// Owned by the backdrop row's editor in the GUI (its gallery), which leaves this
		// row out; the backdrop store sets it on import and clears it on removal.
		Key: KeyBackdropFile, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: String, Title: "Backdrop image",
		Description: "The file the Custom backdrop shows, from the backdrops folder of the Code Foundry home. Add and remove images on the settings page.",
		check:       checkBackdropFile,
		bind:        func(s *Settings) any { return &s.Appearance.BackdropFile },
	},
	{
		Key: KeyPanelKeepOpen, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Bool, Title: "Keep side panel open",
		Description: "Keep the side panel open on its new tab page after its last tab closes.",
		Default:     "false",
		bind:        func(s *Settings) any { return &s.Appearance.PanelKeepOpen },
	},
	// Appearance › Terminal.
	{
		// The GUI bundles JetBrainsMono Nerd Font Mono (gui/frontend/public/fonts). Its own
		// stack, used when this is empty, is DEFAULT_TERMINAL_FONT_FAMILY in src/terminal/fonts.ts.
		Key: KeyFontFamily, Group: GroupAppearance, Page: PageAppearance, Section: "terminal", Type: String, Title: "Font family",
		Description: "Fonts to try, separated by commas; the first one installed is used. JetBrainsMono Nerd Font Mono ships with the app, and Menlo is always the last fallback.",
		Default:     defaultFontFamily, Placeholder: defaultFontFamily,
		bind: func(s *Settings) any { return &s.Appearance.FontFamily },
	},
	{
		Key: KeyFontSize, Group: GroupAppearance, Page: PageAppearance, Section: "terminal", Unit: "pt", Type: Int, Title: "Font size",
		Description: "Size of terminal text, before zoom.",
		Default:     "13", Min: 9, Max: 28,
		bind: func(s *Settings) any { return &s.Appearance.FontSize },
	},
	{
		Key: KeyScrollback, Group: GroupThreads, Page: PageAppearance, Section: "terminal", Type: Int, Title: "Scrollback lines",
		Description: "Lines of history each terminal keeps.",
		Default:     strconv.Itoa(defaultScrollback), Min: 1000, Max: 100000, Restart: true,
		bind: func(s *Settings) any { return &s.Threads.ScrollbackLines },
	},
	// Notifications.
	{
		Key: KeyDockBadge, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Dock badge",
		Description: "Count the threads that need you on the Dock icon.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Notifications.DockBadge },
	},
	{
		Key: KeyBounce, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Bounce the Dock icon",
		Description: "Bounce once when a thread needs you and Code Foundry is in the background.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Notifications.Bounce },
	},
	{
		Key: KeySound, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Alert sound",
		Description: "Play a short sound when a thread needs you and Code Foundry is in the background.",
		Default:     "false",
		bind:        func(s *Settings) any { return &s.Notifications.Sound },
	},
	{
		Key: KeySoundVolume, Group: GroupNotify, Page: PageNotifications, Section: "alerts", DependsOn: KeySound, Unit: "%", Type: Int, Title: "Alert volume",
		Description: "Volume of the alert sound, relative to the Mac's output volume.",
		Default:     strconv.Itoa(defaultSoundVolume), Min: 0, Max: 100,
		bind: func(s *Settings) any { return &s.Notifications.SoundVolume },
	},
	{
		Key: KeyAlertCooldown, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Unit: "s", Type: Int, Title: "Alert cooldown",
		Description: "Shortest gap between bounces and sounds. The badge always updates. 0 alerts every time.",
		Default:     strconv.Itoa(defaultAlertCooldown), Min: 0, Max: 3600,
		bind: func(s *Settings) any { return &s.Notifications.CooldownSeconds },
	},
	// Source control › GitHub.
	{
		Key: KeyDashboards, Group: GroupGitHub, Page: PageSource, Section: "github", Type: Bool, Title: "Pull request dashboards",
		Description: "Keep the Pull Requests page up to date with the pull requests you wrote, reviewed or are asked to review. Off still checks default-branch CI and watched branches.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.GitHub.DashboardsEnabled },
	},
	{
		Key: KeyGhPollInterval, Group: GroupGitHub, Page: PageSource, Section: "github", Unit: "s", Type: Int, Title: "Poll interval",
		Description: "How often GitHub is checked for changes while the window is visible. A hidden window checks every 5 minutes and a closed app every 15, or at this interval if longer.",
		Default:     strconv.Itoa(defaultGhPollSeconds), Min: 15, Max: 3600,
		bind: func(s *Settings) any { return &s.GitHub.PollIntervalSeconds },
	},
	// Source control › Projects.
	{
		Key: KeyFetchInterval, Group: GroupProjects, Page: PageSource, Section: "projects", Unit: "s", Type: Int, Title: "Fetch interval",
		Description: "How often projects with an active thread fetch from origin. Idle projects fetch every 15 minutes, or at this interval if longer. 0 turns background fetching off.",
		Default:     strconv.Itoa(defaultFetchSeconds), Min: 0, Max: 86400, Restart: true,
		bind: func(s *Settings) any { return &s.Projects.FetchIntervalSeconds },
	},
	{
		Key: KeyAutoPull, Group: GroupProjects, Page: PageSource, Section: "projects", Type: Bool, Title: "Pull the default branch automatically",
		Description: "After each fetch, fast-forward checkouts that sit on the default branch and are only behind it. " +
			"A checkout with staged or modified files, a rebase or merge in progress, a working thread or a running action is left alone. Needs background fetching.",
		Default: "true",
		bind:    func(s *Settings) any { return &s.Projects.AutoPull },
	},
	{
		// Read by the thread store at every new worktree or workspace
		// (internal/store/thread/branchname.go), live.
		Key: KeyBranchNaming, Group: GroupProjects, Page: PageSource, Section: "projects", Type: Enum, Title: "Branch names",
		Description: "How a new worktree's branch is named. Type and slug: the naming model picks a type like feat or fix and a short slug. " +
			"Prefix and slug: your branch prefix and a slug. Custom: the naming model follows your instructions. " +
			"With automatic naming off, prefix mode uses the thread's name and the others use cf/<thread id>.",
		Enum:       []string{BranchNamingSemantic, BranchNamingPrefix, BranchNamingCustom},
		EnumLabels: []string{"Type and slug (feat/add-filter)", "Prefix and slug (cf/add-filter)", "Custom instructions"},
		Default:    BranchNamingSemantic,
		bind:       func(s *Settings) any { return &s.Projects.BranchNaming },
	},
	{
		Key: KeyBranchPrefix, Group: GroupProjects, Page: PageSource, Section: "projects", Type: String, Title: "Branch prefix",
		Description: "For Prefix and slug: the part before the slash. " + BranchPrefixNone + " gives a bare slug.",
		Default:     "cf", Placeholder: "cf", check: checkBranchPrefix,
		bind: func(s *Settings) any { return &s.Projects.BranchPrefix },
	},
	{
		Key: KeyBranchInstructions, Group: GroupProjects, Page: PageSource, Section: "projects", Type: String, Title: "Branch instructions",
		Description: "For Custom: how the naming model should write the whole branch name, e.g. \"ab/<slug of 2 to 4 words>\". " +
			"Spaces become dashes; a name git refuses falls back to cf/<thread id>.",
		Placeholder: "ab/<slug of 2 to 4 words>",
		bind:        func(s *Settings) any { return &s.Projects.BranchInstructions },
	},
	{
		// Read at every new worktree (project.CreateWorktreeOptions.BaseFromOrigin), live.
		Key: KeyBaseFromOrigin, Group: GroupProjects, Page: PageSource, Section: "projects", Type: Bool, Title: "Branch from origin",
		Description: "Fetch first and start a new worktree's branch from origin's copy of its base branch (the default branch when none is given). " +
			"Off starts from the local branch without fetching. A remote branch, tag or commit given as the base is always used as is.",
		Default: "true",
		bind:    func(s *Settings) any { return &s.Projects.BaseFromOrigin },
	},
	{
		Key: KeyEditorCommand, Group: GroupGitOps, Page: PageSource, Section: "projects", Type: String, Title: "Editor command",
		Description: "Command for Open in Editor, e.g. \"code\" or \"open -a Zed\". {path} stands for the worktree path; without it the path is appended. Empty picks an editor automatically.",
		Placeholder: "auto-detect",
		bind:        func(s *Settings) any { return &s.GitOps.EditorCommand },
	},
	// Ember (docs/notes/ember-2-store.md): read by the Ember store (internal/store/ember),
	// live.
	{
		Key: KeyEmberEnabled, Group: GroupEmber, Page: PageEmber, Section: "experiment", Type: Bool, Title: "Enable Ember",
		Description: "Experimental. A resident agent pinned above your threads: tell it what you want done and it plans the work, runs worker threads and reports back in its own chat. " +
			"Its memory and task board live under ~/.code-foundry/residents/ember. Nothing else changes while it is off.",
		Default: "false",
		bind:    func(s *Settings) any { return &s.Ember.Enabled },
	},
	{
		Key: KeyEmberModel, Group: GroupEmber, Page: PageEmber, Section: "models", Row: "ember-model", Type: Enum, Title: "Model",
		Description: "The model Ember runs on. Changes apply at once.",
		Enum:        command.ThreadModels, EnumLabels: model.Labels(), Default: model.EmberDefault,
		bind: func(s *Settings) any { return &s.Ember.Model },
	},
	{
		Key: KeyEmberEffort, Group: GroupEmber, Page: PageEmber, Section: "models", Row: "ember-model", Type: Enum, Title: "Effort",
		Description: "Ember's effort level.",
		Enum:        emberEfforts, EnumLabels: effortLabels(emberEfforts), Default: "high",
		bind: func(s *Settings) any { return &s.Ember.Effort },
	},
	{
		Key: KeyEmberWorkerModels, Group: GroupEmber, Page: PageEmber, Section: "models", Type: String, Title: "Worker threads",
		Description: "Models for Ember's worker threads. With several, new workers take turns.",
		Default:     model.EmberWorkersDefault, Placeholder: model.EmberWorkersDefault,
		check: checkModelList,
		bind:  func(s *Settings) any { return &s.Ember.WorkerModels },
	},
	{
		Key: KeyEmberWorkerEffort, Group: GroupEmber, Page: PageEmber, Section: "models", Type: Enum, Title: "Worker effort",
		Description: "Effort for Ember's worker threads.",
		Enum:        command.ThreadEfforts, EnumLabels: effortLabels(command.ThreadEfforts), Default: "high",
		bind: func(s *Settings) any { return &s.Ember.WorkerEffort },
	},
	{
		Key: KeyEmberEpochTokens, Group: GroupEmber, Page: PageEmber, Section: "epochs", Unit: "tokens", Type: Int, Title: "Context limit",
		Description: "Start a fresh session once Ember's context passes this many tokens. A fresh session starts near 25K.",
		Default:     strconv.Itoa(defaultEmberEpochTokens), Min: 50000, Max: 1000000,
		bind: func(s *Settings) any { return &s.Ember.EpochContextTokens },
	},
	{
		Key: KeyEmberEpochHours, Group: GroupEmber, Page: PageEmber, Section: "epochs", Unit: "h", Type: Int, Title: "Session age limit",
		Description: "Start a fresh session once the current one is this many hours old.",
		Default:     strconv.Itoa(defaultEmberEpochHours), Min: 1, Max: 720,
		bind: func(s *Settings) any { return &s.Ember.EpochMaxHours },
	},
	// Advanced.
	{
		Key: KeyClaudePath, Group: GroupAdvanced, Page: PageAdvanced, Section: "executables", Type: Path, Title: "claude executable",
		Description: "Path to claude. Empty finds it on PATH.",
		Placeholder: "claude (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.ClaudePath },
	},
	{
		Key: KeyGhPath, Group: GroupAdvanced, Page: PageAdvanced, Section: "executables", Type: Path, Title: "gh executable",
		Description: "Path to gh. Empty finds it on PATH or where Homebrew installs it.",
		Placeholder: "gh (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.GhPath },
	},
	{
		Key: KeyLogLevel, Group: GroupAdvanced, Page: PageAdvanced, Section: "logging", Type: Enum, Title: "Log level",
		Description: "Lowest level written to logs/daemon.log.",
		Enum:        []string{"debug", "info", "warn", "error"}, EnumLabels: []string{"Debug", "Info", "Warn", "Error"}, Default: "info",
		bind: func(s *Settings) any { return &s.Advanced.LogLevel },
	},
	// Plugins › Registries.
	{
		Key: KeyPluginRegistries, Group: GroupPlugins, Page: PagePlugins, Section: "registries", Type: String, Title: "Plugin registries",
		Description: "Where Browse and plugin install look for plugins, in order; the first registry listing a name wins. Each is a GitHub repository URL (private ones work through your gh login) or an https URL of an index.json, separated by commas. Empty means no registry: Browse lists nothing and install needs a release or a folder.",
		Default:     "", Placeholder: "https://github.com/<owner>/<repo>",
		check: checkRegistries,
		bind:  func(s *Settings) any { return &s.Plugins.Registries },
	},
}

// effortLabels names effort levels for display ("xhigh" is "Extra high", like the
// composer's picker).
func effortLabels(efforts []string) []string {
	out := make([]string, len(efforts))
	for i, e := range efforts {
		switch e {
		case "xhigh":
			out[i] = "Extra high"
		default:
			out[i] = strings.ToUpper(e[:1]) + e[1:]
		}
	}
	return out
}

// themeField is a theme slot on Appearance › Theme: an Enum of the scheme's themes from
// the GUI's catalog (internal/theme), labelled with their names. A theme of the other
// scheme is refused with a message that says so. A value on disk the catalog no longer
// has (a theme removed later) falls back to the default like any rejected value:
// reported in Issues and logged at start, the file left as it is.
func themeField(key, scheme, title, desc string, bind func(s *Settings) any) Field {
	return Field{
		Key: key, Group: GroupAppearance, Page: PageAppearance, Section: "theme", Type: Enum, Title: title, Description: desc,
		Enum: theme.IDs(scheme), EnumLabels: theme.Names(scheme), Default: theme.Default(scheme),
		bind:     bind,
		unlisted: func(v string) error { return theme.Check(v, scheme) },
	}
}

// CommandInfo is what the keybinding fields need to know about a registry command.
type CommandInfo struct {
	Name        string
	Title       string
	Description string
	Category    string
	Keybindings []string
	// NoKeybinding: a chord is no use for the command (command.Command.NoKeybinding).
	// It gets no keybinding field, and an override for it is rejected.
	NoKeybinding bool
}

// sortCommands sorts commands by category, then title, like the palette.
func sortCommands(cmds []CommandInfo) []CommandInfo {
	sorted := slices.Clone(cmds)
	slices.SortFunc(sorted, func(a, b CommandInfo) int {
		if c := strings.Compare(a.Category, b.Category); c != 0 {
			return c
		}
		return strings.Compare(a.Title, b.Title)
	})
	return sorted
}

// categorySection is the keybindings page's section id for a command category: the
// category lowercased, spaces as dashes ("Pull Request" -> "pull-request").
func categorySection(category string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(category)), " ", "-")
}

// keybindingFields returns one Keybinding field per bindable command, sorted by
// category then title like the palette. Each is in the keybindings page's section for
// its category, titled with the command's title less a "<Category>: " prefix.
func keybindingFields(cmds []CommandInfo) []Field {
	out := make([]Field, 0, len(cmds))
	for _, c := range sortCommands(cmds) {
		if c.NoKeybinding {
			continue
		}
		def := ""
		if len(c.Keybindings) > 0 {
			def, _ = command.NormalizeChord(c.Keybindings[0])
		}
		out = append(out, Field{
			Key: KeybindingKey(c.Name), Group: GroupKeybindings, Page: PageKeybindings, Section: categorySection(c.Category),
			// The section names the category, so "Git: Fetch" shows as "Fetch".
			Type: Keybinding, Title: strings.TrimPrefix(c.Title, c.Category+": "), Description: c.Description, Default: def, Placeholder: c.Name,
		})
	}
	return out
}

// pages returns Pages with the keybindings page's sections filled in: one per category
// that has a bindable command, in the palette's order (by category).
func pages(cmds []CommandInfo) []Page {
	var kb []Section
	for _, c := range sortCommands(cmds) {
		id := categorySection(c.Category)
		if c.NoKeybinding || (len(kb) > 0 && kb[len(kb)-1].ID == id) {
			continue
		}
		kb = append(kb, Section{ID: id, Title: c.Category})
	}
	out := make([]Page, len(Pages))
	for i, p := range Pages {
		p.Sections = slices.Clone(p.Sections)
		if p.ID == PageKeybindings {
			p.Sections = kb
		}
		out[i] = p
	}
	return out
}

// parse validates and canonicalizes a non-empty raw value for f.
func (f Field) parse(v string) (string, error) {
	var out string
	switch f.Type {
	case Bool:
		b, err := strconv.ParseBool(v)
		if err != nil {
			return "", fmt.Errorf("want true or false, got %q", v)
		}
		out = strconv.FormatBool(b)
	case Int:
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil {
			return "", fmt.Errorf("want an integer, got %q", v)
		}
		if n < f.Min || n > f.Max {
			return "", fmt.Errorf("want %d to %d, got %d", f.Min, f.Max, n)
		}
		out = strconv.Itoa(n)
	case Enum:
		if !slices.Contains(f.Enum, v) {
			if f.unlisted != nil {
				if err := f.unlisted(v); err != nil {
					return "", err
				}
			}
			return "", fmt.Errorf("want one of %s, got %q", enumList(f.Enum), v)
		}
		out = v
	case Path:
		if _, err := command.ExpandPath(v); err != nil {
			return "", err
		}
		out = v
	case Keybinding:
		if strings.EqualFold(strings.TrimSpace(v), KeybindingNone) {
			return KeybindingNone, nil
		}
		c, err := command.ValidateBinding(v)
		if err != nil {
			return "", err
		}
		out = c
	default:
		out = v
	}
	if f.check != nil {
		if err := f.check(out); err != nil {
			return "", err
		}
	}
	return out, nil
}

func enumList(vals []string) string {
	q := make([]string, len(vals))
	for i, v := range vals {
		q[i] = strconv.Quote(v)
	}
	return strings.Join(q, ", ")
}

// checkExecutable requires an existing, executable regular file.
func checkExecutable(v string) error {
	p, err := command.ExpandPath(v)
	if err != nil {
		return err
	}
	fi, err := os.Stat(p)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return fmt.Errorf("%s does not exist", p)
	case err != nil:
		return err
	case fi.IsDir() || fi.Mode()&0o111 == 0:
		return fmt.Errorf("%s is not an executable file", p)
	}
	return nil
}

// checkRegistries validates plugins.registries: every entry a registry URL.
// checkBackdropFile accepts "" or a plain, non-hidden file name: the backdrops directory
// is the only place appearance.backdrop_file can point.
func checkBackdropFile(v string) error {
	if v == "" {
		return nil
	}
	if strings.ContainsAny(v, `/\`) || strings.HasPrefix(v, ".") {
		return fmt.Errorf("want a file name in the backdrops folder, got %q", v)
	}
	return nil
}

// crossCheck is a rule over several keys' resolved values. Update runs it when the
// change sets one of keys and reports a refusal on the first of them it sets. Load and
// reload do not: a hand-edited file is not rewritten, and its readers fall back instead
// (custom without an image renders the forest art).
type crossCheck struct {
	keys  []string
	check func(o Options, values map[string]string) error
}

var crossChecks = []crossCheck{
	{keys: []string{KeyBackdrop, KeyBackdropFile}, check: checkBackdropChoice},
}

// crossIssues returns the cross checks partial runs into, given the resolved values.
func crossIssues(o Options, partial, values map[string]string) []Issue {
	var out []Issue
	for _, c := range crossChecks {
		i := slices.IndexFunc(c.keys, func(k string) bool { _, ok := partial[k]; return ok })
		if i < 0 {
			continue
		}
		if err := c.check(o, values); err != nil {
			out = append(out, Issue{c.keys[i], err.Error()})
		}
	}
	return out
}

// checkBackdropChoice refuses appearance.backdrop = custom without an image to show:
// appearance.backdrop_file empty, or (with Options.BackdropsDir) naming no regular file in
// the backdrops directory. Images are added on the settings page, which selects each one.
func checkBackdropChoice(o Options, values map[string]string) error {
	if values[KeyBackdrop] != BackdropCustom {
		return nil
	}
	file := values[KeyBackdropFile]
	if file == "" {
		return errors.New("custom needs an image: add one under Settings › Appearance › Backdrop first")
	}
	if o.BackdropsDir == "" {
		return nil
	}
	if fi, err := os.Lstat(filepath.Join(o.BackdropsDir, file)); err != nil || !fi.Mode().IsRegular() {
		return fmt.Errorf("custom needs an image, and %q is not in the backdrops folder", file)
	}
	return nil
}

func checkRegistries(v string) error {
	_, err := registry.ParseList(v)
	return err
}
