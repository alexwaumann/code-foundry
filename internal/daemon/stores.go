package daemon

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
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
	// cloner clones GitHub repositories into the projects dir and registers them in
	// repo. It holds no resources: a clone in flight dies with its request.
	cloner *clone.Cloner
	// projects creates new projects in the projects dir and publishes projects to
	// GitHub with gh; like cloner, it holds no resources.
	projects *project.Store
	// stopGh cancels the gh poller and the repo→gh tracking glue, and waits for both.
	stopGh func()
	// gitops runs git/gh operations and refreshes repo afterwards; closed before repo.
	gitops *gitops.Manager
	// terminal owns PTYs; closed first so every child gets hung up before the db goes.
	terminal *terminal.Manager
	// stopShells stops the shell reaper (shells.go): exited shells and the shells of a
	// removed worktree are removed. Stopped before terminal closes.
	stopShells func()
	// session layers Claude sessions on terminal and db; shut down before terminal so
	// live sessions are recorded as disconnected while their processes still run.
	session *thread.Manager
	// update checks for and installs new releases (disabled in dev builds).
	update *update.Store
	// workspace holds branch sets across repos; it creates and removes worktrees
	// through repo and asks session which threads are live. Opened before session,
	// which reads workspace members at launch.
	workspace *workspace.Manager
	// action holds each project's actions and runs them (in a terminal, or in the
	// background). Opened before session (whose new worktrees run on-worktree-create
	// actions) and closed before it, killing background runs.
	action *action.Manager
	// stopActions stops the glue that forgets an unregistered project's actions and
	// kills a removed thread's or worktree's background runs (actions.go).
	stopActions func()
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
		ManagedRoots: settingsManagedRoots(s.settings),
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
	// Clones use the configured gh, else PATH, else Homebrew's (gh.LookPath), like the
	// token lookup.
	ghBin := settings.ExpandedPath(cfg.Advanced.GhPath)
	if ghBin == "" {
		ghBin, _ = gh.LookPath() // "" when missing: the clone then fails saying so
	}
	if s.cloner, err = clone.New(clone.Options{
		Root: p.Projects(), AllowedRoot: s.home, Repos: s.repo, Gh: ghBin, Log: log.With("store", "clone"),
	}); err != nil {
		return nil, err
	}
	if s.projects, err = project.New(project.Options{
		Root: p.Projects(), AllowedRoot: s.home, Repos: s.repo, Gh: ghBin, Log: log.With("store", "project"),
	}); err != nil {
		return nil, err
	}
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
	// every spawn, and the workspace store asks sessions about their threads (and
	// pre-trusts worktrees) only through these closures, which run after both exist.
	if s.workspace, err = workspace.New(ctx, workspace.Options{
		DB: s.db, Repos: s.repo, Bus: s.bus, Log: log.With("store", "workspace"),
		Threads: func() []workspace.Thread {
			if s.session == nil {
				return nil
			}
			return worktreeThreads(s.session.Snapshot())
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
	if s.action, err = action.New(ctx, action.Options{
		DB: s.db, Repos: s.repo, Terminals: s.terminal, Bus: s.bus, Log: log.With("store", "action"),
		Session: func(id string) (action.Owner, bool) {
			if s.session == nil {
				return action.Owner{}, false
			}
			return sessionOwner(s.session.Snapshot(), id)
		},
	}); err != nil {
		return nil, err
	}
	claude := cmp.Or(settings.ExpandedPath(cfg.Advanced.ClaudePath), "claude")
	sessionLog := log.With("store", "session")
	if s.session, err = thread.New(ctx, thread.Options{
		DB: s.db, Terminals: s.terminal, Repos: s.repo, Workspaces: s.workspace, Bus: s.bus, Log: sessionLog,
		Claude: claude, CloseTimeout: cfg.CloseGrace(),
		Namer:          settingsNamer(s.settings, thread.ClaudeNamer(claude, "/tmp", sessionLog)),
		AttachmentsDir: p.Attachments(), WorktreePath: settingsWorktreePath(s.settings),
		Env: sessionEnv, CacheTTL: cfg.CacheTTL(),
		// Development aids: how long a thread's process stays up at least, and how often
		// idle threads are checked against their cache expiry (Go durations; unset or
		// invalid: the defaults, 5m and 30s). See docs/notes/thread-lifecycle.md.
		IdleGrace:         envDuration(log, "CODE_FOUNDRY_IDLE_GRACE"),
		IdleCheckInterval: envDuration(log, "CODE_FOUNDRY_IDLE_CHECK"),
		// A new thread's worktree runs its project's on-worktree-create actions in the
		// background (WorktreeCreated returns at once).
		WorktreeCreated: s.action.WorktreeCreated,
	}); err != nil {
		return nil, err
	}
	applyCacheTTL(s.settings, s.session)
	// After session: the reaper's sweep asks it which threads exist.
	if s.stopShells, err = startShellReaper(ctx, shellReaperOptions{
		Log: log.With("store", "terminal"), Terminals: s.terminal, Bus: s.bus,
		RepoExists: func(id string) bool { _, ok := s.repo.Snapshot().Repo(id); return ok },
		SessionExists: func(id string) bool {
			snap := s.session.Snapshot()
			return snap == nil || slices.ContainsFunc(snap.Sessions, func(x thread.Session) bool { return x.ID == id })
		},
	}); err != nil {
		return nil, err
	}
	s.stopActions = startActionCleanup(ctx, log.With("store", "action"), s.action, s.bus)
	uo := update.DefaultOptions(version.Version)
	uo.Bus, uo.Log = s.bus, log.With("store", "update")
	uo.Channel = update.ParseChannel(cfg.Update.Channel)
	s.update = update.Start(ctx, uo)
	applyUpdateChannel(s.settings, s.update)
	return s, nil
}

// envDuration is the Go duration in the environment variable name, 0 when it is unset
// or invalid (logged).
func envDuration(log *slog.Logger, name string) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return 0
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		log.Warn("ignoring an invalid duration", "env", name, "value", v)
		return 0
	}
	log.Info("development setting from the environment", "env", name, "value", d.String())
	return d
}

// sessionOwner is thread id's project and worktree, the owner of its action runs.
func sessionOwner(snap *thread.Snapshot, id string) (action.Owner, bool) {
	if snap == nil {
		return action.Owner{}, false
	}
	i := slices.IndexFunc(snap.Sessions, func(x thread.Session) bool { return x.ID == id })
	if i < 0 {
		return action.Owner{}, false
	}
	return action.Owner{SessionID: id, RepoID: snap.Sessions[i].RepoID, Worktree: snap.Sessions[i].WorktreePath}, true
}

// worktreeThreads lists the threads that own their cwd, for the cleanup rule and the
// workspace store's removal guards: every thread but an archived one, whatever its state
// (a stopped thread looks like any other in the GUI and a message starts it again in the
// same worktree; a snoozed one comes back to it).
func worktreeThreads(snap *thread.Snapshot) []workspace.Thread {
	var out []workspace.Thread
	if snap == nil {
		return nil
	}
	for _, s := range snap.Sessions {
		if s.ArchivedAt.IsZero() {
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
	if s.stopShells != nil {
		s.stopShells()
	}
	if s.stopActions != nil {
		s.stopActions()
	}
	if s.action != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.action.Close(closeCtx))
		cancel()
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
