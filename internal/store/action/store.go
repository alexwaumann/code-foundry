package action

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
)

// Defaults for Options.
const (
	// DefaultOutputLimit is how much of a background run's output is kept: the tail.
	DefaultOutputLimit = 64 << 10
	// DefaultRunHistory is how many runs are remembered per project. Running ones are
	// never forgotten.
	DefaultRunHistory = 50
	// DefaultKillGrace is how long a background run gets after SIGTERM before SIGKILL.
	DefaultKillGrace = 3 * time.Second
	// MaxNameLen bounds an action's name (runes).
	MaxNameLen = 64
)

// RepoSource is the part of the repo store actions need. *repo.Git implements it.
type RepoSource interface {
	Snapshot() *repo.Snapshot
}

// Options configures a Manager. DB and Repos are required.
type Options struct {
	DB    *sql.DB
	Repos RepoSource
	// Terminals runs terminal-mode actions. Nil refuses them.
	Terminals terminal.Store
	// Session resolves a thread to its owner (project and worktree). Nil: runs need a
	// worktree.
	Session func(id string) (Owner, bool)
	Bus     *bus.Bus     // default: a private bus
	Log     *slog.Logger // default: slog.Default()
	// Shell is the shell that runs commands (`<Shell> -lc <command>`). Default: $SHELL,
	// else /bin/zsh.
	Shell string
	// Env entries "KEY=VALUE" are added to every run's environment, under the run's own
	// variables. Background runs start from os.Environ(); terminal runs from the
	// terminal store's environment.
	Env []string
	// OutputLimit, RunHistory and KillGrace default to the package constants.
	OutputLimit int
	RunHistory  int
	KillGrace   time.Duration
	Now         func() time.Time
}

// Manager is the Store backed by SQLite, the repo store and the terminal store.
type Manager struct {
	opts   Options
	log    *slog.Logger
	ctx    context.Context // cancelled by Close
	cancel context.CancelFunc
	wg     sync.WaitGroup // run waiters and worktree-create sequences

	// mu guards everything below and serializes mutations. Reads use snap.
	mu     sync.Mutex
	byID   map[string]Action
	runs   map[string]*runRec
	closed bool
	snap   atomic.Pointer[Snapshot]
}

var _ Store = (*Manager)(nil)

// New loads persisted actions and returns the Manager. Close it to kill background
// runs.
func New(ctx context.Context, opts Options) (*Manager, error) {
	if opts.DB == nil || opts.Repos == nil {
		return nil, errors.New("action: Options.DB and Options.Repos are required")
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Shell == "" {
		opts.Shell = cmp.Or(os.Getenv("SHELL"), "/bin/zsh")
	}
	if opts.OutputLimit <= 0 {
		opts.OutputLimit = DefaultOutputLimit
	}
	if opts.RunHistory <= 0 {
		opts.RunHistory = DefaultRunHistory
	}
	if opts.KillGrace <= 0 {
		opts.KillGrace = DefaultKillGrace
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	rows, err := loadActions(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, byID: make(map[string]Action, len(rows)), runs: map[string]*runRec{}}
	m.ctx, m.cancel = context.WithCancel(context.WithoutCancel(ctx))
	for _, a := range rows {
		m.byID[a.ID] = a
	}
	m.rebuild()
	return m, nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

// rebuild publishes a new snapshot. Callers hold m.mu (or own m exclusively).
func (m *Manager) rebuild() {
	as := make([]Action, 0, len(m.byID))
	for _, a := range m.byID {
		as = append(as, a)
	}
	slices.SortFunc(as, func(a, b Action) int {
		return cmp.Or(cmp.Compare(a.RepoID, b.RepoID), cmp.Compare(a.Position, b.Position), cmp.Compare(a.Name, b.Name))
	})
	rs := make([]Run, 0, len(m.runs))
	for _, r := range m.runs {
		rs = append(rs, r.public(false))
	}
	sortRuns(rs)
	m.snap.Store(&Snapshot{Actions: as, Runs: rs})
}

// sortRuns orders runs newest first.
func sortRuns(rs []Run) {
	slices.SortFunc(rs, func(a, b Run) int {
		return cmp.Or(b.StartedAt.Compare(a.StartedAt), cmp.Compare(b.ID, a.ID))
	})
}

// repoActions returns repoID's actions in position order. Callers hold m.mu.
func (m *Manager) repoActions(repoID string) []Action {
	var out []Action
	for _, a := range m.byID {
		if a.RepoID == repoID {
			out = append(out, a)
		}
	}
	slices.SortFunc(out, func(a, b Action) int {
		return cmp.Or(cmp.Compare(a.Position, b.Position), cmp.Compare(a.Name, b.Name))
	})
	return out
}

// Create implements Store.
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Action, error) {
	name, err := cleanName(o.Name)
	if err != nil {
		return Action{}, err
	}
	command, err := cleanCommand(o.Command)
	if err != nil {
		return Action{}, err
	}
	icon, err := cleanIcon(o.Icon)
	if err != nil {
		return Action{}, err
	}
	if _, ok := m.opts.Repos.Snapshot().Repo(o.RepoID); !ok {
		return Action{}, fmt.Errorf("%w: project %q is not registered", ErrNotFound, o.RepoID)
	}
	id, err := newID("a-")
	if err != nil {
		return Action{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	existing := m.repoActions(o.RepoID)
	if err := nameFree(existing, name, ""); err != nil {
		return Action{}, err
	}
	now := m.opts.Now().Truncate(time.Millisecond)
	a := Action{
		ID: id, RepoID: o.RepoID, Name: name, Command: command, Icon: icon,
		InTerminal: o.InTerminal, OnWorktreeCreate: o.OnWorktreeCreate,
		Position: len(existing), CreatedAt: now, UpdatedAt: now,
	}
	if err := insertAction(context.WithoutCancel(ctx), m.opts.DB, a); err != nil {
		return Action{}, err
	}
	m.byID[a.ID] = a
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Updated{Action: a})
	m.log.Info("action created", "action", a.ID, "repo", a.RepoID, "name", a.Name)
	return a, nil
}

// Update implements Store.
func (m *Manager) Update(ctx context.Context, o UpdateOptions) (Action, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.byID[o.ID]
	if !ok {
		return Action{}, fmt.Errorf("%w: action %q", ErrNotFound, o.ID)
	}
	siblings := m.repoActions(a.RepoID)
	if o.Name != nil {
		name, err := cleanName(*o.Name)
		if err != nil {
			return Action{}, err
		}
		if err := nameFree(siblings, name, a.ID); err != nil {
			return Action{}, err
		}
		a.Name = name
	}
	if o.Command != nil {
		command, err := cleanCommand(*o.Command)
		if err != nil {
			return Action{}, err
		}
		a.Command = command
	}
	if o.Icon != nil {
		icon, err := cleanIcon(*o.Icon)
		if err != nil {
			return Action{}, err
		}
		a.Icon = icon
	}
	if o.InTerminal != nil {
		a.InTerminal = *o.InTerminal
	}
	if o.OnWorktreeCreate != nil {
		a.OnWorktreeCreate = *o.OnWorktreeCreate
	}
	a.UpdatedAt = m.opts.Now().Truncate(time.Millisecond)
	// The project's list with a in its (new) place, renumbered 0..n-1.
	order := slices.DeleteFunc(slices.Clone(siblings), func(x Action) bool { return x.ID == a.ID })
	at := slices.IndexFunc(siblings, func(x Action) bool { return x.ID == a.ID })
	if o.Position != nil {
		at = min(max(*o.Position, 0), len(order))
	}
	order = slices.Insert(order, at, a)
	var changed []Action
	for i, x := range order {
		if x.ID == a.ID || x.Position != i {
			if x.ID != a.ID {
				x.UpdatedAt = a.UpdatedAt
			}
			x.Position = i
			changed = append(changed, x)
		}
	}
	if err := saveActions(context.WithoutCancel(ctx), m.opts.DB, changed); err != nil {
		return Action{}, err
	}
	for _, x := range changed {
		m.byID[x.ID] = x
	}
	m.rebuild()
	for _, x := range changed {
		bus.Publish[Event](m.opts.Bus, Updated{Action: x})
	}
	return m.byID[a.ID], nil
}

// Delete implements Store. The action's runs keep going.
func (m *Manager) Delete(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.byID[id]
	if !ok {
		return fmt.Errorf("%w: action %q", ErrNotFound, id)
	}
	if err := deleteAction(context.WithoutCancel(ctx), m.opts.DB, id); err != nil {
		return err
	}
	delete(m.byID, id)
	// Close the gap so positions stay 0..n-1.
	var moved []Action
	for i, x := range m.repoActions(a.RepoID) {
		if x.Position != i {
			x.Position = i
			moved = append(moved, x)
		}
	}
	if err := saveActions(context.WithoutCancel(ctx), m.opts.DB, moved); err != nil {
		m.log.Warn("renumber actions after a delete", "repo", a.RepoID, "err", err)
		moved = nil
	}
	for _, x := range moved {
		m.byID[x.ID] = x
	}
	m.rebuild()
	bus.Publish[Event](m.opts.Bus, Removed{ID: id})
	for _, x := range moved {
		bus.Publish[Event](m.opts.Bus, Updated{Action: x})
	}
	m.log.Info("action deleted", "action", id, "repo", a.RepoID, "name", a.Name)
	return nil
}

// RepoRemoved forgets an unregistered project's actions (the database cascades; this
// deletes them too and updates the snapshot) and its runs, killing the background ones
// still running. Its terminal runs are the shell reaper's: they carry the repo label.
func (m *Manager) RepoRemoved(ctx context.Context, repoID string) {
	if repoID == "" {
		return
	}
	if err := deleteRepoActions(context.WithoutCancel(ctx), m.opts.DB, repoID); err != nil {
		m.log.Warn("forget an unregistered project's actions", "repo", repoID, "err", err)
	}
	m.mu.Lock()
	var gone []string
	for id, a := range m.byID {
		if a.RepoID == repoID {
			delete(m.byID, id)
			gone = append(gone, id)
		}
	}
	var dropped []string
	for id, r := range m.runs {
		if r.run.RepoID == repoID {
			r.kill(m.opts.KillGrace)
			delete(m.runs, id)
			dropped = append(dropped, id)
		}
	}
	if len(gone)+len(dropped) > 0 {
		m.rebuild()
	}
	m.mu.Unlock()
	slices.Sort(gone)
	slices.Sort(dropped)
	for _, id := range gone {
		bus.Publish[Event](m.opts.Bus, Removed{ID: id})
	}
	for _, id := range dropped {
		bus.Publish[Event](m.opts.Bus, RunRemoved{ID: id})
	}
	if len(gone)+len(dropped) > 0 {
		m.log.Info("forgot an unregistered project's actions and runs", "repo", repoID, "actions", len(gone), "runs", len(dropped))
	}
}

// KillRuns kills every running background run match accepts (the daemon passes a
// removed thread's or worktree's). Terminal runs are left to the shell reaper. It
// returns how many it signalled.
func (m *Manager) KillRuns(match func(Run) bool) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.runs {
		if r.run.Mode == ModeBackground && r.run.State == RunRunning && match(r.run) {
			r.kill(m.opts.KillGrace)
			n++
		}
	}
	return n
}

// Close kills every running background run and waits for them (and the store's
// goroutines) until ctx ends. Terminal runs end with the terminal store.
func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	n := 0
	for _, r := range m.runs {
		if r.run.Mode == ModeBackground && r.run.State == RunRunning {
			r.kill(m.opts.KillGrace)
			n++
		}
	}
	m.mu.Unlock()
	if n > 0 {
		m.log.Info("killing background action runs", "count", n)
	}
	m.cancel()
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("action: close: %w", ctx.Err())
	}
}

// cleanName trims a name and refuses an empty, long or multi-line one.
func cleanName(s string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", fmt.Errorf("%w: an action needs a name", ErrInvalidArgument)
	case len([]rune(s)) > MaxNameLen:
		return "", fmt.Errorf("%w: an action name has at most %d characters", ErrInvalidArgument, MaxNameLen)
	case strings.IndexFunc(s, unicode.IsControl) >= 0:
		return "", fmt.Errorf("%w: an action name is one line without control characters", ErrInvalidArgument)
	}
	return s, nil
}

// cleanCommand drops trailing whitespace and a CRLF's CRs; a command may span lines (the
// shell runs it as a script) but not be blank or hold a NUL.
func cleanCommand(s string) (string, error) {
	s = strings.TrimRight(strings.ReplaceAll(s, "\r\n", "\n"), " \t\r\n")
	switch {
	case strings.TrimSpace(s) == "":
		return "", fmt.Errorf("%w: an action needs a command", ErrInvalidArgument)
	case strings.ContainsRune(s, 0):
		return "", fmt.Errorf("%w: the command contains a NUL byte", ErrInvalidArgument)
	}
	return s, nil
}

func cleanIcon(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return IconPlay, nil
	}
	if !slices.Contains(Icons, s) {
		return "", fmt.Errorf("%w: icon %q; want one of %s", ErrInvalidArgument, s, strings.Join(Icons, ", "))
	}
	return s, nil
}

// nameFree refuses name when another action of the project (not self) has it, ignoring
// case.
func nameFree(siblings []Action, name, self string) error {
	for _, x := range siblings {
		if x.ID != self && strings.EqualFold(x.Name, name) {
			return fmt.Errorf("%w: this project already has an action named %q", ErrFailedPrecondition, x.Name)
		}
	}
	return nil
}

func newID(prefix string) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("action id: %w", err)
	}
	return prefix + hex.EncodeToString(b[:]), nil
}
