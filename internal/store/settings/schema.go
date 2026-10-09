package settings

import (
	"errors"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/command"
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

// Group is a section of the settings page and a table in the file.
type Group struct {
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
	Type        Type
	Enum        []string
	// Default is the string-encoded value used when the file does not set the key.
	Default string
	// Restart means the daemon reads the value only at start.
	Restart bool
	// Min and Max bound Int fields (inclusive).
	Min, Max    int
	Placeholder string

	// bind returns a pointer into s (*string, *int, or *bool) for static fields.
	bind func(s *Settings) any
	// check is extra validation run after parsing (e.g. an executable exists).
	check func(v string) error
}

// Name is the key within its group's table.
func (f Field) Name() string { return strings.TrimPrefix(f.Key, f.Group+".") }

// KeybindingNone unbinds a command.
const KeybindingNone = "none"

// Group ids.
const (
	GroupSessions    = "sessions"
	GroupGitHub      = "github"
	GroupRepos       = "repos"
	GroupGitOps      = "gitops"
	GroupAppearance  = "appearance"
	GroupKeybindings = "keybindings"
	GroupAdvanced    = "advanced"
)

// Groups in display order (also the order of tables in the file).
var Groups = []Group{
	{GroupSessions, "Sessions", "Defaults for new Claude Code sessions."},
	{GroupGitHub, "GitHub", "Your pull requests and default-branch checks, polled with gh's login."},
	{GroupRepos, "Repositories", "Git fetching and where new worktrees go."},
	{GroupGitOps, "Git operations", "How worktrees are handed to other apps."},
	{GroupAppearance, "Appearance", "Theme, terminal font, and density. Applied live in every window."},
	{GroupKeybindings, "Keybindings", `Override a command's chord, or "none" to unbind it. Reserved app chords (cmd+k, cmd+b, cmd+1..9, ...) cannot be bound.`},
	{GroupAdvanced, "Advanced", "Executables and logging."},
}

// Keys of the static fields that have consumers in the daemon or GUI.
const (
	KeyDefaultModel      = "sessions.default_model"
	KeyDefaultEffort     = "sessions.default_effort"
	KeyAutoName          = "sessions.auto_name"
	KeyCloseGrace        = "sessions.close_grace_seconds"
	KeyScrollback        = "sessions.scrollback_lines"
	KeyGhPollInterval    = "github.poll_interval_seconds"
	KeyDashboards        = "github.dashboards_enabled"
	KeyFetchInterval     = "repos.fetch_interval_seconds"
	KeyWorktreeDir       = "repos.worktree_dir"
	KeyEditorCommand     = "gitops.editor_command"
	KeyTheme             = "appearance.theme"
	KeyFontFamily        = "appearance.font_family"
	KeyFontSize          = "appearance.font_size"
	KeyDensity           = "appearance.density"
	KeyClaudePath        = "advanced.claude_path"
	KeyGhPath            = "advanced.gh_path"
	KeyLogLevel          = "advanced.log_level"
	keybindingKeyPrefix  = GroupKeybindings + "."
	defaultFontFamily    = "JetBrains Mono, SF Mono, Menlo"
	defaultScrollback    = 10000
	defaultCloseGrace    = 10
	defaultGhPollSeconds = 60
	defaultFetchSeconds  = 120
)

// KeybindingKey is the settings key of a command's keybinding override.
func KeybindingKey(command string) string { return keybindingKeyPrefix + command }

// staticFields are every field except the per-command keybindings, in display order.
var staticFields = []Field{
	{
		Key: KeyDefaultModel, Group: GroupSessions, Type: Enum, Title: "Default model",
		Description: "Model for new sessions when none is picked. Empty uses Claude's own default.",
		Enum:        append([]string{""}, command.SessionModels...),
		bind:        func(s *Settings) any { return &s.Sessions.DefaultModel },
	},
	{
		Key: KeyDefaultEffort, Group: GroupSessions, Type: Enum, Title: "Default effort",
		Description: "Effort level for new sessions when none is picked. Empty uses Claude's own default.",
		Enum:        append([]string{""}, command.SessionEfforts...),
		bind:        func(s *Settings) any { return &s.Sessions.DefaultEffort },
	},
	{
		Key: KeyAutoName, Group: GroupSessions, Type: Bool, Title: "Name sessions automatically",
		Description: "Name a new session from its first message with a short claude -p call.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.Sessions.AutoName },
	},
	{
		Key: KeyCloseGrace, Group: GroupSessions, Type: Int, Title: "Close grace (seconds)",
		Description: "How long closing a session waits for Claude to exit after /exit before killing it.",
		Default:     strconv.Itoa(defaultCloseGrace), Min: 1, Max: 120, Restart: true,
		bind: func(s *Settings) any { return &s.Sessions.CloseGraceSeconds },
	},
	{
		Key: KeyScrollback, Group: GroupSessions, Type: Int, Title: "Scrollback lines",
		Description: "Lines of history each terminal keeps, in the daemon and in the window.",
		Default:     strconv.Itoa(defaultScrollback), Min: 1000, Max: 100000, Restart: true,
		bind: func(s *Settings) any { return &s.Sessions.ScrollbackLines },
	},
	{
		Key: KeyGhPollInterval, Group: GroupGitHub, Type: Int, Title: "Poll interval (seconds)",
		Description: "How often one request checks your pull requests, watched branches, and tracked default branches for changes. Details are fetched only for what changed.",
		Default:     strconv.Itoa(defaultGhPollSeconds), Min: 15, Max: 3600,
		bind: func(s *Settings) any { return &s.GitHub.PollIntervalSeconds },
	},
	{
		Key: KeyDashboards, Group: GroupGitHub, Type: Bool, Title: "Pull request dashboards",
		Description: "Poll your pull requests (authored, awaiting your review, reviewed, recently merged) for the Pull Requests page. Off leaves only default-branch CI and watched branches.",
		Default:     "true",
		bind:        func(s *Settings) any { return &s.GitHub.DashboardsEnabled },
	},
	{
		Key: KeyFetchInterval, Group: GroupRepos, Type: Int, Title: "Fetch interval (seconds)",
		Description: "How often each repository runs git fetch --prune. 0 turns background fetching off.",
		Default:     strconv.Itoa(defaultFetchSeconds), Min: 0, Max: 86400, Restart: true,
		bind: func(s *Settings) any { return &s.Repos.FetchIntervalSeconds },
	},
	{
		Key: KeyWorktreeDir, Group: GroupRepos, Type: Path, Title: "Worktree directory",
		Description: "Where New Worktree puts worktrees. {repo} is replaced by the repository's name. Empty uses ~/.code-foundry/worktrees/<owner>/<repo>.",
		Placeholder: "~/worktrees/{repo}",
		bind:        func(s *Settings) any { return &s.Repos.WorktreeDir },
	},
	{
		Key: KeyEditorCommand, Group: GroupGitOps, Type: String, Title: "Editor command",
		Description: "Command that opens a worktree (Open in Editor), e.g. \"code\" or \"open -a Zed\". {path} is replaced by the worktree path; without it the path is appended. Empty detects an editor ($VISUAL/$EDITOR if graphical, then common editors).",
		Placeholder: "auto-detect",
		bind:        func(s *Settings) any { return &s.GitOps.EditorCommand },
	},
	{
		Key: KeyTheme, Group: GroupAppearance, Type: Enum, Title: "Theme",
		Description: "System follows the macOS appearance.",
		Enum:        []string{"system", "dark", "light"}, Default: "system",
		bind: func(s *Settings) any { return &s.Appearance.Theme },
	},
	{
		Key: KeyFontFamily, Group: GroupAppearance, Type: String, Title: "Terminal font family",
		Description: "Comma-separated font families, first installed wins. ui-monospace and Menlo are always appended as fallbacks.",
		Default:     defaultFontFamily, Placeholder: defaultFontFamily,
		bind: func(s *Settings) any { return &s.Appearance.FontFamily },
	},
	{
		Key: KeyFontSize, Group: GroupAppearance, Type: Int, Title: "Terminal font size",
		Description: "In points. cmd+= and cmd+- change it too.",
		Default:     "13", Min: 9, Max: 28,
		bind: func(s *Settings) any { return &s.Appearance.FontSize },
	},
	{
		Key: KeyDensity, Group: GroupAppearance, Type: Enum, Title: "Density",
		Description: "Row height and spacing in the sidebar and lists.",
		Enum:        []string{"compact", "comfortable"}, Default: "compact",
		bind: func(s *Settings) any { return &s.Appearance.Density },
	},
	{
		Key: KeyClaudePath, Group: GroupAdvanced, Type: Path, Title: "claude executable",
		Description: "Absolute path to claude. Empty finds it on PATH.",
		Placeholder: "claude (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.ClaudePath },
	},
	{
		Key: KeyGhPath, Group: GroupAdvanced, Type: Path, Title: "gh executable",
		Description: "Absolute path to gh. Empty finds it on PATH or in Homebrew's locations.",
		Placeholder: "gh (from PATH)", Restart: true, check: checkExecutable,
		bind: func(s *Settings) any { return &s.Advanced.GhPath },
	},
	{
		Key: KeyLogLevel, Group: GroupAdvanced, Type: Enum, Title: "Log level",
		Description: "Minimum level written to the daemon's log file (logs/daemon.log).",
		Enum:        []string{"debug", "info", "warn", "error"}, Default: "info",
		bind: func(s *Settings) any { return &s.Advanced.LogLevel },
	},
}

// CommandInfo is what the keybinding fields need to know about a registry command.
type CommandInfo struct {
	Name        string
	Title       string
	Description string
	Category    string
	Keybindings []string
}

// keybindingFields returns one Keybinding field per command, sorted by category then
// title like the palette.
func keybindingFields(cmds []CommandInfo) []Field {
	sorted := slices.Clone(cmds)
	slices.SortFunc(sorted, func(a, b CommandInfo) int {
		if c := strings.Compare(a.Category, b.Category); c != 0 {
			return c
		}
		return strings.Compare(a.Title, b.Title)
	})
	out := make([]Field, 0, len(sorted))
	for _, c := range sorted {
		def := ""
		if len(c.Keybindings) > 0 {
			def, _ = command.NormalizeChord(c.Keybindings[0])
		}
		out = append(out, Field{
			Key: KeybindingKey(c.Name), Group: GroupKeybindings, Type: Keybinding,
			Title: c.Category + ": " + c.Title, Description: c.Description, Default: def, Placeholder: c.Name,
		})
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
