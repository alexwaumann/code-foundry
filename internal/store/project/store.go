package project

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// Defaults for Options.
const (
	DefaultWorkers       = 4
	DefaultDebounce      = 300 * time.Millisecond
	DefaultFetchInterval = 2 * time.Minute
	// DefaultTreeDebounce is longer than DefaultDebounce: a dev server or build
	// writing continuously costs at most one `git status` per second per worktree.
	DefaultTreeDebounce = time.Second
	// DefaultPollInterval is a backstop: the FSEvents stream sees edits anywhere in a
	// worktree, so the poll only covers what it cannot (fsevents-watcher.md).
	DefaultPollInterval = 2 * time.Minute
	// fetchTimeout bounds one `git fetch`; worktreeTimeout bounds worktree add/remove,
	// which may check out or delete a large tree.
	fetchTimeout    = 2 * time.Minute
	worktreeTimeout = 5 * time.Minute
	// startFetchTimeout bounds CreateWorktree's fetch of its start point: the user is
	// waiting, and a stale start point is better than a long hang.
	startFetchTimeout = 20 * time.Second
)

// Options configures Start.
type Options struct {
	DB  *sql.DB  // required; holds the projects table
	Bus *bus.Bus // required; receives Event values
	// WorktreeRoot is where CreateWorktree puts every worktree:
	// <WorktreeRoot>/<owner>/<repo>/<branch>. Required, absolute. Being inside it does not
	// make a worktree Managed; CreateWorktree recording it does (made.go).
	WorktreeRoot string
	// AllowedRoot is the directory every registered project must resolve inside
	// (symlinks followed). Empty means the user's home directory; tests set a temp dir.
	AllowedRoot string
	Log         *slog.Logger
	// Runner runs git. Defaults to ExecRunner{}.
	Runner Runner
	// Workers bounds concurrent git refresh jobs. Defaults to DefaultWorkers.
	Workers int
	// Debounce is the per-job coalescing window for fs events in git's directories
	// (HEAD, index, logs, refs, admin dirs), rescans, and a known directory going
	// away. Zero means DefaultDebounce.
	Debounce time.Duration
	// TreeDebounce is the per-worktree coalescing window for fs events in a
	// worktree's tree (its files, at any depth). Zero means DefaultTreeDebounce.
	TreeDebounce time.Duration
	// FetchInterval is how often each live project runs `git fetch --prune`
	// (activity.go). Zero means DefaultFetchInterval; negative disables fetching.
	FetchInterval time.Duration
	// IdleFetchInterval is how often each idle project is fetched. Zero means
	// DefaultIdleFetchInterval; it is never shorter than FetchInterval.
	IdleFetchInterval time.Duration
	// PollInterval is a backstop status refresh of every worktree of a live project,
	// for changes the FSEvents stream cannot see (a ref moved in a packed or reftable
	// store, a stream that failed to start). Zero means DefaultPollInterval; negative
	// disables polling.
	PollInterval time.Duration
	// IdlePollInterval is the backstop poll of an idle project. Zero means
	// DefaultIdlePollInterval; it is never shorter than PollInterval.
	IdlePollInterval time.Duration
	// TouchDebounce is Touch's per-worktree coalescing window. Zero means
	// DefaultTouchDebounce.
	TouchDebounce time.Duration
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// projectMeta is a project's metadata slot, written only by Register, the project's
// reconcile job, and Rename (the name alone; rename.go).
type projectMeta struct {
	ID            string
	Path          string
	Name          string
	RegisteredAt  time.Time
	DefaultBranch string
	GitHubSlug    string
	OriginURL     string
	Remotes       []string // sorted; replaced, never mutated in place
	// Git: the project has .git (nogit.go). Seeded from disk on load and register,
	// then kept by reconcile.
	Git   bool
	Error string
}

// equal reports whether m and o hold the same metadata. Update it with the fields.
func (m *projectMeta) equal(o *projectMeta) bool {
	return m.ID == o.ID && m.Path == o.Path && m.Name == o.Name && m.RegisteredAt.Equal(o.RegisteredAt) &&
		m.DefaultBranch == o.DefaultBranch && m.GitHubSlug == o.GitHubSlug && m.OriginURL == o.OriginURL &&
		slices.Equal(m.Remotes, o.Remotes) && m.Git == o.Git && m.Error == o.Error
}

func (m *projectMeta) commonDir() string { return filepath.Join(m.Path, ".git") }

type projectState struct {
	meta atomic.Pointer[projectMeta]
	// base is origin/<default> resolved to a sha; written only by the project's jobBase.
	base atomic.Pointer[projectBase]
	// wts is guarded by Git.mu; only the project's reconcile job adds or removes slots.
	wts map[string]*wtSlot
}

// wtSlot is one worktree's snapshot slot, written only by its status job (and seeded
// by the reconcile job that creates it).
type wtSlot struct {
	cur atomic.Pointer[Worktree]
	// base memoizes the last base ahead/behind by (HEAD, base sha); written only by
	// the status job.
	base atomic.Pointer[baseCount]
	// entries is the changed paths from the last successful status (nil when none),
	// from which the detail job derives the uncommitted files (uncommittedFiles);
	// written only by the status job, which keeps the last list when a refresh fails.
	// It is kept off Status, which is compared with ==.
	entries atomic.Pointer[[]statusEntry]
	admin   string // linked worktree admin dir; guarded by Git.mu
	// gitDir is the worktree's git admin dir (worktreeAdminDir), where the status job
	// reads operation markers (operation.go). Resolved by reconcile; guarded by Git.mu.
	gitDir string
}

// Git is the daemon's Store, backed by the git CLI.
type Git struct {
	db     *sql.DB
	bus    *bus.Bus
	log    *slog.Logger
	runner Runner
	now    func() time.Time
	wtRoot string
	// wtRootReal is wtRoot with symlinks resolved as far as it exists: a stream path.
	wtRootReal string
	// root is Options.AllowedRoot with symlinks resolved.
	root string

	snap atomic.Pointer[Snapshot]

	mu       sync.RWMutex
	projects map[string]*projectState
	// routes is the fs event routing table (watch.go): every known directory of every
	// project -> owner. Each project's entries are written only by its reconcile job
	// (and dropped by Unregister).
	routes map[string]watchTarget
	// made is the worktrees the app made, by path (made.go); guarded by mu.
	made map[string]madeWorktree

	// pubMu serializes snapshot rebuild + store + publish so events are ordered and
	// each one reflects the snapshot current when it was published.
	pubMu sync.Mutex
	// renameMu serializes Rename's check of the other projects' names and its write.
	renameMu sync.Mutex

	fs      *fsWatcher
	sched   *scheduler
	deb     *debouncer // git's directories, rescans, a known directory going away
	treeDeb *debouncer // edits in a worktree's tree
	// touch debounces Touch, apart from deb and treeDeb so fs events keep their
	// shorter windows.
	touch *debouncer

	// live is the worktrees with a live thread (SetLiveWorktrees); pollNudge and
	// fetchNudge wake the tier loops when a project may have turned live (activity.go).
	live       liveSet
	pollNudge  chan struct{}
	fetchNudge chan struct{}

	details detailState   // worktree detail cache (detail.go)
	files   fileCollector // live worktrees' file changes (files.go)
	// autoPull is the daemon's auto pull hooks and the passes running (autopull.go).
	autoPull autoPullState
	// fetches runs the fetch loop's fetches (fetchpool.go).
	fetches fetchPool

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

var _ Store = (*Git)(nil)

// Start loads registered projects, starts the watcher, workers, and periodic loops, and
// schedules an initial reconcile of every project. It returns without waiting for git.
func Start(ctx context.Context, opts Options) (*Git, error) {
	if opts.DB == nil || opts.Bus == nil {
		return nil, errors.New("project: Options.DB and Options.Bus are required")
	}
	if !filepath.IsAbs(opts.WorktreeRoot) {
		return nil, fmt.Errorf("project: Options.WorktreeRoot must be an absolute path, got %q", opts.WorktreeRoot)
	}
	root, err := allowedRoot(opts.AllowedRoot)
	if err != nil {
		return nil, err
	}
	g := &Git{
		root:       root,
		db:         opts.DB,
		bus:        opts.Bus,
		wtRoot:     opts.WorktreeRoot,
		wtRootReal: resolveMissing(opts.WorktreeRoot),
		log:        cmp.Or(opts.Log, slog.Default()).With("store", "project"),
		runner:     opts.Runner,
		now:        opts.Now,
		projects:   map[string]*projectState{},
		routes:     map[string]watchTarget{},
		// Buffered: a nudge while a round runs is kept for the next one.
		pollNudge:  make(chan struct{}, 1),
		fetchNudge: make(chan struct{}, 1),
	}
	if g.runner == nil {
		g.runner = ExecRunner{}
	}
	if g.now == nil {
		g.now = time.Now
	}
	metas, err := g.load(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range metas {
		st := &projectState{wts: map[string]*wtSlot{}}
		st.meta.Store(m)
		g.projects[m.ID] = st
	}
	if g.made, err = g.loadMade(ctx); err != nil {
		return nil, err
	}

	ctx, g.cancel = context.WithCancel(context.WithoutCancel(ctx))
	g.sched = newScheduler(ctx, cmp.Or(opts.Workers, DefaultWorkers), g.runJob)
	g.deb = newDebouncer(cmp.Or(opts.Debounce, DefaultDebounce), func(k jobKey) { g.sched.request(k) })
	g.treeDeb = newDebouncer(cmp.Or(opts.TreeDebounce, DefaultTreeDebounce), func(k jobKey) { g.sched.request(k) })
	g.touch = newDebouncer(cmp.Or(opts.TouchDebounce, DefaultTouchDebounce), func(k jobKey) {
		g.log.Debug("worktree touched", "path", k.path, "debounced", true)
		g.sched.request(k)
	})
	g.fs = newFSWatcher(g.log, g.streamPaths, g.onEvents)
	g.wg.Go(func() { g.fs.run(ctx) })
	g.wg.Go(g.fs.dispatch)
	if t := tiers(opts.FetchInterval, opts.IdleFetchInterval, DefaultFetchInterval, DefaultIdleFetchInterval); t.live > 0 {
		// Every project is due in the first round (zero seed), shortly after start.
		s := newTierSched(t, time.Time{})
		g.wg.Go(func() { g.tierLoop(ctx, "fetch", s, min(t.live, firstFetchDelay), g.fetchNudge, g.fetchAsync) })
	}
	if t := tiers(opts.PollInterval, opts.IdlePollInterval, DefaultPollInterval, DefaultIdlePollInterval); t.live > 0 {
		// The initial reconcile below refreshes everything, so each project's first
		// poll is one interval after start.
		s := newTierSched(t, g.now())
		g.wg.Go(func() { g.tierLoop(ctx, "poll", s, t.live, g.pollNudge, g.poll) })
	}

	g.commit(nil)
	for _, m := range metas {
		g.sched.request(jobKey{kind: jobReconcile, projectID: m.ID})
	}
	return g, nil
}

// allowedRoot resolves Options.AllowedRoot, defaulting to the user's home directory.
func allowedRoot(root string) (string, error) {
	if root == "" {
		r, err := fsx.HomeRoot()
		if err != nil {
			return "", fmt.Errorf("project: allowed root: %w", err)
		}
		return r, nil
	}
	r, err := fsx.ResolveRoot(root)
	if err != nil {
		return "", fmt.Errorf("project: Options.AllowedRoot: %w", err)
	}
	return r, nil
}

func interval(v, def time.Duration) time.Duration {
	if v == 0 {
		return def
	}
	return v
}

// Close stops all goroutines and the FSEvents stream. In-flight git commands are
// cancelled.
func (g *Git) Close() error {
	g.cancel()
	g.deb.close()
	g.treeDeb.close()
	g.touch.close()
	g.sched.close()
	g.wg.Wait()
	return nil
}

// Snapshot implements Store.
func (g *Git) Snapshot() *Snapshot { return g.snap.Load() }

func (g *Git) load(ctx context.Context) ([]*projectMeta, error) {
	rows, err := g.db.QueryContext(ctx, `SELECT id, path, name, registered_at FROM projects`)
	if err != nil {
		return nil, fmt.Errorf("project: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []*projectMeta
	for rows.Next() {
		var (
			m  projectMeta
			ms int64
		)
		if err := rows.Scan(&m.ID, &m.Path, &m.Name, &ms); err != nil {
			return nil, fmt.Errorf("project: load: %w", err)
		}
		m.RegisteredAt = time.UnixMilli(ms)
		// Known before the first reconcile, so a git project never shows as one
		// without git while the daemon starts.
		m.Git = hasDotGit(m.Path)
		out = append(out, &m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("project: load: %w", err)
	}
	return out, nil
}

// --- snapshot and events ---------------------------------------------------------

// commit rebuilds the snapshot from every slot, stores it, and publishes the events
// produced by events(snapshot) (events may be nil).
func (g *Git) commit(events func(*Snapshot) []Event) {
	g.pubMu.Lock()
	defer g.pubMu.Unlock()
	g.mu.RLock()
	snap := g.buildLocked()
	g.mu.RUnlock()
	g.snap.Store(snap)
	if events == nil {
		return
	}
	for _, ev := range events(snap) {
		bus.Publish(g.bus, ev)
	}
}

func (g *Git) buildLocked() *Snapshot {
	snap := &Snapshot{Projects: make([]Project, 0, len(g.projects))}
	for _, st := range g.projects {
		m := st.meta.Load()
		r := Project{
			ID: m.ID, Path: m.Path, Name: m.Name, RegisteredAt: m.RegisteredAt,
			DefaultBranch: m.DefaultBranch, GitHubSlug: m.GitHubSlug, Remotes: m.Remotes, Git: m.Git, Error: m.Error,
			Worktrees: make([]Worktree, 0, len(st.wts)),
		}
		for _, slot := range st.wts {
			w := *slot.cur.Load()
			g.managedLocked(&w)
			r.Worktrees = append(r.Worktrees, w)
		}
		slices.SortFunc(r.Worktrees, func(a, b Worktree) int {
			if a.IsMain != b.IsMain {
				if a.IsMain {
					return -1
				}
				return 1
			}
			return cmp.Compare(a.Path, b.Path)
		})
		snap.Projects = append(snap.Projects, r)
	}
	slices.SortFunc(snap.Projects, func(a, b Project) int {
		return cmp.Or(cmp.Compare(a.Name, b.Name), cmp.Compare(a.Path, b.Path))
	})
	return snap
}

func projectUpdated(id string) func(*Snapshot) []Event {
	return func(s *Snapshot) []Event {
		if r, ok := s.Project(id); ok {
			return []Event{ProjectUpdated{Project: r}}
		}
		return nil
	}
}

// --- lookups ---------------------------------------------------------------------

func (g *Git) project(id string) *projectState {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.projects[id]
}

func (g *Git) slot(projectID, path string) *wtSlot {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if st := g.projects[projectID]; st != nil {
		return st.wts[path]
	}
	return nil
}

func (g *Git) statusKeys(projectID string) []jobKey {
	g.mu.RLock()
	defer g.mu.RUnlock()
	st := g.projects[projectID]
	if st == nil {
		return nil
	}
	keys := make([]jobKey, 0, len(st.wts))
	for p := range st.wts {
		keys = append(keys, jobKey{kind: jobStatus, projectID: projectID, path: p})
	}
	return keys
}

func (g *Git) projectIDs() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	ids := make([]string, 0, len(g.projects))
	for id := range g.projects {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// refresh reconciles project id, re-resolves its base, and then refreshes every
// worktree's status, waiting for each step so the statuses see the new base.
func (g *Git) refresh(ctx context.Context, id string) error {
	if err := g.sched.wait(ctx, jobKey{kind: jobReconcile, projectID: id}); err != nil {
		return err
	}
	if err := g.sched.wait(ctx, jobKey{kind: jobBase, projectID: id}); err != nil {
		return err
	}
	return g.sched.wait(ctx, g.statusKeys(id)...)
}

// --- intents ---------------------------------------------------------------------

// Register implements Store.
func (g *Git) Register(ctx context.Context, path string) (Project, error) {
	if path == "" {
		return Project{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	dir, err := resolveDir(path)
	if err != nil {
		return Project{}, err
	}
	if !fsx.Within(g.root, dir) {
		return Project{}, outsideRoot(path)
	}
	mainPath, isGit, err := g.projectRoot(ctx, path, dir)
	if err != nil {
		return Project{}, err
	}
	// A linked worktree under home can belong to a repository outside it.
	if !fsx.Within(g.root, mainPath) {
		return Project{}, outsideRoot(mainPath)
	}
	m := &projectMeta{
		ID: projectID(mainPath), Path: mainPath, Name: filepath.Base(mainPath),
		RegisteredAt: g.now().Truncate(time.Millisecond), Git: isGit,
	}

	g.mu.Lock()
	_, exists := g.projects[m.ID]
	st := &projectState{wts: map[string]*wtSlot{}}
	if !exists {
		st.meta.Store(m)
		g.projects[m.ID] = st
	}
	g.mu.Unlock()

	if !exists {
		if _, err := g.db.ExecContext(ctx,
			`INSERT INTO projects (id, path, name, registered_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
			m.ID, m.Path, m.Name, m.RegisteredAt.UnixMilli()); err != nil {
			g.mu.Lock()
			if g.projects[m.ID] == st {
				delete(g.projects, m.ID)
			}
			g.mu.Unlock()
			return Project{}, fmt.Errorf("project: register %s: %w", mainPath, err)
		}
		// No publish here: the first reconcile always publishes ProjectUpdated (its
		// worktree set changes from empty), so watchers never see a worktree-less project.
		g.log.Info("project registered", "id", m.ID, "path", m.Path)
	}
	if err := g.refresh(ctx, m.ID); err != nil {
		return Project{}, err
	}
	r, ok := g.Snapshot().Project(m.ID)
	if !ok {
		return Project{}, fmt.Errorf("%w: project %s was unregistered concurrently", ErrNotFound, m.ID)
	}
	return r, nil
}

// outsideRoot is Register's error for a path outside the allowed root.
func outsideRoot(path string) error {
	return fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, path)
}

// projectRoot returns the project directory to register for path (resolved to dir):
// the main worktree of the git repository containing it, else dir itself as a project
// without git when path names a directory.
func (g *Git) projectRoot(ctx context.Context, path, dir string) (root string, isGit bool, err error) {
	out, err := g.runner.Run(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		if !isNotARepository(err) {
			return "", false, fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
		}
		if fi, serr := os.Stat(path); serr != nil || !fi.IsDir() {
			return "", false, fmt.Errorf("%w: %s is not a directory", ErrInvalidArgument, path)
		}
		return dir, false, nil
	}
	mainPath, err := mainWorktreeFromCommonDir(string(out))
	if err != nil {
		return "", false, err
	}
	if real, err := filepath.EvalSymlinks(mainPath); err == nil {
		mainPath = real
	}
	return mainPath, true, nil
}

// resolveDir makes path absolute, resolves symlinks (git reports real paths, and on
// macOS /tmp and /var are symlinks), and maps a file to its directory.
func resolveDir(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("%w: %s does not exist", ErrInvalidArgument, abs)
	}
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	if !fi.IsDir() {
		real = filepath.Dir(real)
	}
	return real, nil
}

// Unregister implements Store.
func (g *Git) Unregister(ctx context.Context, id string) error {
	res, err := g.db.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("project: unregister %s: %w", id, err)
	}
	g.mu.Lock()
	_, inMem := g.projects[id]
	delete(g.projects, id)
	routed := false
	for dir, t := range g.routes {
		if t.projectID == id {
			delete(g.routes, dir)
			routed = true
		}
	}
	g.mu.Unlock()
	if n, _ := res.RowsAffected(); n == 0 && !inMem {
		return fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	if routed {
		g.fs.sync(ctx) // the stream may drop the project's directories
	}
	g.log.Info("project unregistered", "id", id)
	g.commit(func(*Snapshot) []Event { return []Event{ProjectRemoved{ID: id}} })
	return nil
}

// Refresh implements Store.
func (g *Git) Refresh(ctx context.Context, id string) error {
	ids := []string{id}
	if id == "" {
		ids = g.projectIDs()
	} else if g.project(id) == nil {
		return fmt.Errorf("%w: project %q", ErrNotFound, id)
	}
	for _, id := range ids {
		if err := g.refresh(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// CreateWorktree implements Store.
func (g *Git) CreateWorktree(ctx context.Context, opts CreateWorktreeOptions) (Worktree, error) {
	st := g.project(opts.ProjectID)
	if st == nil {
		return Worktree{}, fmt.Errorf("%w: project %q", ErrNotFound, opts.ProjectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return Worktree{}, err
	}
	if opts.Branch == "" {
		return Worktree{}, fmt.Errorf("%w: branch is required", ErrInvalidArgument)
	}
	if _, err := g.runner.Run(ctx, m.Path, "check-ref-format", "--branch", opts.Branch); err != nil {
		return Worktree{}, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, opts.Branch)
	}
	// Read origin now rather than m.GitHubSlug, which is empty until the project's
	// first reconcile after a daemon start.
	slug := ""
	if out, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err == nil {
		slug = parseGitHubSlug(string(trimNL(out)))
	}
	path := filepath.Clean(defaultWorktreePath(g.wtRoot, g.worktreeDirKey(m, slug), opts.Branch))
	if opts.Path != "" {
		if !InsideRoot(opts.Path, g.wtRoot) {
			return Worktree{}, fmt.Errorf("%w: worktree path %s is outside %s", ErrInvalidArgument, opts.Path, g.wtRoot)
		}
		path = filepath.Clean(opts.Path)
	}

	ctx, cancel := context.WithTimeout(ctx, worktreeTimeout)
	defer cancel()
	g.dropStaleWorktrees(ctx, m, path, opts.Branch)
	if err := requireFree(path); err != nil {
		return Worktree{}, err
	}
	local := g.refExists(ctx, m.Path, "refs/heads/"+opts.Branch)
	remote := g.refExists(ctx, m.Path, "refs/remotes/origin/"+opts.Branch)
	var args []string
	base := "" // the start point of a new branch
	switch {
	case local:
		args = []string{"worktree", "add", path, opts.Branch}
	case remote && opts.BaseRef == "":
		// git's DWIM: create <branch> tracking origin/<branch>.
		if opts.Fetch {
			g.fetchStartPoint(ctx, m, "origin/"+opts.Branch)
		}
		args = []string{"worktree", "add", path, opts.Branch}
	default:
		if err := g.ensureBorn(ctx, m, opts.BaseRef); err != nil {
			return Worktree{}, err
		}
		base = g.startPoint(ctx, m, opts)
		// --no-track: branching from origin/main must not make origin/main the
		// upstream, or ahead/behind and `git push` would target main. The exception is
		// a base of origin/<branch> itself (pr.fix.findings checking out a pull
		// request's branch): that is the branch's own upstream, so track it, and
		// ahead/behind, pull and a bare push work from the start. git's DWIM would do
		// the same, but it silently branches from the default branch when
		// origin/<branch> is missing, where an explicit base fails. git refuses
		// --track ("starting point is not a branch") when origin's fetch refspec does
		// not map the ref (a single-branch clone that fetched it by an explicit
		// refspec); the branch then has no upstream, as before.
		track := "--no-track"
		if base == "origin/"+opts.Branch && g.originFetches(ctx, m.Path, "refs/remotes/"+base) {
			track = "--track"
		}
		args = []string{"worktree", "add", track, "-b", opts.Branch, path, base}
	}
	if _, err := g.runner.Run(ctx, m.Path, args...); err != nil {
		return Worktree{}, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	g.log.Info("worktree created", "project", m.ID, "path", path, "branch", opts.Branch, "base", base)
	g.recordMade(ctx, m.ID, path) // before the refresh, so its snapshot has it Managed
	if err := g.refresh(ctx, m.ID); err != nil {
		return Worktree{}, err
	}
	wt, ok := g.Snapshot().Worktree(m.ID, path)
	if !ok {
		return Worktree{}, fmt.Errorf("project: created worktree %s is missing from git worktree list", path)
	}
	wt.StartPoint = base
	return wt, nil
}

// ensureBorn makes the empty initial commit in the main checkout when it has no
// commit yet and the new worktree would branch from that unborn branch: the default
// base, or an explicit base naming the checkout's own branch. A `git init` folder
// (or one whose Add-project initial commit failed) otherwise fails `git worktree add`
// with "invalid reference: main", which a user cannot be asked to understand. The
// commit is harmless and is what Add project makes; the project is refreshed after it
// so DefaultBranch, refs and the main worktree's head see the commit. Any other
// base is left to git.
func (g *Git) ensureBorn(ctx context.Context, m *projectMeta, base string) error {
	if g.refExists(ctx, m.Path, "HEAD") {
		return nil
	}
	out, err := g.runner.Run(ctx, m.Path, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return nil // detached from nothing: not the unborn-branch case
	}
	unborn := string(trimNL(out))
	if unborn == "" || (base != "" && base != unborn && base != "refs/heads/"+unborn) {
		return nil
	}
	if err := g.commitEmptyRoot(ctx, m.Path, unborn); err != nil {
		return fmt.Errorf("%w: %s has no commits yet and the initial commit failed: %w", ErrFailedPrecondition, m.Name, err)
	}
	g.log.Info("initial commit made for unborn branch", "project", m.ID, "path", m.Path, "branch", unborn)
	if err := g.refresh(ctx, m.ID); err != nil {
		return err
	}
	return nil
}

// commitEmptyRoot points the unborn branch at a new root commit of the empty tree,
// with plumbing: `git commit --allow-empty` would commit whatever the user staged in
// their checkout and run their hooks and signing (fuzz finding git 5). The index is
// left alone, so staged files stay staged; update-ref's empty old value refuses a
// branch someone made meanwhile.
func (g *Git) commitEmptyRoot(ctx context.Context, dir, branch string) error {
	tree, err := g.runner.Run(ctx, dir, "hash-object", "-w", "-t", "tree", os.DevNull)
	if err != nil {
		return err
	}
	commit, err := g.runner.Run(ctx, dir, "commit-tree", "--no-gpg-sign", "-m", initialCommitMessage, string(trimNL(tree)))
	if err != nil {
		return err
	}
	_, err = g.runner.Run(ctx, dir, "update-ref", "-m", "commit (initial): "+initialCommitMessage, "refs/heads/"+branch, string(trimNL(commit)), "")
	return err
}

// originFetches reports whether one of origin's configured fetch refspecs writes the
// remote-tracking ref ref (git sets up --track only for such a ref).
func (g *Git) originFetches(ctx context.Context, dir, ref string) bool {
	out, err := g.runner.Run(ctx, dir, "config", "--get-all", "remote.origin.fetch")
	if err != nil {
		return false
	}
	for spec := range strings.Lines(string(out)) {
		if refspecWrites(strings.TrimSpace(spec), ref) {
			return true
		}
	}
	return false
}

// refspecWrites reports whether the fetch refspec spec ("[+]src:dst", dst with at most
// one "*") writes ref. Negative refspecs ("^…") and refspecs without a destination
// write nothing.
func refspecWrites(spec, ref string) bool {
	spec = strings.TrimPrefix(spec, "+")
	_, dst, ok := strings.Cut(spec, ":")
	if !ok || strings.HasPrefix(spec, "^") || dst == "" {
		return false
	}
	pre, post, glob := strings.Cut(dst, "*")
	if !glob {
		return dst == ref
	}
	return len(ref) > len(pre)+len(post) && strings.HasPrefix(ref, pre) && strings.HasSuffix(ref, post)
}

// fetchStartPoint fetches ref's branch from its remote when ref is a remote-tracking
// ref ("<remote>/<branch>" for a configured remote), so a new branch starts at the
// remote's current tip. Anything else (a local branch, a sha, a tag) is left alone.
// The fetch is bounded by startFetchTimeout. A failure is logged and ignored: the
// worktree is then created from the existing, possibly stale, ref.
func (g *Git) fetchStartPoint(ctx context.Context, m *projectMeta, ref string) {
	remotes, err := g.remoteNames(ctx, m)
	if err != nil {
		g.log.Warn("fetch before worktree: listing remotes failed", "project", m.ID, "ref", ref, "err", err)
		return
	}
	remote, branch := splitRemoteRef(remotes, ref)
	if remote == "" {
		return
	}
	if err := g.fetchRemoteBranch(ctx, m, remote, branch); err != nil {
		g.log.Warn("fetch before worktree failed; using the existing ref", "project", m.ID, "ref", ref, "err", err)
	}
}

// remoteNames lists the project's configured remotes.
func (g *Git) remoteNames(ctx context.Context, m *projectMeta) ([]string, error) {
	out, err := g.runner.Run(ctx, m.Path, "remote")
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(out)), nil
}

// fetchRemoteBranch fetches remote's branch into refs/remotes/<remote>/<branch>,
// bounded by startFetchTimeout.
func (g *Git) fetchRemoteBranch(ctx context.Context, m *projectMeta, remote, branch string) error {
	fctx, cancel := context.WithTimeout(ctx, startFetchTimeout)
	defer cancel()
	// An explicit refspec updates refs/remotes/<remote>/<branch> whatever the
	// remote's configured fetch refspec is; "+" because remote branches may be
	// force-pushed.
	refspec := "+refs/heads/" + branch + ":refs/remotes/" + remote + "/" + branch
	start := time.Now()
	if _, err := g.runner.Run(fctx, m.Path, "fetch", "--quiet", "--no-tags", remote, refspec); err != nil {
		return err
	}
	g.log.Debug("fetched start point", "project", m.ID, "ref", remote+"/"+branch, "took", time.Since(start))
	return nil
}

// splitRemoteRef splits ref into (remote, branch) when it starts with "<remote>/" for
// one of remotes, preferring the longest remote name (names may contain "/"). It
// returns empty strings when ref names no remote branch.
func splitRemoteRef(remotes []string, ref string) (remote, branch string) {
	for _, r := range remotes {
		if b, ok := strings.CutPrefix(ref, r+"/"); ok && b != "" && b != "HEAD" && len(r) > len(remote) {
			remote, branch = r, b
		}
	}
	return remote, branch
}

// ListRefs implements Store.
func (g *Git) ListRefs(ctx context.Context, projectID string) (Refs, error) {
	st := g.project(projectID)
	if st == nil {
		return Refs{}, fmt.Errorf("%w: project %q", ErrNotFound, projectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return Refs{}, err
	}
	out, err := g.runner.Run(ctx, m.Path, "for-each-ref", refsFormat, "refs/heads", "refs/remotes")
	if err != nil {
		return Refs{}, fmt.Errorf("project: list refs of %s: %w", m.ID, err)
	}
	refs := parseRefs(out)
	// DefaultBranch is empty until the project's first reconcile after a daemon start.
	def := m.DefaultBranch
	if def == "" {
		_, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin")
		def = g.defaultBranch(ctx, m.Path, "", err == nil)
	}
	refs.DefaultRef, refs.DefaultBranch = def, def
	_, local := slices.BinarySearch(refs.Local, def)
	if _, remote := slices.BinarySearch(refs.Remote, "origin/"+def); remote && !local {
		refs.DefaultRef = "origin/" + def
	}
	return refs, nil
}

func (g *Git) refExists(ctx context.Context, dir, ref string) bool {
	_, err := g.runner.Run(ctx, dir, "rev-parse", "--verify", "--quiet", ref)
	return err == nil
}

// RemoveWorktree implements Store.
func (g *Git) RemoveWorktree(ctx context.Context, opts RemoveWorktreeOptions) error {
	st := g.project(opts.ProjectID)
	if st == nil {
		return fmt.Errorf("%w: project %q", ErrNotFound, opts.ProjectID)
	}
	m := st.meta.Load()
	if err := requireGit(m); err != nil {
		return err
	}
	path := filepath.Clean(opts.Path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	wt, ok := g.Snapshot().Worktree(m.ID, path)
	if !ok {
		return fmt.Errorf("%w: worktree %q in project %s", ErrNotFound, opts.Path, m.ID)
	}
	if wt.IsMain {
		return fmt.Errorf("%w: cannot remove the main worktree", ErrInvalidArgument)
	}
	if !opts.Force && opts.Hold != nil {
		if held := opts.Hold(wt); held != "" {
			also := ""
			if wt.Status.HasUncommitted() {
				also = ", deleting its uncommitted changes"
			}
			return fmt.Errorf("%w: worktree %s is in use: %s; --force removes it anyway%s", ErrFailedPrecondition, path, held, also)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, worktreeTimeout)
	defer cancel()
	args := []string{"worktree", "remove"}
	if opts.Force {
		args = append(args, "--force")
	}
	args = append(args, path)
	if _, err := g.runner.Run(ctx, m.Path, args...); err != nil {
		if opts.Force {
			return fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
		// git refuses a worktree with modified or untracked files: read its status
		// again, so the caller can show what --force would delete.
		if werr := g.sched.wait(ctx, jobKey{kind: jobStatus, projectID: m.ID, path: path}); werr != nil {
			return fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
		now, ok := g.Snapshot().Worktree(m.ID, path)
		if ok && now.Status.HasUncommitted() {
			return &UncommittedError{Worktrees: []Worktree{now}}
		}
		if !ok || now.Status.Error != "" || !refusedForSubmodules(err) || !g.submodulesSafe(ctx, path) {
			return fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
		// git refuses any worktree with an initialized submodule, clean or not (fuzz
		// finding git 8). Clean (status counts a modified or untracked submodule) and
		// nothing in a submodule that its remote lacks: --force loses nothing.
		g.log.Info("worktree has submodules and nothing to lose; removing with --force", "project", m.ID, "path", path)
		if _, err := g.runner.Run(ctx, m.Path, "worktree", "remove", "--force", path); err != nil {
			return fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
		}
	}
	g.log.Info("worktree removed", "project", m.ID, "path", path)
	g.forgetMade(ctx, g.now(), path)
	var branchErr error
	if opts.DeleteBranch && wt.Branch != "" {
		branchErr = g.deleteRemovedBranch(ctx, m, wt.Branch, opts.Force)
	}
	if err := g.sched.wait(ctx, jobKey{kind: jobReconcile, projectID: m.ID}); err != nil {
		return errors.Join(branchErr, err)
	}
	return branchErr
}

// deleteRemovedBranch deletes the branch of a worktree RemoveWorktree just removed:
// with force whatever it holds, else only when it is merged into the default branch
// (unmergedTip, the DeleteBranch rule; fuzz finding git 2: it was always `branch -D`).
// A branch kept is an error that says the worktree is gone and why the branch is not.
func (g *Git) deleteRemovedBranch(ctx context.Context, m *projectMeta, branch string, force bool) error {
	if !force {
		tip := g.revParse(ctx, m.Path, "refs/heads/"+branch)
		if tip == "" {
			return nil // already gone
		}
		n, base, err := g.unmergedTip(ctx, m, tip)
		switch {
		case err != nil:
			return fmt.Errorf("%w: worktree removed, but kept branch %s: %w (code-foundry project branch delete --force deletes it)", ErrFailedPrecondition, branch, err)
		case n > 0:
			g.log.Info("branch kept: not merged", "project", m.ID, "branch", branch, "commits", n, "base", base)
			return fmt.Errorf("%w: worktree removed, but kept branch %s: it has %s not in %s (code-foundry project branch delete --force deletes it)",
				ErrFailedPrecondition, branch, commits(n), base)
		}
	}
	if _, err := g.runner.Run(ctx, m.Path, "branch", "-D", branch); err != nil {
		return fmt.Errorf("%w: worktree removed, but deleting branch %s failed: %w", ErrFailedPrecondition, branch, err)
	}
	g.log.Info("branch deleted", "project", m.ID, "branch", branch, "force", force)
	return nil
}

// --- jobs ------------------------------------------------------------------------

func (g *Git) runJob(ctx context.Context, k jobKey) {
	start := time.Now()
	defer func() {
		g.log.Debug("job done", "job", k.kind.String(), "project", k.projectID, "worktree", k.path,
			"took", time.Since(start).Round(time.Millisecond))
	}()
	switch k.kind {
	case jobReconcile:
		g.reconcile(ctx, k.projectID)
	case jobStatus:
		g.status(ctx, k.projectID, k.path)
		g.detailAfterStatus(k.projectID, k.path)
	case jobDetail:
		g.detail(ctx, k.projectID, k.path)
	case jobBase:
		g.resolveBase(ctx, k.projectID)
	case jobFiles:
		g.flushFiles(ctx, k)
	}
}

// reconcile re-lists a project's worktrees and metadata, syncs slots and fs routes,
// publishes, then requests jobBase, which re-resolves the base and refreshes the
// status of every worktree.
func (g *Git) reconcile(ctx context.Context, id string) {
	st := g.project(id)
	if st == nil {
		return
	}
	prev := st.meta.Load()
	next := *prev
	next.Error = ""
	var listed []listedWorktree
	listedAt := g.now()
	isGit, err := probeGit(next.Path)
	switch {
	case err != nil:
	case isGit:
		next.Git = true
		listed, err = g.inspect(ctx, &next)
	default:
		listed = plainCheckout(&next) // no git command for a project without git
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		next.Error = err.Error()
		listed = nil
		g.log.Warn("reconcile failed", "project", id, "path", next.Path, "err", err)
	}
	// A project that gained (or lost) .git reseeds its worktree from the listing, so
	// the first event after the flip already carries the branch.
	gitChanged := next.Git != prev.Git

	// Resolve linked worktrees' admin dirs, and the main worktree's git dir, outside
	// the lock (file reads).
	admins := make(map[string]string, len(listed))
	for _, l := range listed[min(1, len(listed)):] {
		if a, err := readGitFile(l.Path); err == nil {
			admins[l.Path] = a
		}
	}
	var mainGitDir string
	if len(listed) > 0 && next.Git {
		mainGitDir = worktreeAdminDir(listed[0].Path)
	}

	g.mu.Lock()
	if g.projects[id] != st {
		g.mu.Unlock()
		return
	}
	var (
		removed    []string
		setChanged bool
		seen       = make(map[string]bool, len(listed))
		wwts       = make([]watchWorktree, 0, len(listed))
	)
	for i, l := range listed {
		seen[l.Path] = true
		isMain := i == 0
		slot := st.wts[l.Path]
		if slot == nil || gitChanged {
			slot = &wtSlot{}
			slot.cur.Store(&Worktree{
				ProjectID: id, Path: l.Path, Branch: l.Branch, Head: l.Head, IsMain: isMain, Detached: l.Detached,
			})
			st.wts[l.Path] = slot
			setChanged = true
		}
		slot.admin = admins[l.Path]
		slot.gitDir = slot.admin
		if isMain {
			slot.gitDir = mainGitDir
		}
		wwts = append(wwts, watchWorktree{path: l.Path, isMain: isMain, admin: slot.admin})
	}
	for p := range st.wts {
		if !seen[p] {
			delete(st.wts, p)
			removed = append(removed, p)
			setChanged = true
		}
	}
	var stale []string // records of worktrees git no longer lists (made.go)
	if next.Error == "" && next.Git {
		stale = g.staleMadeLocked(id, seen, listedAt)
	}
	next.Name = renamedLocked(st, prev)
	metaChanged := !next.equal(st.meta.Load())
	if metaChanged {
		st.meta.Store(&next)
	}
	var want map[string]watchTarget
	switch {
	case next.Error != "":
		// No routes: the poll retries the reconcile (a moved project, a deleted one).
	case next.Git:
		want = desiredWatches(id, next.Path, next.commonDir(), wwts)
	default:
		want = map[string]watchTarget{next.Path: {kind: wkPlainRoot, projectID: id, wtPath: next.Path}}
	}
	routesChanged := false
	for dir, t := range g.routes {
		if t.projectID == id && want[dir] != t {
			delete(g.routes, dir)
			routesChanged = true
		}
	}
	for dir, t := range want {
		if g.routes[dir] != t {
			g.routes[dir] = t
			routesChanged = true
		}
	}
	g.mu.Unlock()
	g.forgetMade(ctx, listedAt, stale...)

	if routesChanged {
		g.fs.sync(ctx) // a worktree root may have appeared outside the stream's paths
	}

	if metaChanged || setChanged {
		g.commit(func(s *Snapshot) []Event {
			var evs []Event
			for _, p := range removed {
				evs = append(evs, WorktreeRemoved{ProjectID: id, Path: p})
			}
			return append(evs, projectUpdated(id)(s)...)
		})
	}
	if next.Git {
		g.sched.request(jobKey{kind: jobBase, projectID: id})
	}
}

// inspect fills m's git-derived fields and returns the listed worktrees, main first,
// without bare or prunable entries.
func (g *Git) inspect(ctx context.Context, m *projectMeta) ([]listedWorktree, error) {
	out, err := g.runner.Run(ctx, m.Path, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	all, err := parseWorktreeList(out)
	if err != nil {
		return nil, err
	}
	if len(all) == 0 || all[0].Bare {
		return nil, fmt.Errorf("%s has no main worktree", m.Path)
	}
	listed := make([]listedWorktree, 0, len(all))
	for _, l := range all {
		if l.Prunable || l.Bare {
			continue
		}
		if real, err := filepath.EvalSymlinks(l.Path); err == nil {
			l.Path = real
		}
		listed = append(listed, l)
	}

	// One `git remote` per reconcile; origin's URL is read only when origin exists. A
	// failed listing keeps the previous remotes rather than reporting a local-only project.
	listedRemotes := true
	if out, err := g.runner.Run(ctx, m.Path, "remote"); err == nil {
		m.Remotes = parseRemotes(out)
	} else {
		listedRemotes = false
		if ctx.Err() == nil {
			g.log.Warn("listing remotes failed", "project", m.ID, "err", err)
		}
	}
	m.OriginURL = ""
	if !listedRemotes || slices.Contains(m.Remotes, "origin") {
		if out, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err == nil {
			m.OriginURL = string(trimNL(out))
		}
	}
	m.GitHubSlug = parseGitHubSlug(m.OriginURL)
	hasOrigin := !listedRemotes || slices.Contains(m.Remotes, "origin")
	m.DefaultBranch = g.defaultBranch(ctx, m.Path, listed[0].Branch, hasOrigin)
	return listed, nil
}

// defaultBranch is origin/HEAD's target with an origin remote, else (no origin) the
// branch HEAD of the main worktree dir names; then main or master if they exist
// locally, else the main worktree's branch, else "main".
func (g *Git) defaultBranch(ctx context.Context, dir, mainBranch string, hasOrigin bool) string {
	if hasOrigin {
		if out, err := g.runner.Run(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
			if b := parseOriginHead(out); b != "" {
				return b
			}
		}
	} else if out, err := g.runner.Run(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		// A repository without origin has no remote default: the main checkout's
		// branch is the one new worktrees branch from (an unborn one included).
		if b := string(trimNL(out)); b != "" {
			return b
		}
	}
	for _, b := range []string{"main", "master"} {
		if g.refExists(ctx, dir, "refs/heads/"+b) || g.refExists(ctx, dir, "refs/remotes/origin/"+b) {
			return b
		}
	}
	return cmp.Or(mainBranch, "main")
}

func trimNL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return b
}

// status refreshes one worktree slot and publishes WorktreeUpdated if anything other
// than RefreshedAt changed.
func (g *Git) status(ctx context.Context, projectID, path string) {
	st := g.project(projectID)
	slot := g.slot(projectID, path)
	if st == nil || slot == nil || !st.meta.Load().Git {
		return // a project without git keeps its zero status
	}
	prev := *slot.cur.Load()
	next := prev
	now := g.now()
	g.mu.RLock()
	gitDir := slot.gitDir
	g.mu.RUnlock()

	out, err := g.runner.Run(ctx, path, statusArgs...)
	var info statusInfo
	if err == nil {
		info, err = parseStatusV2(out)
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		next.Status.Error = err.Error()
		next.Status.RefreshedAt = now
		g.log.Debug("status failed", "project", projectID, "path", path, "err", err)
	} else {
		next.Branch, next.Head, next.Detached = info.Branch, info.Head, info.Detached
		op := readOperation(gitDir) // marker files only, no git command
		next.Status = Status{
			Upstream: info.Upstream, Ahead: info.Ahead, Behind: info.Behind,
			Staged: info.Staged, Modified: info.Modified, Untracked: info.Untracked,
			Conflicted: info.Conflicted,
			Dirty:      info.Staged+info.Modified+info.Untracked+info.Conflicted > 0,
			Operation:  op.Op, OperationStep: op.Step, OperationTotal: op.Total,
			RefreshedAt: now,
		}
		if c, ok, reused := g.baseCounts(ctx, st, slot, path, info.Head); ok {
			next.Status.BaseRef, next.Status.BaseAhead, next.Status.BaseBehind = c.ref, c.ahead, c.behind
			next.Status.BaseMerged = c.merged
			if reused {
				g.log.Debug("base counts reused", "project", projectID, "path", path,
					"head", shortSHA(c.head), "base", shortSHA(c.sha))
			}
		}
	}

	if g.slot(projectID, path) != slot {
		return // removed while we ran
	}
	if err == nil {
		slot.entries.Store(&info.Entries) // a failed refresh keeps the last list, like Status
	}
	slot.cur.Store(&next)
	changed := next.Branch != prev.Branch || next.Head != prev.Head || next.Detached != prev.Detached ||
		!next.Status.equalIgnoringTime(prev.Status)
	if !changed {
		// Nothing but RefreshedAt moved. The snapshot is rebuilt for the first refresh
		// (unset RefreshedAt means "status not known yet") and, with an event, once
		// the published RefreshedAt is older than republishAfter (the Projects page's
		// freshness reads it); other refreshes leave the snapshot alone.
		if prev.Status.RefreshedAt.IsZero() {
			g.commit(nil)
		} else if g.publishedBefore(projectID, path, now.Add(-republishAfter)) {
			g.commit(func(s *Snapshot) []Event {
				if w, ok := s.Worktree(projectID, path); ok {
					return []Event{WorktreeUpdated{Worktree: w}}
				}
				return nil
			})
		}
		return
	}
	g.log.Debug("worktree status changed", "project", projectID, "path", path, "head", shortSHA(next.Head),
		"staged", next.Status.Staged, "modified", next.Status.Modified, "untracked", next.Status.Untracked)
	g.commit(func(s *Snapshot) []Event {
		if w, ok := s.Worktree(projectID, path); ok {
			return []Event{WorktreeUpdated{Worktree: w}}
		}
		return nil
	})
}

// republishAfter is how stale a worktree's published RefreshedAt may get while its
// status does not change: an unchanged refresh past it republishes the worktree, so
// "updated N ago" stays within about a poll interval of the last check.
const republishAfter = time.Minute

// publishedBefore reports whether the snapshot's RefreshedAt for the worktree is
// before t (false when the worktree is not in the snapshot).
func (g *Git) publishedBefore(projectID, path string, t time.Time) bool {
	w, ok := g.snap.Load().Worktree(projectID, path)
	return ok && w.Status.RefreshedAt.Before(t)
}

// --- loops -----------------------------------------------------------------------

// firstFetchDelay is when the first fetch round runs after Start (or the live fetch
// interval, if shorter), once the initial reconcile has learned each project's origin.
const firstFetchDelay = 10 * time.Second

// fetch fetches one project; the fetch tier loop (activity.go) calls it, one project
// at a time.
func (g *Git) fetch(ctx context.Context, id string) {
	st := g.project(id)
	if st == nil {
		return
	}
	m := st.meta.Load()
	if m.OriginURL == "" || m.Error != "" || g.autoPulling(id) {
		// An auto pull pass still running fetches itself (git pull): a second fetch
		// writing FETCH_HEAD under it makes the pull fail.
		return
	}
	fctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	if _, err := g.runner.Run(fctx, m.Path, "fetch", "--prune", "--quiet"); err != nil {
		if ctx.Err() == nil {
			g.log.Warn("fetch failed", "project", id, "path", m.Path, "err", err)
		}
		return
	}
	// The watcher sees FETCH_HEAD too; the reconcile afterFetch requests (or its auto
	// pull pass runs) makes the refresh independent of fs events.
	g.afterFetch(ctx, id)
}
