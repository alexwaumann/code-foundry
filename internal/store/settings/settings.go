// Package settings is the file-backed settings store. The file ($CONFIG/settings.toml)
// is the source of truth: Update rewrites it atomically, and edits made by hand while
// the daemon runs are picked up by an fsnotify watcher and published like any other
// change.
//
// Every setting is described by a Field (key, title, description, type, default,
// group), so the API can hand clients a schema and the GUI renders the settings form
// without hardcoding settings. Values travel as strings encoded by their type, like
// command args. The typed view is Settings.
package settings

import (
	"cmp"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// FileName is the settings file's name inside the config home.
const FileName = "settings.toml"

// Settings is the typed view of the effective values.
type Settings struct {
	Threads    Threads
	GitHub     GitHub
	Projects   Projects
	GitOps     GitOps
	Appearance Appearance
	// Notifications are consumed by the GUI (the Dock badge and alerts).
	Notifications Notifications
	// Keybindings are the valid overrides: command name -> canonical chord or
	// KeybindingNone.
	Keybindings map[string]string
	Update      Update
	Plugins     Plugins
	Ember       Ember
	Dictation   Dictation
	Advanced    Advanced
}

// Dictation configures voice dictation (internal/store/dictation).
type Dictation struct {
	// Enabled runs the engine with the model loaded (once the model is downloaded).
	Enabled bool
}

// Ember configures the resident agent (internal/store/ember).
type Ember struct {
	Enabled bool
	Model   string // a model registry value; default model.EmberDefault
	Effort  string // low, medium, high
	// WorkerModels is the comma-separated model ids its worker threads alternate
	// between (SplitList reads it).
	WorkerModels       string
	WorkerEffort       string
	EpochContextTokens int
	EpochMaxHours      int
}

// Threads are defaults for new Claude Code sessions.
type Threads struct {
	DefaultModel      string // default model.Default
	DefaultEffort     string // default "medium"
	DefaultWorktree   string // WorktreeNew or WorktreeCurrent; read by the GUI's composer only
	AutoName          bool
	NamingModel       string // default model.NamingDefault; the effort is always low
	CacheTTLSeconds   int    // the API's prompt cache lifetime; default 3600
	CloseGraceSeconds int
	ScrollbackLines   int
}

// GitHub configures the gh poller.
type GitHub struct {
	PollIntervalSeconds int
	DashboardsEnabled   bool
}

// Projects configures the project store, and how the thread store names the branches
// of new worktrees and workspaces.
type Projects struct {
	FetchIntervalSeconds int // 0 = off
	// AutoPull fast-forwards checkouts on the default branch after each scheduled
	// fetch (project.AutoPull); read at every fetch.
	AutoPull bool
	// BranchNaming is BranchNamingPrefix, BranchNamingSemantic (default) or
	// BranchNamingCustom.
	BranchNaming string
	// BranchPrefix is prefix mode's first component; BranchPrefixNone for none
	// (BranchPrefixValue reads it).
	BranchPrefix string
	// BranchInstructions are custom mode's instructions to the naming model.
	BranchInstructions string
	// BaseFromOrigin branches new worktrees from origin's copy of their base unless
	// the local branch is ahead of it; off, from the local branch
	// (project.CreateWorktreeOptions.BaseFromOrigin); read at every new worktree.
	BaseFromOrigin bool
}

// BranchPrefixValue is the prefix branches get in prefix mode: "" for
// BranchPrefixNone, else BranchPrefix without slashes at its ends.
func (p Projects) BranchPrefixValue() string {
	if p.BranchPrefix == BranchPrefixNone {
		return ""
	}
	return strings.Trim(p.BranchPrefix, "/")
}

// GitOps configures the gitops store.
type GitOps struct {
	EditorCommand string // "" = auto-detect; {path} expands to the worktree path
}

// Appearance is consumed by the GUI.
type Appearance struct {
	Theme       string // the scheme: system, dark, light
	ThemeDark   string // a dark theme id (internal/theme); default github-dark
	ThemeLight  string // a light theme id; default github-light
	FontFamily  string
	FontSize    int
	Zoom        int    // percent; scales the whole GUI
	Density     string // compact, comfortable
	ThreadWidth string // compact, comfortable, full
	Backdrop    string // forest, none, custom
	// BackdropFile is the image custom shows: a file name in the backdrops directory
	// (paths.Backdrops, internal/store/backdrop).
	BackdropFile string
	// PanelKeepOpen keeps the side panel open on its new tab page when its last tab
	// closes, instead of hiding it.
	PanelKeepOpen bool
}

// Notifications configure the GUI's Dock badge and attention alerts. A bare executable
// has no bundle, so macOS notification banners are not available
// (docs/notes/dock-alerts.md).
type Notifications struct {
	DockBadge       bool // the attention count on the Dock icon
	Bounce          bool // bounce the Dock icon on an alert
	Sound           bool // play a sound on an alert
	SoundVolume     int  // percent of the output volume, 0 to 100
	CooldownSeconds int  // minimum gap between alerts; 0 = none
}

// Update configures the updater.
type Update struct {
	Channel string // ChannelStable (default) or ChannelTip
}

// Values of update.channel: which releases the updater follows.
const (
	ChannelStable = "stable"
	ChannelTip    = "tip"
)

// Plugins configures where plugins are installed from.
type Plugins struct {
	// Registries is the plugins.registries value: registry URLs separated by commas
	// (registry.ParseList reads it).
	Registries string
}

// Advanced holds executable overrides and logging.
type Advanced struct {
	ClaudePath string // "" = from PATH
	GhPath     string // "" = from PATH or Homebrew
	LogLevel   string // debug, info, warn, error
}

// Defaults returns the settings with every field at its default.
func Defaults() Settings {
	return resolve(nil, nil).settings
}

// CloseGrace is Threads.CloseGraceSeconds as a duration.
func (s Settings) CloseGrace() time.Duration {
	return time.Duration(s.Threads.CloseGraceSeconds) * time.Second
}

// CacheTTL is Threads.CacheTTLSeconds as a duration.
func (s Settings) CacheTTL() time.Duration {
	return time.Duration(s.Threads.CacheTTLSeconds) * time.Second
}

// GhPollInterval is GitHub.PollIntervalSeconds as a duration.
func (s Settings) GhPollInterval() time.Duration {
	return time.Duration(s.GitHub.PollIntervalSeconds) * time.Second
}

// FetchInterval is Projects.FetchIntervalSeconds as a duration; negative (off) for 0, as
// project.Options.FetchInterval expects.
func (s Settings) FetchInterval() time.Duration {
	if s.Projects.FetchIntervalSeconds <= 0 {
		return -1
	}
	return time.Duration(s.Projects.FetchIntervalSeconds) * time.Second
}

// ExpandedPath returns a Path setting with ~ expanded, or "" when unset.
func ExpandedPath(v string) string {
	if v == "" {
		return ""
	}
	p, err := command.ExpandPath(v)
	if err != nil {
		return ""
	}
	return p
}

// Issue is a rejected value or unknown key, by settings key.
type Issue struct {
	Key     string
	Message string
}

// Snapshot is the published state. It is immutable once published.
type Snapshot struct {
	Settings Settings
	// Values holds every field's effective value by key (defaults included). A
	// keybinding's effective value is its override, else the command's default chord.
	Values   map[string]string
	Path     string
	Revision uint64
	// LoadError is set when the file could not be parsed. The values from before stay
	// in effect: those of the last successful load, which at the daemon's start are
	// the last file that parsed (settings.toml.lastgood), else the defaults.
	LoadError string
	// Issues lists values in the file that were rejected (their defaults apply) and
	// unknown keys, sorted by key.
	Issues []Issue
	// RestartPending lists Restart keys whose value differs from the daemon's start.
	RestartPending []string
}

// Changed is published on the bus after every change to the snapshot.
type Changed struct {
	Snapshot *Snapshot
}

// sameState reports whether two snapshots have the same observable content (ignoring
// Revision).
func sameState(a, b *Snapshot) bool {
	return maps.Equal(a.Values, b.Values) && a.LoadError == b.LoadError &&
		slices.Equal(a.Issues, b.Issues) && slices.Equal(a.RestartPending, b.RestartPending)
}

// resolved is the outcome of validating raw file values.
type resolved struct {
	settings Settings
	// values is every field's effective value.
	values map[string]string
	// accepted is the raw values that were valid, canonicalized. The file keeps them
	// and the raw values of keys with issues (fileValues).
	accepted map[string]string
	issues   []Issue
}

// resolve is resolveThemes with the curated themes only.
func resolve(raw map[string]string, cmds []CommandInfo) resolved {
	return resolveThemes(raw, cmds, theme.Set{})
}

// resolveThemes builds Settings and the effective values from raw file values
// (string-encoded, keyed by settings key). cmds may be nil when the command registry is
// not known yet: keybinding overrides are then checked for syntax only. themes are the
// themes a theme slot can name. Rejected values fall back to their defaults (or the
// field's fallback) and are reported as issues.
func resolveThemes(raw map[string]string, cmds []CommandInfo, themes theme.Set) resolved {
	r := resolved{values: make(map[string]string, len(staticFields)), accepted: map[string]string{}}
	for _, f := range fieldsFor(themes) {
		v := f.Default
		if rv, ok := raw[f.Key]; ok && rv != "" {
			p, err := f.parse(rv)
			if err != nil {
				msg := err.Error()
				if f.fallback != nil {
					if fb, why := f.fallback(rv); fb != "" {
						v, msg = fb, msg+"; "+why
					}
				}
				r.issues = append(r.issues, Issue{f.Key, msg})
			} else {
				v = p
				r.accepted[f.Key] = p
			}
		}
		r.values[f.Key] = v
		set(f.bind(&r.settings), v)
	}
	kb, kbValues, kbIssues := resolveKeybindings(raw, cmds)
	r.settings.Keybindings = kb
	maps.Copy(r.values, kbValues)
	for name, c := range kb {
		r.accepted[KeybindingKey(name)] = c
	}
	r.issues = append(r.issues, kbIssues...)
	for k := range raw {
		if _, ok := r.values[k]; !ok && !isKeybindingKey(k) {
			r.issues = append(r.issues, Issue{k, "unknown setting"})
		}
	}
	slices.SortFunc(r.issues, func(a, b Issue) int {
		return cmp.Or(strings.Compare(a.Key, b.Key), strings.Compare(a.Message, b.Message))
	})
	return r
}

// fileValues is what the file keeps after a save from raw (r = resolve(raw, ...)): the
// accepted values, canonicalized, and the raw text of every key with an issue (a value
// that failed validation, an unknown key, a keybinding for a command that is not
// registered now), so a hand edit the app cannot use survives a save from the app until
// the user fixes or removes it. dropped lists the keys it cannot keep: a top-level key
// whose name is also a table the file has (threads = 5 next to [threads]).
func (r resolved) fileValues(raw map[string]string) (keep map[string]string, dropped []string) {
	keep = maps.Clone(r.accepted)
	tables := map[string]bool{}
	for _, g := range Groups {
		tables[g.ID] = true
	}
	for k := range raw {
		if g, _, ok := strings.Cut(k, "."); ok {
			tables[g] = true
		}
	}
	for _, is := range r.issues {
		v, ok := raw[is.Key]
		if !ok || v == "" {
			continue
		}
		if !strings.Contains(is.Key, ".") && tables[is.Key] {
			dropped = append(dropped, is.Key)
			continue
		}
		keep[is.Key] = v
	}
	slices.Sort(dropped)
	return keep, slices.Compact(dropped)
}

// set stores the canonical string v into a *string, *int, or *bool.
func set(p any, v string) {
	switch p := p.(type) {
	case *string:
		*p = v
	case *int:
		*p, _ = strconv.Atoi(v)
	case *bool:
		*p = v == "true"
	}
}
