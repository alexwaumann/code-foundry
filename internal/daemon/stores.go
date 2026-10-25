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
	"github.com/alexwaumann/code-foundry/internal/presence"
	"github.com/alexwaumann/code-foundry/internal/store/action"
	"github.com/alexwaumann/code-foundry/internal/store/backdrop"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
	"github.com/alexwaumann/code-foundry/internal/store/newproject"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// stores is the daemon's shared infrastructure (bus, database) and its stores. Each
// store gets one field here and one line in openStores and close.
type stores struct {
	bus *bus.Bus
	// settings is opened first: the other stores take start-time options from it.
	settings *settings.Store
	// backdrops keeps the user's backdrop images and selects them through settings; it
	// holds no resources.
	backdrops *backdrop.Store
	db        *sql.DB
	project   *project.Git
	gh        *gh.Store
	// cloner clones GitHub repositories into the projects dir and registers them in
	// project. It holds no resources: a clone in flight dies with its request.
	cloner *clone.Cloner
	// projects creates new projects in the projects dir and publishes projects to
	// GitHub with gh; like cloner, it holds no resources.
	newProjects *newproject.Store
	// stopGh cancels the gh poller and the project→gh tracking glue, and waits for both.
	stopGh func()
	// gitops runs git/gh operations and refreshes project afterwards; closed before project.
	gitops *gitops.Manager
	// terminal owns PTYs; closed first so every child gets hung up before the db goes.
	terminal *terminal.Manager
	// stopShells stops the shell reaper (shells.go): exited shells and the shells of a
	// removed worktree are removed. Stopped before terminal closes.
	stopShells func()
	// thread layers Claude sessions on terminal and db; shut down before terminal so
	// live threads are recorded as disconnected while their processes still run.
	thread *thread.Manager
	// ember is the resident agent's store (ember.go); closed before thread.
	ember *ember.Store
	// memory is the app memory (<home>/memory/), the user's standing preferences:
	// thread reads it at every spawn, the memory.* commands write it, MemoryService and
	// EventService watch its snapshots. It holds no resources.
	memory *memory.Store
	// themes is the user's colour themes (<home>/themes/, docs/notes/user-themes.md): the
	// theme.* commands write it, the settings store validates the theme slots against it
	// (OnChange, before it publishes), ThemeService and EventService watch its snapshots.
	// Its watch ends with the daemon's context.
	themes *usertheme.Store
	// update checks for and installs new releases (disabled in dev builds).
	update *update.Store
	// skills reads the Skills marketplaces Claude Code has and what is installed
	// (skill_registry.go); it holds no resources.
	skills *skill.Store
	// workspace holds saved project sets and their managed dirs; opened before thread,
	// whose spawns read the workspace a thread references.
	workspace *workspace.Manager
	// action holds each project's actions and runs them (in a terminal, or in the
	// background). Opened before thread (whose new worktrees run on-worktree-create
	// actions) and closed before it, killing background runs.
	action *action.Manager
	// stopActions stops the glue that forgets an unregistered project's actions and
	// kills a removed thread's or worktree's background runs (actions.go).
	stopActions func()
	// stopWake stops the glue that hands every action run's end to the threads' wake
	// subscriptions (wake.go).
	stopWake func()
	// stopWakePRs stops the glue that hands every pull request change the GitHub poll
	// sees to the threads' wake subscriptions (wake_pr.go).
	stopWakePRs func()
	// stopProjectActivity stops the glue that tells project which worktrees have live
	// threads and when a thread edited files (projectactivity.go).
	stopProjectActivity func()
	// archived removes an archived thread's derived worktrees nobody else has, in the
	// background (cleanup_archived.go); stopped after thread, before project.
	archived *archiveCleaner
	// stopBranchLinks stops the glue that links each thread to the pull requests on its
	// branches, from the GitHub store's cached lists (linked_prs_branch.go).
	stopBranchLinks func()
	// home is the user's home directory (symlinks resolved): the root every project
	// path must stay inside, and what FilesystemService completes under.
	home string
}

// openStores opens the database, applies migrations, and starts every store. On
// error, whatever was started is closed again. threadEnv is added to every Claude
// process's environment (see threadEnv in daemon.go). pres is the GUI presence: its
// kind paces the GitHub poll (gh.Options.Presence), and whether it is attended decides
// whether an open thread view counts as seen (thread.Options.Attended).
func openStores(ctx context.Context, log *slog.Logger, p paths.Paths, threadEnv []string, pres *presence.Tracker) (_ *stores, err error) {
	s := &stores{bus: bus.New()}
	defer func() {
		if err != nil {
			s.close()
		}
	}()
	// The user's themes are read before the settings, so a theme slot naming one of them
	// is valid from the first snapshot (and Open logs no false "value ignored").
	// Past the file cap the themes the slots name are read first, from settings.toml as
	// written (the store opens after this one).
	settingsPath := filepath.Join(p.Home(), settings.FileName)
	s.themes = usertheme.New(usertheme.Options{Dir: p.Themes(), Bus: s.bus, Log: log.With("store", "themes"),
		InUse: func() []string { return settings.ThemeSlots(settingsPath) }})
	s.themes.Load()
	if s.settings, err = settings.Open(ctx, settings.Options{
		Path: settingsPath, Bus: s.bus, Log: log.With("store", "settings"),
		BackdropsDir: p.Backdrops(), Themes: s.themes.Snapshot().Set(),
	}); err != nil {
		return nil, err
	}
	s.themes.OnChange(func(snap *usertheme.Snapshot) { s.settings.SetThemes(snap.Set()) })
	s.themes.Watch(ctx)
	s.backdrops = backdrop.New(backdrop.Options{Dir: p.Backdrops(), Settings: s.settings, Log: log.With("store", "backdrop")})
	// Start-time settings (see internal/daemon/settings.go for the live ones).
	cfg := s.settings.Settings()
	if s.db, err = db.Open(ctx, p.DB()); err != nil {
		return nil, err
	}
	if s.home, err = fsx.HomeRoot(); err != nil {
		return nil, err
	}
	if s.project, err = project.Start(ctx, project.Options{
		DB: s.db, Bus: s.bus, Log: log, WorktreeRoot: p.Worktrees(), AllowedRoot: s.home, FetchInterval: cfg.FetchInterval(),
	}); err != nil {
		return nil, err
	}
	// CODE_FOUNDRY_GH_SEARCH_AS is a development aid (see gh.Options.SearchAs).
	// The github.* settings apply live: the store reads them before every poll.
	ghOpts := gh.Options{
		DB: s.db, Bus: s.bus, Log: log.With("store", "gh"), PollInterval: cfg.GhPollInterval(),
		SearchAs: os.Getenv("CODE_FOUNDRY_GH_SEARCH_AS"),
		Presence: func() gh.Presence { return pres.Current().Kind },
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
	s.stopGh = startGh(ctx, log, s.gh, s.project, s.bus)
	// Clones use the configured gh, else PATH, else Homebrew's (gh.LookPath), like the
	// token lookup.
	ghBin := settings.ExpandedPath(cfg.Advanced.GhPath)
	if ghBin == "" {
		ghBin, _ = gh.LookPath() // "" when missing: the clone then fails saying so
	}
	if s.cloner, err = clone.New(clone.Options{
		Root: p.Projects(), AllowedRoot: s.home, Projects: s.project, Gh: ghBin, Log: log.With("store", "clone"),
	}); err != nil {
		return nil, err
	}
	if s.newProjects, err = newproject.New(newproject.Options{
		Root: p.Projects(), AllowedRoot: s.home, Projects: s.project, Gh: ghBin, Log: log.With("store", "project"),
	}); err != nil {
		return nil, err
	}
	s.gitops = gitops.New(gitops.Options{
		Bus: s.bus, Projects: s.project, Log: log.With("store", "gitops"),
		// Read on every open, so gitops.editor_command applies live. CODE_FOUNDRY_EDITOR
		// is the fallback when the setting is empty; both empty means auto-detect.
		Editor: func() string {
			return cmp.Or(s.settings.Settings().GitOps.EditorCommand, os.Getenv("CODE_FOUNDRY_EDITOR"))
		},
	})
	s.terminal = terminal.New(terminal.Options{
		Bus: s.bus, Logger: log.With("store", "terminal"), MaxScrollbackLines: uint(cfg.Threads.ScrollbackLines),
	})
	// Workspaces open before threads: a spawn of a thread that references one reads it
	// (and re-checks its managed dir). New makes every managed dir.
	if s.workspace, err = workspace.New(ctx, workspace.Options{
		DB: s.db, Projects: s.project, Dir: p.Workspaces(), Home: s.home, Bus: s.bus, Log: log.With("store", "workspace"),
	}); err != nil {
		return nil, err
	}
	if s.action, err = action.New(ctx, action.Options{
		DB: s.db, Projects: s.project, Terminals: s.terminal, Bus: s.bus, Log: log.With("store", "action"),
		Thread: func(id string) (action.Owner, bool) {
			if s.thread == nil {
				return action.Owner{}, false
			}
			return threadOwner(s.thread.Snapshot(), id)
		},
	}); err != nil {
		return nil, err
	}
	claude := cmp.Or(settings.ExpandedPath(cfg.Advanced.ClaudePath), "claude")
	s.memory = memory.New(memory.Options{Dir: p.Memory(), Legacy: p.LegacyMemory(), Bus: s.bus, Log: log.With("store", "memory")})
	// The single memory.md before the directory goes into it once (docs/notes/memory-dir.md);
	// a failure leaves the file for the next start and the daemon runs on.
	if _, err := s.memory.Import(); err != nil {
		log.Warn("memory: the single memory file was not imported; it stays for the next start", "err", err)
	}
	s.memory.Load()
	// Hand edits reach the Settings page within a moment (docs/notes/memory-fixes-2.md).
	s.memory.Watch(ctx)
	s.archived = &archiveCleaner{
		log: log.With("store", "thread"), projects: s.project,
		checkouts:  func(t thread.Thread) []thread.Checkout { return s.thread.CheckoutsOf(t) },
		threads:    func() *thread.Snapshot { return s.thread.Snapshot() },
		terminals:  func() []terminal.Terminal { return s.terminal.List(context.Background()) },
	}
	s.archived.ctx, s.archived.cancel = context.WithCancel(context.WithoutCancel(ctx))
	threadLog := log.With("store", "thread")
	if s.thread, err = thread.New(ctx, thread.Options{
		DB: s.db, Terminals: s.terminal, Projects: s.project, Workspaces: s.workspace, Bus: s.bus, Log: threadLog,
		Claude: claude, CloseTimeout: cfg.CloseGrace(),
		Namer:          settingsNamer(s.settings, thread.ClaudeNamer(claude, "/tmp", threadLog)),
		BranchNaming:   branchNaming(s.settings),
		BaseFromOrigin: baseFromOrigin(s.settings),
		AttachmentsDir: p.Attachments(), SkillsDir: p.Claude(), Env: threadEnv, CacheTTL: cfg.CacheTTL(),
		// The user's standing preferences, read at every spawn into the system prompt
		// (docs/notes/control-3-app-memory.md).
		Memory: s.memory.Injected,
		// Development aids: how long a thread's process stays up at least, and how often
		// idle threads are checked against their cache expiry (Go durations; unset or
		// invalid: the defaults, 5m and 30s). See docs/notes/thread-lifecycle.md.
		IdleGrace:         envDuration(log, "CODE_FOUNDRY_IDLE_GRACE"),
		IdleCheckInterval: envDuration(log, "CODE_FOUNDRY_IDLE_CHECK"),
		// A new thread's worktree runs its project's on-worktree-create actions in the
		// background (WorktreeCreated returns at once).
		WorktreeCreated: s.action.WorktreeCreated,
		// A thread whose worktree a cleanup removed gets it back under this root when it
		// starts again (recreate.go).
		WorktreeRoot: p.Worktrees(),
		// Each thread's TMPDIR is <home>/tmp/<thread id> (childcontext.go).
		TmpRoot: p.Tmp(),
		// And the pages it shows go in <home>/pages/<thread id> (childcontext.go).
		PagesRoot: p.Pages(),
		// And what those pages keep with cf.storage in <home>/page-storage/<thread id> (pagestorage.go).
		PageStorageRoot: p.PageStorage(),
		// Wake subscriptions to action runs read them here (wake.go).
		ActionRun: actionRunForWake(s.action),
		// Wake subscriptions to pull requests read the GitHub store's cache and keep
		// their pull requests in its poll (wake_pr.go).
		PullRequest:       pullRequestForWake(s.gh),
		WatchPullRequests: watchPullRequestsForWake(log.With("store", "gh"), s.gh),
		// An archived thread's derived worktrees nobody else has go (cleanup_archived.go).
		Archived: s.archived.archived,
		// An open thread view counts as the user seeing the thread only while a GUI
		// window is visible and key (docs/notes/alerts-foreground.md).
		Attended: func() bool { return pres.Current().Attended },
	}); err != nil {
		return nil, err
	}
	applyCacheTTL(s.settings, s.thread)
	applyShowCreatedThreads(s.settings, s.thread)
	// After thread and project: Ember's resident thread is made (when it is on) and its
	// hooks set before anything can start it (ember.go).
	if s.ember, err = openEmber(ctx, log.With("store", "ember"), p, s.db, s.bus, s.settings, s.thread, s.project, claude); err != nil {
		return nil, err
	}
	// After thread: the reaper's sweep asks it which threads exist.
	if s.stopShells, err = startShellReaper(ctx, shellReaperOptions{
		Log: log.With("store", "terminal"), Terminals: s.terminal, Bus: s.bus,
		ProjectExists: func(id string) bool { _, ok := s.project.Snapshot().Project(id); return ok },
		ThreadExists: func(id string) bool {
			snap := s.thread.Snapshot()
			return snap == nil || slices.ContainsFunc(snap.Threads, func(x thread.Thread) bool { return x.ID == id })
		},
	}); err != nil {
		return nil, err
	}
	s.stopActions = startActionCleanup(ctx, log.With("store", "action"), s.action, s.bus)
	s.stopWake = startWakeRuns(ctx, log.With("store", "thread"), s.thread, s.bus)
	s.stopWakePRs = startWakePullRequests(ctx, log.With("store", "thread"), s.thread, s.bus)
	s.stopProjectActivity = startProjectActivity(ctx, log.With("store", "project"), s.thread.Snapshot, s.project, s.bus)
	// Once thread, action and gitops exist: they decide what a scheduled fetch's auto
	// pull leaves alone, and gitops runs the pull (autopull.go).
	s.project.SetAutoPull(autoPullHooks(autoPullSources{
		enabled: autoPullEnabled(s.settings), threads: s.thread.Snapshot, actions: s.action.Snapshot, ops: s.gitops,
	}))
	s.stopBranchLinks = startBranchLinks(ctx, log.With("store", "thread"), s.thread, s.project.Snapshot, s.gh, s.bus)
	uo := update.DefaultOptions(version.Version)
	uo.Bus, uo.Log = s.bus, log.With("store", "update")
	uo.Channel = update.ParseChannel(cfg.Update.Channel)
	s.update = update.Start(ctx, uo)
	applyUpdateChannel(s.settings, s.update)
	if s.skills, err = newSkillStore(p, s.db, s.bus, s.settings, log.With("store", "skill")); err != nil {
		return nil, err
	}
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

// threadOwner is thread id's project and worktree, the owner of its action runs.
func threadOwner(snap *thread.Snapshot, id string) (action.Owner, bool) {
	if snap == nil {
		return action.Owner{}, false
	}
	i := slices.IndexFunc(snap.Threads, func(x thread.Thread) bool { return x.ID == id })
	if i < 0 {
		return action.Owner{}, false
	}
	return action.Owner{ThreadID: id, ProjectID: snap.Threads[i].ProjectID, Worktree: snap.Threads[i].WorktreePath}, true
}

// worktreeThreads lists the threads that own their cwd, for the cleanup rule and the
// workspace store's removal guards: every thread but an archived one, whatever its state
// (a stopped thread looks like any other in the GUI and a message starts it again in the
// same worktree; a snoozed one comes back to it).
func worktreeThreads(snap *thread.Snapshot) []holder {
	var out []holder
	if snap == nil {
		return nil
	}
	for _, s := range snap.Threads {
		if s.ArchivedAt.IsZero() {
			out = append(out, holder{ID: s.ID, Name: s.Name, Cwd: s.WorktreePath})
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
	if s.stopWake != nil {
		s.stopWake()
	}
	if s.stopWakePRs != nil {
		s.stopWakePRs()
	}
	if s.stopProjectActivity != nil {
		s.stopProjectActivity()
	}
	if s.stopBranchLinks != nil {
		s.stopBranchLinks()
	}
	if s.ember != nil {
		s.ember.Close()
	}
	if s.action != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.action.Close(closeCtx))
		cancel()
	}
	if s.thread != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		errs = append(errs, s.thread.Shutdown(closeCtx))
		cancel()
	}
	if s.archived != nil {
		s.archived.stop()
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
	if s.project != nil {
		errs = append(errs, s.project.Close())
	}
	if s.db != nil {
		errs = append(errs, s.db.Close())
	}
	if s.settings != nil {
		errs = append(errs, s.settings.Close())
	}
	return errors.Join(errs...)
}
