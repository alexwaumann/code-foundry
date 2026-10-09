package daemon

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// Settings consumers. Values the stores read only at start (intervals, scrollback,
// close grace, executable paths) are passed as store options in openStores; the
// settings page marks them "applies after a daemon restart". Everything below applies
// live:
//
//   - keybinding overrides and session model/effort defaults -> command registry
//     overrides (CommandService.List reports the effective values);
//   - log level -> the log file handler's LevelVar;
//   - auto-naming -> a Namer that checks the current value per session;
//   - worktree directory -> repo.worktree.new's default path.
//   - editor command -> gitops' Editor func (stores.go), read on every open.
//   - github.poll_interval_seconds and github.dashboards_enabled -> the gh store's
//     Config func (stores.go), read before every poll.

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
			"session.new": {"model": s.Sessions.DefaultModel, "effort": s.Sessions.DefaultEffort},
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

// errAutoNameOff is what the namer returns when auto-naming is turned off; the session
// store logs it and leaves the session unnamed.
var errAutoNameOff = errors.New("auto-naming is turned off in settings (sessions.auto_name)")

// settingsNamer wraps next so sessions.auto_name applies without a restart.
func settingsNamer(st *settings.Store, next session.Namer) session.Namer {
	return func(ctx context.Context, msg string) (string, error) {
		if !st.Settings().Sessions.AutoName {
			return "", errAutoNameOff
		}
		return next(ctx, msg)
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
			if p := worktreePath(w.settings.Settings().Repos.WorktreeDir, r.Name, req.Msg.GetBranch()); p != "" {
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
	if dir == "" || branch == "" {
		return ""
	}
	base := settings.ExpandedPath(strings.ReplaceAll(dir, "{repo}", repoName))
	if base == "" {
		return ""
	}
	return filepath.Join(base, strings.ReplaceAll(branch, "/", "-"))
}
