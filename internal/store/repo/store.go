package repo

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
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Defaults for Options.
const (
	DefaultWorkers       = 4
	DefaultDebounce      = 300 * time.Millisecond
	DefaultFetchInterval = 2 * time.Minute
	DefaultPollInterval  = 30 * time.Second
	// fetchTimeout bounds one `git fetch`; worktreeTimeout bounds worktree add/remove,
	// which may check out or delete a large tree.
	fetchTimeout    = 2 * time.Minute
	worktreeTimeout = 5 * time.Minute
)

// Options configures Start.
type Options struct {
	DB  *sql.DB  // required; holds the repos table
	Bus *bus.Bus // required; receives Event values
	// WorktreeRoot is where CreateWorktree puts worktrees without an explicit path:
	// <WorktreeRoot>/<owner>/<repo>/<branch>. Required, absolute.
	WorktreeRoot string
	Log          *slog.Logger
	// Runner runs git. Defaults to ExecRunner{}.
	Runner Runner
	// Workers bounds concurrent git refresh jobs. Defaults to DefaultWorkers.
	Workers int
	// Debounce is the per-worktree coalescing window for fs events.
	Debounce time.Duration
	// FetchInterval is how often each repo runs `git fetch --prune`. Zero means
	// DefaultFetchInterval; negative disables fetching.
	FetchInterval time.Duration
	// PollInterval is a backstop status refresh of every worktree, for changes the
	// non-recursive watcher cannot see (edits below the top level of a worktree).
	// Zero means DefaultPollInterval; negative disables polling.
	PollInterval time.Duration
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time
}

// repoMeta is a repo's metadata slot, written only by Register and the repo's
// reconcile job.
type repoMeta struct {
	ID            string
	Path          string
	Name          string
	RegisteredAt  time.Time
	DefaultBranch string
	GitHubSlug    string
	OriginURL     string
	Error         string
}

func (m *repoMeta) commonDir() string { return filepath.Join(m.Path, ".git") }

type repoState struct {
	meta atomic.Pointer[repoMeta]
	// wts is guarded by Git.mu; only the repo's reconcile job adds or removes slots.
	wts map[string]*wtSlot
}

// wtSlot is one worktree's snapshot slot, written only by its status job (and seeded
// by the reconcile job that creates it).
type wtSlot struct {
	cur   atomic.Pointer[Worktree]
	admin string // linked worktree admin dir; guarded by Git.mu
}

// Git is the daemon's Store, backed by the git CLI.
type Git struct {
	db     *sql.DB
	bus    *bus.Bus
	log    *slog.Logger
	runner Runner
	now    func() time.Time
	wtRoot string

	snap atomic.Pointer[Snapshot]

	mu      sync.RWMutex
	repos   map[string]*repoState
	watches map[string]watchTarget // watched dir -> owner

	// pubMu serializes snapshot rebuild + store + publish so events are ordered and
	// each one reflects the snapshot current when it was published.
	pubMu sync.Mutex

	watcher *fsnotify.Watcher
	sched   *scheduler
	deb     *debouncer

	details detailState // worktree detail cache (detail.go)

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

var _ Store = (*Git)(nil)

// Start loads registered repos, starts the watcher, workers, and periodic loops, and
// schedules an initial reconcile of every repo. It returns without waiting for git.
func Start(ctx context.Context, opts Options) (*Git, error) {
	if opts.DB == nil || opts.Bus == nil {
		return nil, errors.New("repo: Options.DB and Options.Bus are required")
	}
	if !filepath.IsAbs(opts.WorktreeRoot) {
		return nil, fmt.Errorf("repo: Options.WorktreeRoot must be an absolute path, got %q", opts.WorktreeRoot)
	}
	g := &Git{
		db:      opts.DB,
		bus:     opts.Bus,
		wtRoot:  opts.WorktreeRoot,
		log:     cmp.Or(opts.Log, slog.Default()).With("store", "repo"),
		runner:  opts.Runner,
		now:     opts.Now,
		repos:   map[string]*repoState{},
		watches: map[string]watchTarget{},
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
		st := &repoState{wts: map[string]*wtSlot{}}
		st.meta.Store(m)
		g.repos[m.ID] = st
	}
	g.watcher, err = fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("repo: start watcher: %w", err)
	}

	ctx, g.cancel = context.WithCancel(context.WithoutCancel(ctx))
	g.sched = newScheduler(ctx, cmp.Or(opts.Workers, DefaultWorkers), g.runJob)
	g.deb = newDebouncer(cmp.Or(opts.Debounce, DefaultDebounce), func(k jobKey) { g.sched.request(k) })
	g.wg.Go(func() { g.watchLoop(ctx) })
	if d := interval(opts.FetchInterval, DefaultFetchInterval); d > 0 {
		g.wg.Go(func() { g.fetchLoop(ctx, d) })
	}
	if d := interval(opts.PollInterval, DefaultPollInterval); d > 0 {
		g.wg.Go(func() { g.pollLoop(ctx, d) })
	}

	g.commit(nil)
	for _, m := range metas {
		g.sched.request(jobKey{kind: jobReconcile, repoID: m.ID})
	}
	return g, nil
}

func interval(v, def time.Duration) time.Duration {
	if v == 0 {
		return def
	}
	return v
}

// Close stops all goroutines and the watcher. In-flight git commands are cancelled.
func (g *Git) Close() error {
	g.cancel()
	g.deb.close()
	g.sched.close()
	err := g.watcher.Close()
	g.wg.Wait()
	return err
}

// Snapshot implements Store.
func (g *Git) Snapshot() *Snapshot { return g.snap.Load() }

func (g *Git) load(ctx context.Context) ([]*repoMeta, error) {
	rows, err := g.db.QueryContext(ctx, `SELECT id, path, name, registered_at FROM repos`)
	if err != nil {
		return nil, fmt.Errorf("repo: load: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []*repoMeta
	for rows.Next() {
		var (
			m  repoMeta
			ms int64
		)
		if err := rows.Scan(&m.ID, &m.Path, &m.Name, &ms); err != nil {
			return nil, fmt.Errorf("repo: load: %w", err)
		}
		m.RegisteredAt = time.UnixMilli(ms)
		out = append(out, &m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("repo: load: %w", err)
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
	snap := &Snapshot{Repos: make([]Repo, 0, len(g.repos))}
	for _, st := range g.repos {
		m := st.meta.Load()
		r := Repo{
			ID: m.ID, Path: m.Path, Name: m.Name, RegisteredAt: m.RegisteredAt,
			DefaultBranch: m.DefaultBranch, GitHubSlug: m.GitHubSlug, Error: m.Error,
			Worktrees: make([]Worktree, 0, len(st.wts)),
		}
		for _, slot := range st.wts {
			r.Worktrees = append(r.Worktrees, *slot.cur.Load())
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
		snap.Repos = append(snap.Repos, r)
	}
	slices.SortFunc(snap.Repos, func(a, b Repo) int {
		return cmp.Or(cmp.Compare(a.Name, b.Name), cmp.Compare(a.Path, b.Path))
	})
	return snap
}

func repoUpdated(id string) func(*Snapshot) []Event {
	return func(s *Snapshot) []Event {
		if r, ok := s.Repo(id); ok {
			return []Event{RepoUpdated{Repo: r}}
		}
		return nil
	}
}

// --- lookups ---------------------------------------------------------------------

func (g *Git) repo(id string) *repoState {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.repos[id]
}

func (g *Git) slot(repoID, path string) *wtSlot {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if st := g.repos[repoID]; st != nil {
		return st.wts[path]
	}
	return nil
}

func (g *Git) statusKeys(repoID string) []jobKey {
	g.mu.RLock()
	defer g.mu.RUnlock()
	st := g.repos[repoID]
	if st == nil {
		return nil
	}
	keys := make([]jobKey, 0, len(st.wts))
	for p := range st.wts {
		keys = append(keys, jobKey{kind: jobStatus, repoID: repoID, path: p})
	}
	return keys
}

func (g *Git) repoIDs() []string {
	g.mu.RLock()
	defer g.mu.RUnlock()
	ids := make([]string, 0, len(g.repos))
	for id := range g.repos {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids
}

// refresh reconciles repo id and then refreshes every worktree's status, waiting for both.
func (g *Git) refresh(ctx context.Context, id string) error {
	if err := g.sched.wait(ctx, jobKey{kind: jobReconcile, repoID: id}); err != nil {
		return err
	}
	return g.sched.wait(ctx, g.statusKeys(id)...)
}

// --- intents ---------------------------------------------------------------------

// Register implements Store.
func (g *Git) Register(ctx context.Context, path string) (Repo, error) {
	if path == "" {
		return Repo{}, fmt.Errorf("%w: path is required", ErrInvalidArgument)
	}
	dir, err := resolveDir(path)
	if err != nil {
		return Repo{}, err
	}
	out, err := g.runner.Run(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Repo{}, fmt.Errorf("%w: %s is not inside a git repository: %w", ErrInvalidArgument, path, err)
	}
	mainPath, err := mainWorktreeFromCommonDir(string(out))
	if err != nil {
		return Repo{}, err
	}
	if real, err := filepath.EvalSymlinks(mainPath); err == nil {
		mainPath = real
	}
	m := &repoMeta{
		ID: repoID(mainPath), Path: mainPath, Name: filepath.Base(mainPath),
		RegisteredAt: g.now().Truncate(time.Millisecond),
	}

	g.mu.Lock()
	_, exists := g.repos[m.ID]
	st := &repoState{wts: map[string]*wtSlot{}}
	if !exists {
		st.meta.Store(m)
		g.repos[m.ID] = st
	}
	g.mu.Unlock()

	if !exists {
		if _, err := g.db.ExecContext(ctx,
			`INSERT INTO repos (id, path, name, registered_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
			m.ID, m.Path, m.Name, m.RegisteredAt.UnixMilli()); err != nil {
			g.mu.Lock()
			if g.repos[m.ID] == st {
				delete(g.repos, m.ID)
			}
			g.mu.Unlock()
			return Repo{}, fmt.Errorf("repo: register %s: %w", mainPath, err)
		}
		// No publish here: the first reconcile always publishes RepoUpdated (its
		// worktree set changes from empty), so watchers never see a worktree-less repo.
		g.log.Info("repo registered", "id", m.ID, "path", m.Path)
	}
	if err := g.refresh(ctx, m.ID); err != nil {
		return Repo{}, err
	}
	r, ok := g.Snapshot().Repo(m.ID)
	if !ok {
		return Repo{}, fmt.Errorf("%w: repo %s was unregistered concurrently", ErrNotFound, m.ID)
	}
	return r, nil
}

// resolveDir makes path absolute, resolves symlinks (git reports real paths, and on
// macOS /tmp and /var are symlinks), and maps a file to its directory.
func resolveDir(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%w: %s: %w", ErrInvalidArgument, path, err)
	}
	real, err := filepath.EvalSymlinks(abs)
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
	res, err := g.db.ExecContext(ctx, `DELETE FROM repos WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("repo: unregister %s: %w", id, err)
	}
	g.mu.Lock()
	_, inMem := g.repos[id]
	delete(g.repos, id)
	var dirs []string
	for dir, t := range g.watches {
		if t.repoID == id {
			dirs = append(dirs, dir)
			delete(g.watches, dir)
		}
	}
	g.mu.Unlock()
	if n, _ := res.RowsAffected(); n == 0 && !inMem {
		return fmt.Errorf("%w: repo %q", ErrNotFound, id)
	}
	for _, d := range dirs {
		_ = g.watcher.Remove(d)
	}
	g.log.Info("repo unregistered", "id", id)
	g.commit(func(*Snapshot) []Event { return []Event{RepoRemoved{ID: id}} })
	return nil
}

// Refresh implements Store.
func (g *Git) Refresh(ctx context.Context, id string) error {
	ids := []string{id}
	if id == "" {
		ids = g.repoIDs()
	} else if g.repo(id) == nil {
		return fmt.Errorf("%w: repo %q", ErrNotFound, id)
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
	st := g.repo(opts.RepoID)
	if st == nil {
		return Worktree{}, fmt.Errorf("%w: repo %q", ErrNotFound, opts.RepoID)
	}
	m := st.meta.Load()
	if opts.Branch == "" {
		return Worktree{}, fmt.Errorf("%w: branch is required", ErrInvalidArgument)
	}
	if _, err := g.runner.Run(ctx, m.Path, "check-ref-format", "--branch", opts.Branch); err != nil {
		return Worktree{}, fmt.Errorf("%w: invalid branch name %q", ErrInvalidArgument, opts.Branch)
	}
	path := opts.Path
	if path == "" {
		// Read origin now rather than m.GitHubSlug, which is empty until the repo's
		// first reconcile after a daemon start.
		slug := ""
		if out, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err == nil {
			slug = parseGitHubSlug(string(trimNL(out)))
		}
		path = defaultWorktreePath(g.wtRoot, slug, m.Name, opts.Branch)
	} else if !filepath.IsAbs(path) {
		return Worktree{}, fmt.Errorf("%w: path %q must be absolute", ErrInvalidArgument, path)
	}
	path = filepath.Clean(path)

	ctx, cancel := context.WithTimeout(ctx, worktreeTimeout)
	defer cancel()
	local := g.refExists(ctx, m.Path, "refs/heads/"+opts.Branch)
	remote := g.refExists(ctx, m.Path, "refs/remotes/origin/"+opts.Branch)
	var args []string
	if local || (remote && opts.BaseRef == "") {
		// Existing branch, or git's DWIM: create <branch> tracking origin/<branch>.
		args = []string{"worktree", "add", path, opts.Branch}
	} else {
		base := opts.BaseRef
		if base == "" {
			base = g.defaultBase(ctx, m)
		}
		// --no-track: branching from origin/main must not make origin/main the
		// upstream, or ahead/behind and `git push` would target main.
		args = []string{"worktree", "add", "--no-track", "-b", opts.Branch, path, base}
	}
	if _, err := g.runner.Run(ctx, m.Path, args...); err != nil {
		return Worktree{}, fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	g.log.Info("worktree created", "repo", m.ID, "path", path, "branch", opts.Branch)
	if err := g.refresh(ctx, m.ID); err != nil {
		return Worktree{}, err
	}
	wt, ok := g.Snapshot().Worktree(m.ID, path)
	if !ok {
		return Worktree{}, fmt.Errorf("repo: created worktree %s is missing from git worktree list", path)
	}
	return wt, nil
}

// defaultBase is origin/<default branch> when that ref exists, else <default branch>.
func (g *Git) defaultBase(ctx context.Context, m *repoMeta) string {
	def := cmp.Or(m.DefaultBranch, "main")
	if g.refExists(ctx, m.Path, "refs/remotes/origin/"+def) {
		return "origin/" + def
	}
	return def
}

func (g *Git) refExists(ctx context.Context, dir, ref string) bool {
	_, err := g.runner.Run(ctx, dir, "rev-parse", "--verify", "--quiet", ref)
	return err == nil
}

// RemoveWorktree implements Store.
func (g *Git) RemoveWorktree(ctx context.Context, opts RemoveWorktreeOptions) error {
	st := g.repo(opts.RepoID)
	if st == nil {
		return fmt.Errorf("%w: repo %q", ErrNotFound, opts.RepoID)
	}
	m := st.meta.Load()
	path := filepath.Clean(opts.Path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	wt, ok := g.Snapshot().Worktree(m.ID, path)
	if !ok {
		return fmt.Errorf("%w: worktree %q in repo %s", ErrNotFound, opts.Path, m.ID)
	}
	if wt.IsMain {
		return fmt.Errorf("%w: cannot remove the main worktree", ErrInvalidArgument)
	}
	ctx, cancel := context.WithTimeout(ctx, worktreeTimeout)
	defer cancel()
	args := []string{"worktree", "remove"}
	if opts.Force {
		args = append(args, "--force")
	}
	args = append(args, path)
	if _, err := g.runner.Run(ctx, m.Path, args...); err != nil {
		return fmt.Errorf("%w: %w", ErrFailedPrecondition, err)
	}
	g.log.Info("worktree removed", "repo", m.ID, "path", path)
	var branchErr error
	if opts.DeleteBranch && wt.Branch != "" {
		if _, err := g.runner.Run(ctx, m.Path, "branch", "-D", wt.Branch); err != nil {
			branchErr = fmt.Errorf("%w: worktree removed, but deleting branch %s failed: %w", ErrFailedPrecondition, wt.Branch, err)
		}
	}
	if err := g.sched.wait(ctx, jobKey{kind: jobReconcile, repoID: m.ID}); err != nil {
		return errors.Join(branchErr, err)
	}
	return branchErr
}

// --- jobs ------------------------------------------------------------------------

func (g *Git) runJob(ctx context.Context, k jobKey) {
	switch k.kind {
	case jobReconcile:
		g.reconcile(ctx, k.repoID)
	case jobStatus:
		g.status(ctx, k.repoID, k.path)
		g.detailAfterStatus(k.repoID, k.path)
	case jobDetail:
		g.detail(ctx, k.repoID, k.path)
	}
}

// reconcile re-lists a repo's worktrees and metadata, syncs slots and watches,
// publishes, then requests a status refresh of every worktree.
func (g *Git) reconcile(ctx context.Context, id string) {
	st := g.repo(id)
	if st == nil {
		return
	}
	prev := st.meta.Load()
	next := *prev
	next.Error = ""
	listed, err := g.inspect(ctx, &next)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		next.Error = err.Error()
		listed = nil
		g.log.Warn("reconcile failed", "repo", id, "path", next.Path, "err", err)
	}

	// Resolve linked worktrees' admin dirs outside the lock (file reads).
	admins := make(map[string]string, len(listed))
	for _, l := range listed[min(1, len(listed)):] {
		if a, err := readGitFile(l.Path); err == nil {
			admins[l.Path] = a
		}
	}

	g.mu.Lock()
	if g.repos[id] != st {
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
		if slot == nil {
			slot = &wtSlot{}
			slot.cur.Store(&Worktree{
				RepoID: id, Path: l.Path, Branch: l.Branch, Head: l.Head, IsMain: isMain, Detached: l.Detached,
			})
			st.wts[l.Path] = slot
			setChanged = true
		}
		slot.admin = admins[l.Path]
		wwts = append(wwts, watchWorktree{path: l.Path, isMain: isMain, admin: slot.admin})
	}
	for p := range st.wts {
		if !seen[p] {
			delete(st.wts, p)
			removed = append(removed, p)
			setChanged = true
		}
	}
	metaChanged := next != *prev
	if metaChanged {
		st.meta.Store(&next)
	}
	var want map[string]watchTarget
	if next.Error == "" {
		want = desiredWatches(id, next.Path, next.commonDir(), wwts)
	}
	var toRemove []string
	for dir, t := range g.watches {
		if t.repoID != id {
			continue
		}
		if w, ok := want[dir]; ok && w == t {
			delete(want, dir) // already watched as the same target
			continue
		}
		toRemove = append(toRemove, dir)
		delete(g.watches, dir)
	}
	g.mu.Unlock()

	g.syncWatches(id, st, want, toRemove)

	if metaChanged || setChanged {
		g.commit(func(s *Snapshot) []Event {
			var evs []Event
			for _, p := range removed {
				evs = append(evs, WorktreeRemoved{RepoID: id, Path: p})
			}
			return append(evs, repoUpdated(id)(s)...)
		})
	}
	for _, k := range g.statusKeys(id) {
		g.sched.request(k)
	}
}

// syncWatches removes stale watches and adds wanted ones. Directories that do not
// exist yet (refs/remotes/origin before the first fetch, worktrees/ before the first
// linked worktree) are skipped; an event on their parent triggers a reconcile that
// retries.
func (g *Git) syncWatches(id string, st *repoState, want map[string]watchTarget, toRemove []string) {
	for _, d := range toRemove {
		_ = g.watcher.Remove(d)
	}
	added := map[string]watchTarget{}
	for dir, t := range want {
		if err := g.watcher.Add(dir); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				g.log.Warn("watch failed", "repo", id, "dir", dir, "err", err)
			}
			continue
		}
		added[dir] = t
	}
	g.mu.Lock()
	stillRegistered := g.repos[id] == st
	if stillRegistered {
		for dir, t := range added {
			g.watches[dir] = t
		}
	}
	g.mu.Unlock()
	if !stillRegistered {
		for dir := range added {
			_ = g.watcher.Remove(dir)
		}
	}
}

// inspect fills m's git-derived fields and returns the listed worktrees, main first,
// without bare or prunable entries.
func (g *Git) inspect(ctx context.Context, m *repoMeta) ([]listedWorktree, error) {
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

	m.OriginURL = ""
	if out, err := g.runner.Run(ctx, m.Path, "remote", "get-url", "origin"); err == nil {
		m.OriginURL = string(trimNL(out))
	}
	m.GitHubSlug = parseGitHubSlug(m.OriginURL)
	m.DefaultBranch = g.defaultBranch(ctx, m.Path, listed[0].Branch)
	return listed, nil
}

// defaultBranch is origin/HEAD's target, else main or master if they exist locally,
// else the main worktree's branch, else "main".
func (g *Git) defaultBranch(ctx context.Context, dir, mainBranch string) string {
	if out, err := g.runner.Run(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err == nil {
		if b := parseOriginHead(out); b != "" {
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
func (g *Git) status(ctx context.Context, repoID, path string) {
	st := g.repo(repoID)
	slot := g.slot(repoID, path)
	if st == nil || slot == nil {
		return
	}
	prev := *slot.cur.Load()
	next := prev
	now := g.now()

	out, err := g.runner.Run(ctx, path, "status", "--porcelain=v2", "--branch", "-z")
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
		g.log.Debug("status failed", "repo", repoID, "path", path, "err", err)
	} else {
		next.Branch, next.Head, next.Detached = info.Branch, info.Head, info.Detached
		next.Status = Status{
			Upstream: info.Upstream, Ahead: info.Ahead, Behind: info.Behind,
			Staged: info.Staged, Modified: info.Modified, Untracked: info.Untracked,
			Conflicted:  info.Conflicted,
			Dirty:       info.Staged+info.Modified+info.Untracked+info.Conflicted > 0,
			RefreshedAt: now,
		}
		if def := st.meta.Load().DefaultBranch; def != "" && info.Head != "" {
			ref := "refs/remotes/origin/" + def
			if out, err := g.runner.Run(ctx, path, "rev-list", "--left-right", "--count", "HEAD..."+ref); err == nil {
				if a, b, err := parseLeftRightCount(out); err == nil {
					next.Status.BaseRef, next.Status.BaseAhead, next.Status.BaseBehind = "origin/"+def, a, b
				}
			}
		}
	}

	if g.slot(repoID, path) != slot {
		return // removed while we ran
	}
	slot.cur.Store(&next)
	changed := next.Branch != prev.Branch || next.Head != prev.Head || next.Detached != prev.Detached ||
		!next.Status.equalIgnoringTime(prev.Status)
	if !changed {
		g.commit(nil)
		return
	}
	g.commit(func(s *Snapshot) []Event {
		if w, ok := s.Worktree(repoID, path); ok {
			return []Event{WorktreeUpdated{Worktree: w}}
		}
		return nil
	})
}

// --- loops -----------------------------------------------------------------------

func (g *Git) watchLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case err, ok := <-g.watcher.Errors:
			if !ok {
				return
			}
			g.log.Warn("watcher error", "err", err)
		case ev, ok := <-g.watcher.Events:
			if !ok {
				return
			}
			for _, k := range g.keysFor(ev) {
				g.deb.trigger(k)
			}
		}
	}
}

// keysFor maps an fs event to the jobs it should trigger.
func (g *Git) keysFor(ev fsnotify.Event) []jobKey {
	g.mu.RLock()
	t, self := g.watches[ev.Name]
	g.mu.RUnlock()
	var act action
	switch {
	case self && (ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename)):
		// A watched directory itself went away (worktree deleted by hand, repo moved).
		act = actReconcile
	default:
		g.mu.RLock()
		t, self = g.watches[filepath.Dir(ev.Name)]
		g.mu.RUnlock()
		if !self {
			return nil
		}
		act = classify(t.kind, filepath.Base(ev.Name), ev.Op)
	}
	if act != actNone {
		g.log.Debug("fs event", "path", ev.Name, "op", ev.Op.String(), "kind", t.kind.String(), "action", act.String())
	}
	switch act {
	case actStatus:
		return []jobKey{{kind: jobStatus, repoID: t.repoID, path: t.wtPath}}
	case actStatusAll:
		return g.statusKeys(t.repoID)
	case actReconcile:
		return []jobKey{{kind: jobReconcile, repoID: t.repoID}}
	}
	return nil
}

// fetchLoop fetches every repo, one at a time, every interval. The first round runs
// shortly after start, once the initial reconcile has learned each repo's origin.
func (g *Git) fetchLoop(ctx context.Context, every time.Duration) {
	t := time.NewTimer(min(every, firstFetchDelay))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, id := range g.repoIDs() {
			if ctx.Err() != nil {
				return
			}
			g.fetch(ctx, id)
		}
		t.Reset(every)
	}
}

// firstFetchDelay is when the first fetch round runs after Start.
const firstFetchDelay = 10 * time.Second

func (g *Git) fetch(ctx context.Context, id string) {
	st := g.repo(id)
	if st == nil {
		return
	}
	m := st.meta.Load()
	if m.OriginURL == "" || m.Error != "" {
		return
	}
	fctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	if _, err := g.runner.Run(fctx, m.Path, "fetch", "--prune", "--quiet"); err != nil {
		if ctx.Err() == nil {
			g.log.Warn("fetch failed", "repo", id, "path", m.Path, "err", err)
		}
		return
	}
	// The watcher sees FETCH_HEAD too; requesting here makes it independent of fs events.
	g.sched.request(jobKey{kind: jobReconcile, repoID: id})
}

func (g *Git) pollLoop(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		for _, id := range g.repoIDs() {
			if st := g.repo(id); st != nil && st.meta.Load().Error != "" {
				// Failed repos have no watches left; retry so a moved-back repo recovers.
				g.sched.request(jobKey{kind: jobReconcile, repoID: id})
				continue
			}
			for _, k := range g.statusKeys(id) {
				g.sched.request(k)
			}
		}
	}
}
