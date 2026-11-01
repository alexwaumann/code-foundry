package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Settings consumers. Values the stores read only at start (intervals, scrollback,
// close grace, executable paths) are passed as store options in openStores; the
// settings page marks them "applies after a daemon restart". Everything below applies
// live:
//
//   - keybinding overrides and thread model/effort defaults -> command registry
//     overrides (CommandService.List reports the effective values);
//   - log level -> the log file handler's LevelVar;
//   - auto-naming and the naming model -> a Namer that reads both per thread;
//   - threads.cache_ttl_seconds -> thread.Manager.SetCacheTTL on every change
//     (applyCacheTTL), which republishes the threads whose cache expiry moved;
//   - editor command -> gitops' Editor func (stores.go), read on every open.
//   - projects.auto_pull -> the project store's AutoPull.Enabled (autopull.go), read
//     after every scheduled fetch.
//   - projects.base_from_origin -> project.CreateWorktreeOptions.BaseFromOrigin, read
//     at every new worktree by each caller (baseFromOrigin): the thread store (new
//     and recreated worktrees), the workspace store (members), and ProjectService
//     (CreateWorktree, and ListRefs' default ref).
//   - github.poll_interval_seconds and github.dashboards_enabled -> the gh store's
//     Config func (stores.go), read before every poll.
//   - update.channel -> update.Store.SetChannel on every change (applyUpdateChannel),
//     which re-checks at once when the channel changed.
//   - ember.* -> the Ember store's Config, read
//     after every change (ConfigChanged; ember.go): on/off, its model and effort, its
//     workers' and its epoch limits.
//   - dictation.enabled -> the dictation store's ConfigChanged after every change
//     (dictation.go): on starts the engine with the model loaded, off stops it. The
//     store also writes it: a finished model download turns it on.

// applySettings tells the settings store which commands exist (enabling keybinding
// fields and validation) and keeps the registry and log level in sync with it. The
// hook runs before each change is published, so a client that re-lists commands on a
// settings event sees the new keybindings.
func applySettings(st *settings.Store, reg *command.Registry, level *slog.LevelVar, dev bool) {
	setSettingsCommands(st, reg)
	st.OnChange(func(snap *settings.Snapshot) {
		reg.SetOverrides(registryOverrides(snap.Settings))
		if !dev { // dev mode always logs at debug
			level.Set(logLevel(snap.Settings.Advanced.LogLevel))
		}
	})
}

// threadStarters are the commands that start a thread with a model and effort arg:
// threads.default_model and threads.default_effort are their defaults (each marks a
// value it did not get as defaulted, ModelDefaulted / EffortDefaulted).
var threadStarters = []string{"thread.new", "thread.new-like", "pr.ask", "pr.explain", "pr.fix.findings", "theme.ask"}

// registryOverrides maps settings onto command.Overrides.
func registryOverrides(s settings.Settings) command.Overrides {
	defaults := make(map[string]map[string]string, len(threadStarters))
	for _, name := range threadStarters {
		defaults[name] = map[string]string{"model": s.Threads.DefaultModel, "effort": s.Threads.DefaultEffort}
	}
	return command.Overrides{Keybindings: settings.KeybindingOverrides(s.Keybindings), ArgDefaults: defaults}
}

func logLevel(s string) slog.Level {
	var l slog.Level
	if err := l.UnmarshalText([]byte(s)); err != nil {
		return slog.LevelInfo
	}
	return l
}

// errAutoNameOff is what the namer returns when auto-naming is turned off; the thread
// store leaves the thread unnamed and names a new worktree's branch without the model.
var errAutoNameOff = fmt.Errorf("%w in settings (threads.auto_name)", thread.ErrNamingOff)

// settingsNamer wraps next so threads.auto_name and threads.naming_model apply
// without a restart: each call reads them and hands the model to next with
// thread.WithNamingModel. A call the user asked for (thread.ExplicitNaming: Regenerate
// Name) runs with auto-naming off too; only the naming model applies to it.
func settingsNamer(st *settings.Store, next thread.Namer) thread.Namer {
	return func(ctx context.Context, req thread.NamingRequest) (thread.Naming, error) {
		s := st.Settings().Threads
		if !s.AutoName && !thread.ExplicitNaming(ctx) {
			return thread.Naming{}, errAutoNameOff
		}
		return next(thread.WithNamingModel(ctx, s.NamingModel), req)
	}
}

// branchNaming is the thread store's Options.BranchNaming: projects.branch_naming,
// branch_prefix and branch_instructions, read at every new worktree or workspace so a
// change applies without a restart.
func branchNaming(st *settings.Store) func() thread.BranchNaming {
	return func() thread.BranchNaming {
		p := st.Settings().Projects
		return thread.BranchNaming{Mode: p.BranchNaming, Prefix: p.BranchPrefixValue(), Instructions: p.BranchInstructions}
	}
}

// baseFromOrigin reads projects.base_from_origin at every new worktree, so a change
// applies without a restart.
func baseFromOrigin(st *settings.Store) func() bool {
	return func() bool { return st.Settings().Projects.BaseFromOrigin }
}

// cacheTTLSetter is the thread store's live cache TTL (*thread.Manager).
type cacheTTLSetter interface{ SetCacheTTL(time.Duration) }

// applyCacheTTL keeps the thread store's prompt cache lifetime equal to
// threads.cache_ttl_seconds, now and on every settings change.
func applyCacheTTL(st *settings.Store, threads cacheTTLSetter) {
	st.OnChange(func(snap *settings.Snapshot) { threads.SetCacheTTL(snap.Settings.CacheTTL()) })
}

// updateChannelSetter is the updater's live channel (*update.Store).
type updateChannelSetter interface{ SetChannel(update.Channel) }

// applyUpdateChannel keeps the updater on update.channel, now and on every settings
// change; SetChannel re-checks in the background when the channel changed.
func applyUpdateChannel(st *settings.Store, u updateChannelSetter) {
	st.OnChange(func(snap *settings.Snapshot) { u.SetChannel(update.ParseChannel(snap.Settings.Update.Channel)) })
}
