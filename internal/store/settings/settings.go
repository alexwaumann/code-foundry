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
)

// FileName is the settings file's name inside the config home.
const FileName = "settings.toml"

// Settings is the typed view of the effective values.
type Settings struct {
	Sessions   Sessions
	GitHub     GitHub
	Repos      Repos
	GitOps     GitOps
	Appearance Appearance
	// Keybindings are the valid overrides: command name -> canonical chord or
	// KeybindingNone.
	Keybindings map[string]string
	Advanced    Advanced
}

// Sessions are defaults for new Claude Code sessions.
type Sessions struct {
	DefaultModel      string // default "opus"
	DefaultEffort     string // default "high"
	AutoName          bool
	CloseGraceSeconds int
	ScrollbackLines   int
}

// GitHub configures the gh poller.
type GitHub struct {
	PollIntervalSeconds int
	DashboardsEnabled   bool
}

// Repos configures the repo store.
type Repos struct {
	FetchIntervalSeconds int    // 0 = off
	WorktreeDir          string // "" = <config home>/worktrees/<owner>/<repo>; {repo} expands
}

// GitOps configures the gitops store.
type GitOps struct {
	EditorCommand string // "" = auto-detect; {path} expands to the worktree path
}

// Appearance is consumed by the GUI.
type Appearance struct {
	Theme      string // system, dark, light
	FontFamily string
	FontSize   int
	Zoom       int    // percent; scales the whole GUI
	Density    string // compact, comfortable
	Backdrop   string // forest, none
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

// CloseGrace is Sessions.CloseGraceSeconds as a duration.
func (s Settings) CloseGrace() time.Duration {
	return time.Duration(s.Sessions.CloseGraceSeconds) * time.Second
}

// GhPollInterval is GitHub.PollIntervalSeconds as a duration.
func (s Settings) GhPollInterval() time.Duration {
	return time.Duration(s.GitHub.PollIntervalSeconds) * time.Second
}

// FetchInterval is Repos.FetchIntervalSeconds as a duration; negative (off) for 0, as
// repo.Options.FetchInterval expects.
func (s Settings) FetchInterval() time.Duration {
	if s.Repos.FetchIntervalSeconds <= 0 {
		return -1
	}
	return time.Duration(s.Repos.FetchIntervalSeconds) * time.Second
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
	// LoadError is set when the file could not be parsed; previous values stay.
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
	// accepted is the raw values that were valid, canonicalized: what the file keeps.
	accepted map[string]string
	issues   []Issue
}

// resolve builds Settings and the effective values from raw file values (string-encoded,
// keyed by settings key). cmds may be nil when the command registry is not known yet:
// keybinding overrides are then checked for syntax only. Rejected values fall back to
// their defaults and are reported as issues.
func resolve(raw map[string]string, cmds []CommandInfo) resolved {
	r := resolved{values: make(map[string]string, len(staticFields)), accepted: map[string]string{}}
	for _, f := range staticFields {
		v := f.Default
		if rv, ok := raw[f.Key]; ok && rv != "" {
			p, err := f.parse(rv)
			if err != nil {
				r.issues = append(r.issues, Issue{f.Key, err.Error()})
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
