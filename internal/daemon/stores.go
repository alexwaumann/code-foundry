package daemon

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// stores is the daemon's shared infrastructure (bus, database) and its stores. Each
// store gets one field here and one line in openStores and close.
type stores struct {
	bus *bus.Bus
	// settings is opened first: the other stores take start-time options from it.
	settings *settings.Store
	db       *sql.DB
	repo     *repo.Git
	gh       *gh.Store
	// stopGh cancels the gh poller and the repo→gh tracking glue, and waits for both.
	stopGh func()
	// gitops runs git/gh operations and refreshes repo afterwards; closed before repo.
	gitops *gitops.Manager
	// terminal owns PTYs; closed first so every child gets hung up before the db goes.
	terminal *terminal.Manager
	// session layers Claude sessions on terminal and db; shut down before terminal so
	// live sessions are recorded as disconnected while their processes still run.
	session *session.Manager
	// update checks for and installs new releases (disabled in dev builds).
	update *update.Store
	// workspace holds branch sets across repos; it creates and removes worktrees
	// through repo and asks session which threads are live. Opened before session,
	// which reads workspace members at launch.
	workspace *workspace.Manager
	// home is the user's home directory (symlinks resolved): the root every project
	// path must stay inside, and what FilesystemService completes under.
	home string
}

// openStores opens the database, applies migrations, and starts every store. On
// error, whatever was started is closed again. sessionEnv is added to every Claude
// session's environment (see sessionEnv in daemon.go).
func openStores(ctx context.Context, log *slog.Logger, p paths.Paths, sessionEnv []string) (_ *stores, err error) {
	s := &stores{bus: bus.New()}
	defer func() {
		if err != nil {
			s.close()
		}
	}()
	if s.settings, err = settings.Open(ctx, settings.Options{
		Path: filepath.Join(p.Home(), settings.FileName), Bus: s.bus, Log: log.With("store", "settings"),
	}); err != nil {
		return nil, err
	}
	// Start-time settings (see internal/daemon/settings.go for the live ones).
	cfg := s.settings.Settings()
	if s.db, err = db.Open(ctx, p.DB()); err != nil {
		return nil, err
	}
	if s.home, err = fsx.HomeRoot(); err != nil {
		return nil, err
	}
	if s.repo, err = repo.Start(ctx, repo.Options{
		DB: s.db, Bus: s.bus, Log: log, WorktreeRoot: p.Worktrees(), AllowedRoot: s.home, FetchInterval: cfg.FetchInterval(),
	}); err != nil {
		return nil, err
	}
	// CODE_FOUNDRY_GH_SEARCH_AS is a development aid (see gh.Options.SearchAs).
	// The github.* settings apply live: the store reads them before every poll.
	ghOpts := gh.Options{
		DB: s.db, Bus: s.bus, Log: log.With("store", "gh"), PollInterval: cfg.GhPollInterval(),
		SearchAs: os.Getenv("CODE_FOUNDRY_GH_SEARCH_AS"),
		Config: func() gh.Config {
			c := s.settings.Settings()
			return gh.Config{PollInterval: c.GhPollInterval(), Dashboards: c.GitHub.DashboardsEnabled}
		},
	}
	// GitHub is reached over HTTP with the token `gh auth token` prints.
	ghOpts.Runner = gh.NewHTTPRunner(gh.HTTPOptions{
		Tokens:    gh.GhToken{Path: settings.ExpandedPath(cfg.Advanced.GhPath)},
		UserAgent: "code-foundry/" + version.Version,
		Log:       ghOpts.Log,
	})
	if s.gh, err = gh.New(ctx, ghOpts); err != nil {
		return nil, err
	}
	s.stopGh = startGh(ctx, log, s.gh, s.repo, s.bus)
	s.gitops = gitops.New(gitops.Options{
		Bus: s.bus, Repos: s.repo, Log: log.With("store", "gitops"),
		// Read on every open, so gitops.editor_command applies live. CODE_FOUNDRY_EDITOR
		// is the fallback when the setting is empty; both empty means auto-detect.
		Editor: func() string {
			return cmp.Or(s.settings.Settings().GitOps.EditorCommand, os.Getenv("CODE_FOUNDRY_EDITOR"))
		},
	})
	s.terminal = terminal.New(terminal.Options{
		Bus: s.bus, Logger: log.With("store", "terminal"), MaxScrollbackLines: uint(cfg.Sessions.ScrollbackLines),
	})
	// Workspaces open before sessions: a session reads a workspace thread's members at
	// every spawn, and the workspace store asks sessions about live threads (and
	// pre-trusts worktrees) only through these closures, which run after both exist.
	if s.workspace, err = workspace.New(ctx, workspace.Options{
		DB: s.db, Repos: s.repo, Bus: s.bus, Log: log.With("store", "workspace"),
		Threads: func() []workspace.Thread {
			if s.session == nil {
				return nil
			}
			return liveThreads(s.session.Snapshot())
		},
		Trust: func(dir string) error {
			if s.session == nil {
				return nil
			}
			return s.session.PreTrust(dir)
		},
		WorktreePath: settingsWorktreePath(s.settings),
	}); err != nil {
		return nil, err
	}
	claude := cmp.Or(settings.ExpandedPath(cfg.Advanced.ClaudePath), "claude")
	if s.session, err = session.New(ctx, session.Options{
		DB: s.db, Terminals: s.terminal, Repos: s.repo, Workspaces: s.workspace, Bus: s.bus, Log: log.With("store", "session"),
		NewDetector: newDetector, Claude: claude, CloseTimeout: cfg.CloseGrace(),
		Namer:          settingsNamer(s.settings, session.ClaudeNamer(claude, "/tmp")),
		AttachmentsDir: p.Attachments(), WorktreePath: settingsWorktreePath(s.settings),
		Env: sessionEnv,
	}); err != nil {
		return nil, err
	}
	uo := update.DefaultOptions(version.Version)
	uo.Bus, uo.Log = s.bus, log.With("store", "update")
	s.update = update.Start(ctx, uo)
	return s, nil
}

// liveThreads lists the sessions with a process, for the workspace store's removal
// guard.
func liveThreads(snap *session.Snapshot) []workspace.Thread {
	var out []workspace.Thread
	if snap == nil {
		return nil
	}
	for _, s := range snap.Sessions {
		if s.State != session.StateDisconnected {
			out = append(out, workspace.Thread{ID: s.ID, Name: s.Name, Cwd: s.WorktreePath})
		}
	}
	return out
}

// close stops the stores in reverse order of start, then closes the database.
func (s *stores) close() error {
	var errs []error
	if s.update != nil {
		s.update.Close()
	}
	if s.session != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.session.Shutdown(closeCtx))
		cancel()
	}
	if s.terminal != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.terminal.Close(closeCtx))
		cancel()
	}
	if s.gitops != nil {
		errs = append(errs, s.gitops.Close())
	}
	if s.stopGh != nil {
		s.stopGh()
	}
	if s.repo != nil {
		errs = append(errs, s.repo.Close())
	}
	if s.db != nil {
		errs = append(errs, s.db.Close())
	}
	if s.settings != nil {
		errs = append(errs, s.settings.Close())
	}
	return errors.Join(errs...)
}
