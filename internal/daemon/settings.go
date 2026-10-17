package daemon

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
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
//   - worktree directory -> repo.worktree.new's default path, and the path of the
//     worktree a new thread creates (thread.Options.WorktreePath).
//   - editor command -> gitops' Editor func (stores.go), read on every open.
//   - github.poll_interval_seconds and github.dashboards_enabled -> the gh store's
//     Config func (stores.go), read before every poll.
//   - update.channel -> update.Store.SetChannel on every change (applyUpdateChannel),
//     which re-checks at once when the channel changed.

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
// store logs it and leaves the thread unnamed.
var errAutoNameOff = errors.New("auto-naming is turned off in settings (threads.auto_name)")

// settingsNamer wraps next so threads.auto_name and threads.naming_model apply
// without a restart: each call reads them and hands the model to next with
// thread.WithNamingModel.
func settingsNamer(st *settings.Store, next thread.Namer) thread.Namer {
	return func(ctx context.Context, msg string) (string, error) {
		s := st.Settings().Threads
		if !s.AutoName {
			return "", errAutoNameOff
		}
		return next(thread.WithNamingModel(ctx, s.NamingModel), msg)
	}
}

// settingsWorktreePath applies repos.worktree_dir to the worktrees the thread store
// makes for new threads (thread.Options.WorktreePath), the same way worktreeDirRepo
// does for repo.worktree.new. "" leaves the repo store's default.
func settingsWorktreePath(st *settings.Store) func(repo.Repo, string) string {
	return func(r repo.Repo, branch string) string {
		return worktreePath(st.Settings().Repos.WorktreeDir, r.Name, branch)
	}
}

// worktreeDirRepo applies repos.worktree_dir to repo.worktree.new: when the request has
// no explicit path and the setting is set, the worktree goes to
// <dir with {repo} expanded>/<branch, "/" -> "-">.
type worktreeDirRepo struct {
	command.RepoBackend
	repos    *repo.Git
	settings *settings.Store
}

func (w worktreeDirRepo) CreateWorktree(ctx context.Context, req *connect.Request[v1.CreateWorktreeRequest]) (*connect.Response[v1.CreateWorktreeResponse], error) {
	if req.Msg.GetPath() == "" {
		if r, ok := w.repos.Snapshot().Repo(req.Msg.GetRepoId()); ok {
			if p := settingsWorktreePath(w.settings)(r, req.Msg.GetBranch()); p != "" {
				m := proto.CloneOf(req.Msg)
				m.Path = p
				req = connect.NewRequest(m)
			}
		}
	}
	return w.RepoBackend.CreateWorktree(ctx, req)
}

// worktreePath is dir (~ and {repo} expanded) joined with the branch's directory name,
// or "" when dir is unset or the branch is empty.
func worktreePath(dir, repoName, branch string) string {
	base := worktreeBase(dir, repoName)
	if base == "" || branch == "" {
		return ""
	}
	return filepath.Join(base, strings.ReplaceAll(branch, "/", "-"))
}

// worktreeBase is dir with ~ and {repo} expanded: where repos.worktree_dir puts the
// worktrees of repoName. "" when dir is unset.
func worktreeBase(dir, repoName string) string {
	if dir == "" {
		return ""
	}
	return settings.ExpandedPath(strings.ReplaceAll(dir, "{repo}", repoName))
}

// settingsManagedRoots is repo.Options.ManagedRoots: besides the worktrees directory,
// the repos.worktree_dir setting's directory for the repository (read live), so the
// worktrees the app made there count as its own for cleanup.
func settingsManagedRoots(st *settings.Store) func(string) []string {
	return func(repoName string) []string {
		if base := worktreeBase(st.Settings().Repos.WorktreeDir, repoName); base != "" {
			return []string{base}
		}
		return nil
	}
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
