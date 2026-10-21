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
//   - threads.show_created_threads -> thread.Manager.SetShowCreatedThreads on every
//     change (applyShowCreatedThreads): which hidden threads archiving their creator
//     takes with it (the GUI reads the setting itself for the sidebar);
//   - editor command -> gitops' Editor func (stores.go), read on every open.
//   - projects.auto_pull -> the project store's AutoPull.Enabled (autopull.go), read
//     after every scheduled fetch.
//   - github.poll_interval_seconds and github.dashboards_enabled -> the gh store's
//     Config func (stores.go), read before every poll.
//   - update.channel -> update.Store.SetChannel on every change (applyUpdateChannel),
//     which re-checks at once when the channel changed.
//   - ember.* (and threads.show_created_threads) -> the Ember store's Config, read
//     after every change (ConfigChanged; ember.go): on/off, its model and effort, its
//     workers' and its epoch limits.

// applySettings tells the settings store which commands exist (enabling keybinding
// fields and validation) and keeps the registry and log level in sync with it. The
// hook runs before each change is published, so a client that re-lists commands on a
// settings event sees the new keybindings.
func applySettings(st *settings.Store, reg *command.Registry, level *slog.LevelVar, dev bool) {
	listed := reg.List(command.Context{}, true)
	cmds := make([]settings.CommandInfo, len(listed))
	for i, l := range listed {
		cmds[i] = settings.CommandInfo{
			Name: l.Name, Title: l.Title, Description: l.Description, Category: l.Category, Keybindings: l.Keybindings,
			NoKeybinding: l.NoKeybinding,
		}
	}
	st.SetCommands(cmds)
	st.OnChange(func(snap *settings.Snapshot) {
		reg.SetOverrides(registryOverrides(snap.Settings))
		if !dev { // dev mode always logs at debug
			level.Set(logLevel(snap.Settings.Advanced.LogLevel))
		}
	})
}

// registryOverrides maps settings onto command.Overrides.
func registryOverrides(s settings.Settings) command.Overrides {
	return command.Overrides{
		Keybindings: settings.KeybindingOverrides(s.Keybindings),
		ArgDefaults: map[string]map[string]string{
			"thread.new":      {"model": s.Threads.DefaultModel, "effort": s.Threads.DefaultEffort},
			"pr.ask":          {"model": s.Threads.DefaultModel, "effort": s.Threads.DefaultEffort},
			"pr.explain":      {"model": s.Threads.DefaultModel, "effort": s.Threads.DefaultEffort},
			"pr.fix.findings": {"model": s.Threads.DefaultModel, "effort": s.Threads.DefaultEffort},
		},
	}
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
// thread.WithNamingModel.
func settingsNamer(st *settings.Store, next thread.Namer) thread.Namer {
	return func(ctx context.Context, req thread.NamingRequest) (thread.Naming, error) {
		s := st.Settings().Threads
		if !s.AutoName {
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

// cacheTTLSetter is the thread store's live cache TTL (*thread.Manager).
type cacheTTLSetter interface{ SetCacheTTL(time.Duration) }

// applyCacheTTL keeps the thread store's prompt cache lifetime equal to
// threads.cache_ttl_seconds, now and on every settings change.
func applyCacheTTL(st *settings.Store, threads cacheTTLSetter) {
	st.OnChange(func(snap *settings.Snapshot) { threads.SetCacheTTL(snap.Settings.CacheTTL()) })
}

// showCreatedSetter is the thread store's live threads.show_created_threads
// (*thread.Manager).
type showCreatedSetter interface{ SetShowCreatedThreads(bool) }

// applyShowCreatedThreads keeps the thread store's threads.show_created_threads equal
// to the setting, now and on every settings change.
func applyShowCreatedThreads(st *settings.Store, threads showCreatedSetter) {
	st.OnChange(func(snap *settings.Snapshot) { threads.SetShowCreatedThreads(snap.Settings.Threads.ShowCreatedThreads) })
}

// updateChannelSetter is the updater's live channel (*update.Store).
type updateChannelSetter interface{ SetChannel(update.Channel) }

// applyUpdateChannel keeps the updater on update.channel, now and on every settings
// change; SetChannel re-checks in the background when the channel changed.
func applyUpdateChannel(st *settings.Store, u updateChannelSetter) {
	st.OnChange(func(snap *settings.Snapshot) { u.SetChannel(update.ParseChannel(snap.Settings.Update.Channel)) })
}
