package settings

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/model"
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
	GroupAdvanced    = "advanced"
)

// Page ids.
const (
	PageGeneral       = "general"
	PageAppearance    = "appearance"
	PageNotifications = "notifications"
	PageSource        = "source"
	PageKeybindings   = "keybindings"
	PageAdvanced      = "advanced"
)

// Pages in display order. The keybindings page's sections are the command categories
// (see Store.Pages); here it has none.
var Pages = []Page{
	{ID: PageGeneral, Title: "General", Sections: []Section{
		{ID: "threads", Title: "Threads"},
		{ID: "textgen", Title: "Text generation", Description: "Models for small side jobs such as naming a thread."},
		{ID: "lifecycle", Title: "Lifecycle"},
		{ID: "updates", Title: "Updates"},
	}},
	{ID: PageAppearance, Title: "Appearance", Description: "Applied live in every window.", Sections: []Section{
		{ID: "theme", Title: "Theme"},
		{ID: "window", Title: "Window"},
		{ID: "terminal", Title: "Terminal"},
	}},
	{ID: PageNotifications, Title: "Notifications",
		Description: "Dock badge and alerts for threads that need you. macOS banners aren't available to an app without a bundle.",
		Sections:    []Section{{ID: "alerts"}}},
	{ID: PageSource, Title: "Source control", Sections: []Section{
		{ID: "github", Title: "GitHub", Description: "Your pull requests and default-branch checks, polled with gh's login."},
		{ID: "projects", Title: "Projects", Description: "Fetching, and how worktrees open."},
	}},
	{ID: PageKeybindings, Title: "Keybindings",
		Description: `Override a command's chord, or unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) can't be bound.`},
	{ID: PageAdvanced, Title: "Advanced", Sections: []Section{
		{ID: "executables", Title: "Executables"},
		{ID: "logging", Title: "Logging"},
	}},
}

// Groups are the file's tables, in file order. The settings page follows Pages.
var Groups = []Group{
	{GroupThreads, "Threads", "Defaults for new threads."},
	{GroupGitHub, "GitHub", "Your pull requests and default-branch checks, polled with gh's login."},
	{GroupProjects, "Projects", "Git fetching."},
	{GroupGitOps, "Git operations", "How worktrees are handed to other apps."},
	{GroupAppearance, "Appearance", "Scheme, themes, terminal font, density, and backdrop. Applied live in every window."},
	{GroupNotify, "Notifications", "Dock badge and alerts for threads that need you. macOS banners aren't available to an app without a bundle."},
	{GroupKeybindings, "Keybindings", `Override a command's chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.`},
	{GroupUpdate, "Updates", "Which releases the app checks for and offers to install."},
	{GroupAdvanced, "Advanced", "Executables and logging."},
}

// Keys of the static fields that have consumers in the daemon or GUI.
const (
	KeyDefaultModel      = "threads.default_model"
	KeyDefaultEffort     = "threads.default_effort"
	KeyDefaultWorktree   = "threads.default_worktree"
	KeyAutoName          = "threads.auto_name"
	KeyNamingModel       = "threads.naming_model"
	KeyCacheTTL          = "threads.cache_ttl_seconds"
	KeyCloseGrace        = "threads.close_grace_seconds"
	KeyScrollback        = "threads.scrollback_lines"
	KeyGhPollInterval    = "github.poll_interval_seconds"
	KeyDashboards        = "github.dashboards_enabled"
	KeyFetchInterval     = "projects.fetch_interval_seconds"
	KeyEditorCommand     = "gitops.editor_command"
	KeyTheme             = "appearance.theme"
	KeyThemeDark         = "appearance.theme_dark"
	KeyThemeLight        = "appearance.theme_light"
	KeyFontFamily        = "appearance.font_family"
	KeyFontSize          = "appearance.font_size"
	KeyZoom              = "appearance.zoom"
	KeyDensity           = "appearance.density"
	KeyThreadWidth       = "appearance.thread_width"
	KeyBackdrop          = "appearance.backdrop"
	KeyDockBadge         = "notifications.dock_badge"
	KeyBounce            = "notifications.bounce"
	KeySound             = "notifications.sound"
	KeySoundVolume       = "notifications.sound_volume"
	KeyAlertCooldown     = "notifications.cooldown_seconds"
	KeyUpdateChannel     = "update.channel"
	KeyClaudePath        = "advanced.claude_path"
	KeyGhPath            = "advanced.gh_path"
	KeyLogLevel          = "advanced.log_level"
	keybindingKeyPrefix  = GroupKeybindings + "."
	defaultFontFamily    = "JetBrainsMono Nerd Font Mono, JetBrains Mono, SF Mono, Menlo"
	defaultScrollback    = 10000
	defaultCloseGrace    = 10
	defaultCacheTTL      = 3600
	defaultGhPollSeconds = 60
	defaultFetchSeconds  = 120
	defaultSoundVolume   = 50
	defaultAlertCooldown = 60
)

// threads.default_worktree values: a new worktree, or the project's main checkout.
const (
	WorktreeNew     = "new"
	WorktreeCurrent = "current"
)

// KeybindingKey is the settings key of a command's keybinding override.
func KeybindingKey(command string) string { return keybindingKeyPrefix + command }

// staticFields are every field except the per-command keybindings, in display order:
// by page and section as in Pages, then in order within a section.
var staticFields = []Field{
	// General › Threads.
	{
		Key: KeyDefaultModel, Group: GroupThreads, Page: PageGeneral, Section: "threads", Row: "model", Type: Enum, Title: "Model",
		Description: "Used by new threads unless you pick otherwise. Every model runs with the 1M context window.",
		Enum:        command.ThreadModels, EnumLabels: model.Labels(), Default: model.Default,
		bind: func(s *Settings) any { return &s.Threads.DefaultModel },
	},
	{
		Key: KeyDefaultEffort, Group: GroupThreads, Page: PageGeneral, Section: "threads", Row: "model", Type: Enum, Title: "Effort",
		Description: "Effort level new threads use unless you pick otherwise.",
		Enum:        command.ThreadEfforts, EnumLabels: effortLabels(command.ThreadEfforts), Default: "medium",
		bind: func(s *Settings) any { return &s.Threads.DefaultEffort },
	},
	{
		// Read by the GUI only: the composer's "Work in" picker starts from it (a choice
		// remembered per project wins). thread.new itself stays explicit (--new-worktree
		// or --worktree).
		Key: KeyDefaultWorktree, Group: GroupThreads, Page: PageGeneral, Section: "threads", Type: Enum, Title: "New threads work in",
		Description: "The project folder itself edits your files in place. A fresh copy gives each thread its own folder and branch, so several can run at once.",
		Enum:        []string{WorktreeNew, WorktreeCurrent},
		EnumLabels:  []string{"A fresh copy of the project", "The project folder itself"},
		Default:     WorktreeCurrent,
		bind:        func(s *Settings) any { return &s.Threads.DefaultWorktree },
	},
	{
		Key: KeyAutoName, Group: GroupThreads, Page: PageGeneral, Section: "threads", Type: Bool, Title: "Name threads automatically",
		Description: "Name a new thread from its first message with a short claude -p call to the naming model.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Threads.AutoName },
	},
	// General › Text generation.
	{
		Key: KeyNamingModel, Group: GroupThreads, Page: PageGeneral, Section: "textgen", DependsOn: KeyAutoName, Type: Enum, Title: "Naming model",
		Description: "Names a new thread from its first message. Always runs at low effort.",
		Enum:        command.ThreadModels, EnumLabels: model.Labels(), Default: model.NamingDefault,
		bind: func(s *Settings) any { return &s.Threads.NamingModel },
	},
	// General › Lifecycle.
	{
		Key: KeyCacheTTL, Group: GroupThreads, Page: PageGeneral, Section: "lifecycle", Unit: "s", Type: Int, Title: "Prompt cache lifetime",
		Description: "How long the Claude API keeps a conversation's prompt cache after its last request (1 hour on Bedrock and the Anthropic API). Code Foundry uses it to predict when a thread's cache has expired; it does not change the API's behaviour.",
		Default:     strconv.Itoa(defaultCacheTTL), Min: 60, Max: 86400,
		bind: func(s *Settings) any { return &s.Threads.CacheTTLSeconds },
	},
	{
		Key: KeyCloseGrace, Group: GroupThreads, Page: PageGeneral, Section: "lifecycle", Unit: "s", Type: Int, Title: "Close grace",
		Description: "How long closing a thread waits for Claude to exit before terminating it.",
		Default:     strconv.Itoa(defaultCloseGrace), Min: 1, Max: 120, Restart: true,
		bind: func(s *Settings) any { return &s.Threads.CloseGraceSeconds },
	},
	// General › Updates.
	{
		Key: KeyUpdateChannel, Group: GroupUpdate, Page: PageGeneral, Section: "updates", Type: Enum, Title: "Channel",
		Description: "Stable is a build promoted on purpose; tip is the newest build of main, published on every push. Switching never installs an older version.",
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
	themeField(KeyThemeDark, theme.SchemeDark, "Dark theme", "Colours of the window, threads and terminals when the scheme is dark.",
		func(s *Settings) any { return &s.Appearance.ThemeDark }),
	themeField(KeyThemeLight, theme.SchemeLight, "Light theme", "Colours of the window, threads and terminals when the scheme is light.",
		func(s *Settings) any { return &s.Appearance.ThemeLight }),
	// Appearance › Window.
	{
		Key: KeyZoom, Group: GroupAppearance, Page: PageAppearance, Section: "window", Unit: "%", Type: Int, Title: "Zoom",
		Description: "Scale of the whole window, terminal included. ⌘=, ⌘- and ⌘0 change it too.",
		Default:     "100", Min: 90, Max: 200,
		bind: func(s *Settings) any { return &s.Appearance.Zoom },
	},
	{
		Key: KeyDensity, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Density",
		Description: "Row height and spacing in the sidebar and lists.",
		Enum:        []string{"compact", "comfortable"}, EnumLabels: []string{"Compact", "Comfortable"}, Default: "comfortable",
		bind: func(s *Settings) any { return &s.Appearance.Density },
	},
	{
		Key: KeyThreadWidth, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Thread width",
		Description: "Column width of a rendered thread's conversation and composer.",
		Enum:        []string{"compact", "comfortable", "full"}, EnumLabels: []string{"Compact", "Comfortable", "Full"}, Default: "comfortable",
		bind: func(s *Settings) any { return &s.Appearance.ThreadWidth },
	},
	{
		Key: KeyBackdrop, Group: GroupAppearance, Page: PageAppearance, Section: "window", Type: Enum, Title: "Backdrop",
		Description: "Faint artwork behind the start page and the new-thread composer.",
		Enum:        []string{"forest", "none"}, EnumLabels: []string{"Forest", "None"}, Default: "forest",
		bind: func(s *Settings) any { return &s.Appearance.Backdrop },
	},
	// Appearance › Terminal.
	{
		// The GUI bundles JetBrainsMono Nerd Font Mono (gui/frontend/public/fonts). Its own
		// stack, used when this is empty, is DEFAULT_TERMINAL_FONT_FAMILY in src/terminal/fonts.ts.
		Key: KeyFontFamily, Group: GroupAppearance, Page: PageAppearance, Section: "terminal", Type: String, Title: "Font family",
		Description: "Comma-separated font families; the first one installed wins. JetBrainsMono Nerd Font Mono ships with the app, and ui-monospace and Menlo are always appended.",
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
		Description: "Lines of history each terminal keeps, in the daemon and in the window.",
		Default:     strconv.Itoa(defaultScrollback), Min: 1000, Max: 100000, Restart: true,
		bind: func(s *Settings) any { return &s.Threads.ScrollbackLines },
	},
	// Notifications.
	{
		Key: KeyDockBadge, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Dock badge",
		Description: "Show how many threads need attention (waiting on you or finished) on the Dock icon.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Notifications.DockBadge },
	},
	{
		Key: KeyBounce, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Bounce the Dock icon",
		Description: "Bounce once when a thread starts needing attention while Code Foundry is not the active app.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Notifications.Bounce },
	},
	{
		Key: KeySound, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Type: Bool, Title: "Alert sound",
		Description: "Play a short sound when a thread starts needing attention while Code Foundry is not the active app.",
		Default:     "false",
		bind:        func(s *Settings) any { return &s.Notifications.Sound },
	},
	{
		Key: KeySoundVolume, Group: GroupNotify, Page: PageNotifications, Section: "alerts", DependsOn: KeySound, Unit: "%", Type: Int, Title: "Alert volume",
		Description: "Loudness of the alert sound, as a share of the Mac's output volume.",
		Default:     strconv.Itoa(defaultSoundVolume), Min: 0, Max: 100,
		bind: func(s *Settings) any { return &s.Notifications.SoundVolume },
	},
	{
		Key: KeyAlertCooldown, Group: GroupNotify, Page: PageNotifications, Section: "alerts", Unit: "s", Type: Int, Title: "Alert cooldown",
		Description: "Minimum gap between alerts (bounce and sound); the badge still updates. 0 alerts every time.",
		Default:     strconv.Itoa(defaultAlertCooldown), Min: 0, Max: 3600,
		bind: func(s *Settings) any { return &s.Notifications.CooldownSeconds },
	},
	// Source control › GitHub.
	{
		Key: KeyDashboards, Group: GroupGitHub, Page: PageSource, Section: "github", Type: Bool, Title: "Pull request dashboards",
		Description: "Poll your pull requests (authored, awaiting your review, reviewed, recently merged) for the Pull Requests page. Off leaves only default-branch CI and watched branches.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.GitHub.DashboardsEnabled },
	},
	{
		Key: KeyGhPollInterval, Group: GroupGitHub, Page: PageSource, Section: "github", Unit: "s", Type: Int, Title: "Poll interval",
		Description: "How often one request checks your pull requests, watched branches and tracked default branches for changes while the app's window is visible. Details are fetched only for what changed. With the window hidden it checks every 5 minutes, with the app closed every 15 (or at this interval, if longer).",
		Default:     strconv.Itoa(defaultGhPollSeconds), Min: 15, Max: 3600,
		bind: func(s *Settings) any { return &s.GitHub.PollIntervalSeconds },
	},
	// Source control › Projects.
	{
		Key: KeyFetchInterval, Group: GroupProjects, Page: PageSource, Section: "projects", Unit: "s", Type: Int, Title: "Fetch interval",
		Description: "How often a project with an active thread (or an open worktree panel) runs git fetch --prune. Other projects fetch every 15 minutes, or at this interval if longer. 0 turns background fetching off.",
		Default:     strconv.Itoa(defaultFetchSeconds), Min: 0, Max: 86400, Restart: true,
		bind: func(s *Settings) any { return &s.Projects.FetchIntervalSeconds },
	},
	{
		Key: KeyEditorCommand, Group: GroupGitOps, Page: PageSource, Section: "projects", Type: String, Title: "Editor command",
		Description: "Opens a worktree (Open in Editor), e.g. \"code\" or \"open -a Zed\"; {path} is the worktree path, else the path is appended. Empty detects an editor ($VISUAL/$EDITOR if graphical, then common editors).",
		Placeholder: "auto-detect",
		bind:        func(s *Settings) any { return &s.GitOps.EditorCommand },
	},
	// Advanced.
	{
		Key: KeyClaudePath, Group: GroupAdvanced, Page: PageAdvanced, Section: "executables", Type: Path, Title: "claude executable",
		Description: "Absolute path to claude. Empty finds it on PATH.",
		Placeholder: "claude (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.ClaudePath },
	},
	{
		Key: KeyGhPath, Group: GroupAdvanced, Page: PageAdvanced, Section: "executables", Type: Path, Title: "gh executable",
		Description: "Absolute path to gh. Empty finds it on PATH or in Homebrew's locations.",
		Placeholder: "gh (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.GhPath },
	},
	{
		Key: KeyLogLevel, Group: GroupAdvanced, Page: PageAdvanced, Section: "logging", Type: Enum, Title: "Log level",
		Description: "Minimum level written to the daemon's log file (logs/daemon.log).",
		Enum:        []string{"debug", "info", "warn", "error"}, EnumLabels: []string{"Debug", "Info", "Warn", "Error"}, Default: "info",
		bind: func(s *Settings) any { return &s.Advanced.LogLevel },
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
