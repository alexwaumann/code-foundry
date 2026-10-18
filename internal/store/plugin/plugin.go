// Package plugin is the plugin store: it finds plugin packages under
// ~/.code-foundry/plugins/<name>/plugin.json, keeps the user's choices about them in
// SQLite (migration 0029: enabled, the permissions consented to, the dev link), and runs
// one actor per enabled plugin. An actor starts the plugin's process (internal/childproc),
// speaks the plugin protocol with it over stdio (pluginsdk: newline-delimited JSON-RPC
// 2.0), pings it, restarts it with backoff when it crashes or hangs, and stops it with
// shutdown → SIGTERM → SIGKILL. stderr and the plugin's log notifications go to
// logs/plugins/<name>.log (1 MiB, one rotation) and an in-memory tail.
//
// A plugin's manifest commands are registered in the command registry as
// plugin.<name>.<command> (Registry.ReplacePrefix) while it is enabled, also while it is
// down: invoking one then fails saying why. The plugin reaches the host through the
// methods in host.go: host/invoke (the manifest's permissions.commands globs; it never
// confirms on the user's behalf), log, and secret/* (the Keychain, namespaced per
// plugin). Methods of later protocol steps answer "not supported yet".
//
// Surfaces (surface.go, surface_act.go): instances opened for their watchers, views the
// daemon validates, versions and coalesces, log appends, and actions forwarded to the
// plugin. Availability (predicate.go, facts.go, show.go): when clauses over host facts,
// plugins' context/set facts and the async pull request checks, carried to clients by
// the commands' When and plugin.<name>.show.<surface>.
//
// The store publishes an immutable Snapshot behind an atomic pointer and Changed /
// Removed events on the bus, like every store. See docs/notes/plugins-1-core.md and the
// design in docs/sketches/plugins/.
package plugin

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Errors returned by Store methods, wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	ErrClosed             = errors.New("plugin store closed")
)

// State is where a plugin is in its lifecycle.
type State int

const (
	// StateDisabled: found, not enabled (new, disabled by the user, or its permissions
	// grew; see Plugin.DisabledReason).
	StateDisabled State = iota + 1
	// StateStarting: spawned, initialize in flight.
	StateStarting
	// StateRunning: initialized and answering pings.
	StateRunning
	// StateCrashed: exited, hung or unreachable; waiting for the next attempt
	// (Plugin.NextRestartAt).
	StateCrashed
	// StateStopping: shutdown → SIGTERM → SIGKILL in progress.
	StateStopping
	// StateStopped: the daemon is shutting down.
	StateStopped
	// StateFailed: a bad manifest, an unsupported protocol, a missing executable, or it
	// crashed too often. Restart (re-reads the manifest) leaves it.
	StateFailed
)

func (s State) String() string {
	switch s {
	case StateDisabled:
		return "disabled"
	case StateStarting:
		return "starting"
	case StateRunning:
		return "running"
	case StateCrashed:
		return "crashed"
	case StateStopping:
		return "stopping"
	case StateStopped:
		return "stopped"
	case StateFailed:
		return "failed"
	}
	return fmt.Sprintf("State(%d)", int(s))
}

// Plugin is an immutable snapshot of one plugin.
type Plugin struct {
	Name string
	// Dir is the package directory (a dev link resolved to the author's folder).
	Dir string
	// Dev: linked with `plugin dev`; DevPath is the linked folder. Dev plugins back off
	// at most 2 s and never fail for crashing.
	Dev     bool
	DevPath string
	// Manifest is the parsed plugin.json; zero when it could not be read.
	Manifest pluginsdk.Manifest
	// Issues are manifest warnings (unknown fields) and registration problems.
	Issues  []string
	Enabled bool
	// DisabledReason says why an enabled plugin was turned off by the daemon
	// ("permissions changed").
	DisabledReason string
	// Granted is what the user consented to; nil when never.
	Granted     *pluginsdk.Permissions
	ConsentedAt time.Time
	// NeedsConsent: enabling asks the user first (never consented, or the manifest asks
	// for more than Granted).
	NeedsConsent bool
	State        State
	PID          int
	StartedAt    time.Time
	// NextRestartAt is when a crashed plugin is tried again.
	NextRestartAt time.Time
	// Restarts counts crashes since the plugin was last enabled or restarted.
	Restarts  int
	LastError string
	// Protocol and Capabilities are the plugin's initialize reply.
	Protocol     int
	Capabilities []string
	// LogPath is logs/plugins/<name>.log.
	LogPath string
	// Installed says where `plugin install` got the package (install.go); nil for one
	// put in the plugins directory by hand.
	Installed *InstallRecord
	// Update is a newer version a registry lists (updates.go); nil when there is none.
	Update *UpdateOffer
}

// DisplayName is the manifest's display name, else the name.
func (p Plugin) DisplayName() string {
	if p.Manifest.DisplayName != "" {
		return p.Manifest.DisplayName
	}
	return p.Name
}

// Snapshot is every plugin found, by name. Never mutate it.
type Snapshot struct {
	Plugins []Plugin
}

// Plugin returns the plugin called name.
func (s *Snapshot) Plugin(name string) (Plugin, bool) {
	if s == nil {
		return Plugin{}, false
	}
	i := slices.IndexFunc(s.Plugins, func(p Plugin) bool { return p.Name == name })
	if i < 0 {
		return Plugin{}, false
	}
	return s.Plugins[i], true
}

// Event is published on the bus as bus.Publish[plugin.Event]. *Snapshot also implements
// it so a consumer can merge a resync into the same stream.
type Event interface{ isPluginEvent() }

// Changed carries a plugin's full state after any change.
type Changed struct{ Plugin Plugin }

// Removed is sent when a plugin's package is gone.
type Removed struct{ Name string }

func (Changed) isPluginEvent()   {}
func (Removed) isPluginEvent()   {}
func (*Snapshot) isPluginEvent() {}

// EnableResult is Enable's and Dev's answer. With NeedsConsent nothing was enabled: show
// Consent and call again with consent.
type EnableResult struct {
	Plugin       Plugin
	NeedsConsent bool
	// Consent is the text the user consents to (ConsentText).
	Consent string
}

// LogLine is one line of a plugin's log.
type LogLine struct {
	Seq  uint64
	Time time.Time
	// Source is "stderr", "log" (a log notification) or "host" (the daemon's own lines:
	// starts, exits, refused calls).
	Source string
	// Level is the log notification's level; "" for stderr.
	Level string
	Text  string
}

// SecretInfo is one stored secret's name and when it was set.
type SecretInfo = pluginsdk.SecretInfo

// Store is the plugin store's API. *Manager implements it; plugintest.Fake is an
// in-memory fake.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// Enable turns a plugin on. Without consent it only reports what needs consent
	// (when anything does); with consent it records the grant and starts it.
	Enable(ctx context.Context, name string, consent bool) (EnableResult, error)
	// Disable stops a plugin and removes its commands. Its secrets stay.
	Disable(ctx context.Context, name string) (Plugin, error)
	// Restart re-reads the manifest and starts the plugin afresh (also from failed).
	Restart(ctx context.Context, name string) (Plugin, error)
	// Dev links a plugin folder into the plugins dir and enables it (consent as Enable).
	// dryRun only reads the folder's manifest and reports the consent needed.
	Dev(ctx context.Context, dir string, consent, dryRun bool) (EnableResult, error)
	// Reload rescans the plugins dir.
	Reload(ctx context.Context) error
	// Logs returns the last n lines of a plugin's log (all kept when n <= 0).
	Logs(name string, n int) ([]LogLine, error)
	// FollowLogs sends the last n lines, then new ones, until ctx ends.
	FollowLogs(ctx context.Context, name string, n int) (<-chan LogLine, error)
	// Secrets lists a plugin's stored secrets (names only).
	Secrets(ctx context.Context, name string) ([]SecretInfo, error)
	// DeleteSecret removes one.
	DeleteSecret(ctx context.Context, name, key string) error
	// Environments returns the plugins' session environments as applied
	// (environment.go): one plugin's with a name (none when it has none), else every one.
	Environments(name string) ([]Environment, error)
}

// ConsentText is what the user consents to when enabling m: who it runs as and every
// permission in words.
func ConsentText(m pluginsdk.Manifest) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Enable %s %s? It runs %s as you", m.DisplayNameOr(), m.Version, strings.Join(m.Exec, " "))
	perms := m.Permissions.Normalize().Describe()
	if len(perms) == 0 {
		b.WriteString(" and asks for no permissions.")
		return b.String()
	}
	b.WriteString(" and may:")
	for _, p := range perms {
		b.WriteString("\n  - " + p)
	}
	return b.String()
}
