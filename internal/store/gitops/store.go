package gitops

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Defaults for Options.
const (
	DefaultWorkers = 4
	// KeepFinished is how many finished ops the snapshot keeps.
	KeepFinished = 20
	// MaxOutput caps Op.Output; the tail is kept.
	MaxOutput = 64 << 10
	// RefreshTimeout bounds the repo refresh after an operation.
	RefreshTimeout = 30 * time.Second
)

// DefaultTimeouts bound each kind of operation, from start to finish.
var DefaultTimeouts = map[Kind]time.Duration{
	KindFetch:      3 * time.Minute,
	KindPull:       3 * time.Minute,
	KindPush:       3 * time.Minute,
	KindPRCreate:   3 * time.Minute,
	KindPROpen:     time.Minute,
	KindOpenEditor: 20 * time.Second,
	KindReveal:     10 * time.Second,
	KindOpenURL:    10 * time.Second,
}

// Options configures New.
type Options struct {
	// Bus receives Event. Required.
	Bus *bus.Bus
	// Repos maps paths to repos and is refreshed after ref-moving operations. May be nil
	// (no repo ids, slugs or refreshes).
	Repos Repos
	Log   *slog.Logger
	// Runner runs processes. Default ExecRunner{}.
	Runner Runner
	// Workers bounds operations running at once across worktrees. Default DefaultWorkers.
	Workers int
	// Timeouts override DefaultTimeouts per kind.
	Timeouts map[Kind]time.Duration
	// Editor returns the editor command setting: shell-style words, optionally with
	// PathPlaceholder; "" means detect (see resolveEditor). Read on every open, so a
	// settings store can feed it live. Nil means "".
	Editor func() string
	// Git, Gh and Open are the executables. Defaults: "git" from PATH, gh from
	// LookPathGh, /usr/bin/open.
	Git, Gh, Open string
	// Now is the clock. Default time.Now.
	Now func() time.Time

	editorEnv *editorEnv // tests
}

// Manager is the daemon's Store.
type Manager struct {
	opts  Options
	log   *slog.Logger
	lanes *lanes
	ctx   context.Context // cancelled by Close: kills running ops
	stop  context.CancelFunc
	seq   atomic.Uint64

	mu       sync.Mutex // guards closed, active, finished, snapshot publication
	closed   bool
	active   []*Op // queued and running, in queue order
	finished []Op  // newest first, at most KeepFinished
	snap     atomic.Pointer[Snapshot]
	bg       sync.WaitGroup // post-op refreshes
}

var _ Store = (*Manager)(nil)

// New returns a Manager. Close stops it.
func New(o Options) *Manager {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Runner == nil {
		o.Runner = ExecRunner{}
	}
	if o.Workers <= 0 {
		o.Workers = DefaultWorkers
	}
	if o.Editor == nil {
		o.Editor = func() string { return "" }
	}
	if o.Git == "" {
		o.Git = "git"
	}
	if o.Open == "" {
		o.Open = "/usr/bin/open"
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{opts: o, log: o.Log, lanes: newLanes(o.Workers), ctx: ctx, stop: stop}
	m.snap.Store(&Snapshot{})
	return m
}

// Close rejects new operations, kills running ones, and waits for every lane to drain.
func (m *Manager) Close() error {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.stop()
	m.lanes.wait()
	m.bg.Wait()
	return nil
}

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

func (m *Manager) timeout(k Kind) time.Duration {
	if d, ok := m.opts.Timeouts[k]; ok && d > 0 {
		return d
	}
	return DefaultTimeouts[k]
}

// target is where an operation runs, resolved against the repo snapshot.
type target struct {
	path   string // symlinks resolved
	repo   repo.Repo
	branch string // from the snapshot; ops that need it exactly re-read it from git
}

// resolve validates worktreePath (absolute, an existing directory) and finds the
// registered repo containing it: an exact worktree match, else the longest containing
// worktree path.
func (m *Manager) resolve(worktreePath string) (target, error) {
	if worktreePath == "" {
		return target{}, fmt.Errorf("%w: worktree path is required", ErrInvalidArgument)
	}
	if !filepath.IsAbs(worktreePath) {
		return target{}, fmt.Errorf("%w: worktree path %q is not absolute", ErrInvalidArgument, worktreePath)
	}
	p, err := filepath.EvalSymlinks(filepath.Clean(worktreePath))
	if err != nil {
		return target{}, fmt.Errorf("%w: worktree path: %v", ErrInvalidArgument, err)
	}
	if fi, err := os.Stat(p); err != nil || !fi.IsDir() {
		return target{}, fmt.Errorf("%w: %s is not a directory", ErrInvalidArgument, worktreePath)
	}
	t := target{path: p}
	if r, w, ok := m.lookup(p); ok {
		t.repo, t.branch = r, w.Branch
	}
	// The repo snapshot can trail a `git switch` by a debounce; titles should name the
	// branch that is actually checked out.
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
	defer cancel()
	if b, ok := (&run{m: m, dir: p}).probe(ctx, "symbolic-ref", "--quiet", "--short", "HEAD"); ok && b != "" {
		t.branch = b
	}
	return t, nil
}

func (m *Manager) lookup(path string) (repo.Repo, repo.Worktree, bool) {
	if m.opts.Repos == nil {
		return repo.Repo{}, repo.Worktree{}, false
	}
	var best repo.Worktree
	var bestRepo repo.Repo
	found := false
	for _, r := range m.opts.Repos.Snapshot().Repos {
		for _, w := range r.Worktrees {
			if w.Path == path {
				return r, w, true
			}
			if strings.HasPrefix(path, w.Path+string(filepath.Separator)) && len(w.Path) > len(best.Path) {
				best, bestRepo, found = w, r, true
			}
		}
	}
	return bestRepo, best, found
}

// GitHubSlug implements Store.
func (m *Manager) GitHubSlug(repoID, worktreePath string) string {
	r, _ := m.repoFor(repoID, worktreePath)
	return r.GitHubSlug
}

// LocalOnly implements Store.
func (m *Manager) LocalOnly(repoID, worktreePath string) bool {
	r, ok := m.repoFor(repoID, worktreePath)
	return ok && IsLocalOnly(r)
}

// repoFor returns the registered repo containing worktreePath, else repo repoID.
func (m *Manager) repoFor(repoID, worktreePath string) (repo.Repo, bool) {
	if m.opts.Repos == nil {
		return repo.Repo{}, false
	}
	if worktreePath != "" {
		p := worktreePath
		if rp, err := filepath.EvalSymlinks(worktreePath); err == nil {
			p = rp
		}
		if r, _, ok := m.lookup(p); ok {
			return r, true
		}
	}
	if repoID != "" {
		return m.opts.Repos.Snapshot().Repo(repoID)
	}
	return repo.Repo{}, false
}

// body is an operation's work. It returns the summary and URL on success; on error,
// the op fails with the error's message as summary (see opError).
type body func(ctx context.Context, x *run) (summary, url string, err error)

// opError fails an operation with a summary picked from the command output.
type opError struct{ summary string }

func (e *opError) Error() string { return e.summary }

// submit runs b on t's lane and waits for it. The operation runs on the store's
// context, not ctx: once queued it completes even if the caller goes away (a push
// should not be half-cancelled because a CLI was interrupted). ctx only bounds the wait.
func (m *Manager) submit(ctx context.Context, kind Kind, title string, t target, refresh bool, b body) (Op, error) {
	op := &Op{
		ID:           "op-" + strconv.FormatUint(m.seq.Add(1), 10),
		Kind:         kind,
		State:        StateQueued,
		Title:        title,
		WorktreePath: t.path,
		RepoID:       t.repo.ID,
		Branch:       t.branch,
		QueuedAt:     m.opts.Now(),
	}
	done := make(chan Op, 1)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Op{}, ErrClosed
	}
	m.active = append(m.active, op)
	waits := m.lanes.submit(t.path, func() { done <- m.execute(op, refresh, b) })
	if waits {
		m.publishLocked(Queued, *op)
	}
	m.mu.Unlock()

	select {
	case res := <-done:
		return res, nil
	case <-ctx.Done():
		return Op{}, ctx.Err()
	}
}

func (m *Manager) execute(op *Op, refresh bool, b body) Op {
	m.mu.Lock()
	op.State = StateRunning
	op.StartedAt = m.opts.Now()
	m.publishLocked(Started, *op)
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(m.ctx, m.timeout(op.Kind))
	defer cancel()
	x := &run{m: m, dir: op.WorktreePath}
	summary, url, err := b(ctx, x)
	if err != nil {
		switch {
		case ctx.Err() == context.DeadlineExceeded:
			summary = fmt.Sprintf("timed out after %s", m.timeout(op.Kind))
		case m.ctx.Err() != nil:
			summary = "cancelled: daemon is shutting down"
		default:
			summary = err.Error()
		}
	}

	m.mu.Lock()
	op.FinishedAt = m.opts.Now()
	op.Duration = op.FinishedAt.Sub(op.StartedAt)
	op.Summary, op.URL, op.Output = summary, url, x.output()
	op.State = StateSucceeded
	if err != nil {
		op.State = StateFailed
	}
	final := *op
	m.active = slices.DeleteFunc(m.active, func(o *Op) bool { return o == op })
	m.finished = append([]Op{final}, m.finished...)
	if len(m.finished) > KeepFinished {
		m.finished = m.finished[:KeepFinished]
	}
	m.publishLocked(Finished, final)
	if refresh && final.RepoID != "" && m.opts.Repos != nil {
		m.bg.Go(func() { m.refresh(final.RepoID) })
	}
	m.mu.Unlock()
	m.log.Info("gitops", "op", final.ID, "kind", final.Kind.String(), "path", final.WorktreePath,
		"ok", final.OK(), "summary", final.Summary, "duration", final.Duration)
	return final
}

// refresh asks the repo store to re-read the repo after its refs moved.
func (m *Manager) refresh(repoID string) {
	ctx, cancel := context.WithTimeout(m.ctx, RefreshTimeout)
	defer cancel()
	if err := m.opts.Repos.Refresh(ctx, repoID); err != nil && m.ctx.Err() == nil {
		m.log.Warn("gitops: repo refresh", "repo", repoID, "err", err)
	}
}

// publishLocked rebuilds the snapshot and publishes ev. Holding mu keeps events in
// order and each one consistent with the snapshot at publish time.
func (m *Manager) publishLocked(t EventType, op Op) {
	s := &Snapshot{Ops: make([]Op, 0, len(m.active)+len(m.finished))}
	for _, o := range m.active {
		s.Ops = append(s.Ops, *o)
	}
	s.Ops = append(s.Ops, m.finished...)
	m.snap.Store(s)
	bus.Publish(m.opts.Bus, Event{Type: t, Op: op})
}

// run is one operation's execution: it runs commands in the worktree and keeps the
// transcript.
type run struct {
	m   *Manager
	dir string
	out strings.Builder
}

// exec runs c, appends "$ <cmd>" and its output to the transcript, and returns the
// result. A non-zero exit becomes an *opError with a summary from the output.
func (x *run) exec(ctx context.Context, c Cmd) (Result, error) {
	if c.Dir == "" {
		c.Dir = x.dir
	}
	fmt.Fprintf(&x.out, "$ %s\n", c)
	res := x.m.opts.Runner.Run(ctx, c)
	// Progress lines ("Rebasing (1/1)\r") would render as one run-on line in the GUI.
	out := strings.ReplaceAll(strings.ReplaceAll(res.Combined, "\r\n", "\n"), "\r", "\n")
	x.out.WriteString(out)
	if out != "" && !strings.HasSuffix(out, "\n") {
		x.out.WriteByte('\n')
	}
	if res.Err != nil {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		if res.ExitCode < 0 {
			fmt.Fprintf(&x.out, "%v\n", res.Err)
			return res, &opError{summary: fmt.Sprintf("%s: %v", displayName(c.Name), res.Err)}
		}
		fmt.Fprintf(&x.out, "(exit %d)\n", res.ExitCode)
		return res, &opError{summary: failureSummary(res.Combined)}
	}
	return res, nil
}

func (x *run) git(ctx context.Context, args ...string) (Result, error) {
	return x.exec(ctx, Cmd{Name: x.m.opts.Git, Args: args})
}

// probe runs a read-only git query that is not part of the transcript (its failure is
// an answer, not an error) and returns trimmed stdout and whether it exited 0.
func (x *run) probe(ctx context.Context, args ...string) (string, bool) {
	res := x.m.opts.Runner.Run(ctx, Cmd{Dir: x.dir, Name: x.m.opts.Git, Args: args})
	return strings.TrimSpace(res.Stdout), res.Err == nil
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// note appends a line to the transcript.
func (x *run) note(format string, a ...any) {
	fmt.Fprintf(&x.out, format+"\n", a...)
}

func (x *run) output() string {
	s := x.out.String()
	if len(s) > MaxOutput {
		s = "…(truncated)\n" + strings.ToValidUTF8(s[len(s)-MaxOutput:], "")
	}
	return s
}
