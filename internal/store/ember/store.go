package ember

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Threads is the thread store as Ember's store uses it (*thread.Manager).
type Threads interface {
	Snapshot() *thread.Snapshot
	Items(ctx context.Context, id string) (thread.ItemsSnapshot, error)
	EnsureResident(ctx context.Context, name string, o thread.ResidentOptions) (thread.Thread, bool, error)
	Reseed(ctx context.Context, id string, o thread.ReseedOptions) (thread.Thread, bool, error)
	SetModel(ctx context.Context, id, model string) (thread.Thread, error)
	SetEffort(ctx context.Context, id, effort string) (thread.Thread, error)
	SetPermissionMode(ctx context.Context, id string, mode thread.PermissionMode) (thread.Thread, error)
	Close(ctx context.Context, id string) error
	Unsubscribe(ctx context.Context, o thread.UnsubscribeOptions) ([]thread.Subscription, error)
	SetCreateDefaults(fn thread.CreateDefaultsFunc)
	SetResidentTools(name string, t thread.ResidentTools)
}

// Config is what the Ember store reads from the ember.* settings (and one threads.*
// one). The daemon maps the settings onto it (the store does not import the settings
// store) and calls ConfigChanged after every change.
type Config struct {
	// Enabled is ember.enabled.
	Enabled bool
	// Model and Effort are the resident's (ember.model, ember.effort).
	Model, Effort string
	// WorkerModels and WorkerEffort are its workers' (ember.worker_models,
	// ember.worker_effort).
	WorkerModels []string
	WorkerEffort string
	// EpochContextTokens and EpochMaxHours are the epoch limits.
	EpochContextTokens, EpochMaxHours int
	// ShowCreatedThreads is threads.show_created_threads: which threads PROJECTS.md
	// lists.
	ShowCreatedThreads bool
}

// Projects is the project store as PROJECTS.md reads it.
type Projects interface {
	Snapshot() *project.Snapshot
}

// Options configures New. DB, Threads, Config and Dir are required.
type Options struct {
	DB      *sql.DB
	Bus     *bus.Bus     // shared with the thread and settings stores; default a private one
	Log     *slog.Logger // default slog.Default()
	Threads Threads
	// Config reads the settings, at New and after every ConfigChanged.
	Config   func() Config
	Projects Projects // nil: PROJECTS.md lists none
	// Dir is Ember's home (<home>/residents/ember).
	Dir string
	// Consolidate runs the consolidation call. Default ClaudeRunner(Claude, Dir).
	Consolidate Runner
	// Claude is the claude executable for the default Consolidate. Default "claude".
	Claude string
	// OrchestrateSkill is the absolute path of the code-foundry-orchestrate skill's
	// directory (every thread's skills), named in PROJECTS.md. "": not named.
	OrchestrateSkill string
	// InstallSkill writes the code-foundry-ember skill under dir (Claude loads it from
	// dir/.claude/skills). nil: none.
	InstallSkill func(dir string) error
	// Now and Location are the clock and the zone of the seed's times. Defaults:
	// time.Now, time.Local.
	Now      func() time.Time
	Location *time.Location
	// CheckInterval is how often the epoch rules are checked besides every thread
	// change. Default time.Minute.
	CheckInterval time.Duration
	// ConsolidateTimeout bounds one consolidation call. Default 5 minutes.
	ConsolidateTimeout time.Duration
}

// Files and directories of Ember's home.
const (
	soulFile    = "SOUL.md"
	memoryFile  = "MEMORY.md"
	stateFile   = "state.json"
	seedDir     = "seed"
	skillsDir   = "skills"
	consolDir   = "consolidation"
	boardFile   = "BOARD.md"
	projectFile = "PROJECTS.md"
	recentFile  = "RECENT.md"
)

var (
	//go:embed files/rules.md
	rules string
	//go:embed files/soul.md
	defaultSoul string
	//go:embed files/memory.md
	defaultMemory string
	//go:embed files/consolidate.md
	consolidatePrompt string
)

// Rules are the built-in rules Ember's system prompt starts with.
func Rules() string { return rules }

// Tools are Ember's own permission rules (thread.ResidentTools): its CLI pre-allowed so
// it never asks the user for it, and no editing tool. git fetch only writes remote refs
// and FETCH_HEAD; allowing it keeps the safety classifier from being the gate when Ember
// checks a branch against origin.
var Tools = thread.ResidentTools{
	Allow: []string{
		"Bash(code-foundry ember:*)",
		"Bash(code-foundry thread:*)",
		"Bash(code-foundry project:*)",
		"Bash(code-foundry guide:*)",
		"Bash(code-foundry help:*)",
		"Bash(git log:*)",
		"Bash(git diff:*)",
		"Bash(git show:*)",
		"Bash(git status:*)",
		"Bash(git fetch:*)",
	},
	Deny: []string{"Edit", "Write", "NotebookEdit"},
}

// Store is the Ember store. Methods are safe for concurrent use.
type Store struct {
	opts   Options
	log    *slog.Logger
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// mu guards everything below.
	mu    sync.Mutex
	tasks []Task // without Thread, in board order
	// reset are the tasks New put back to todo (ResetAtStart).
	reset []Task
	st    persisted
	// cfg and enabled are the settings last applied (applySettings).
	cfg     Config
	enabled bool
	applied bool
	// consolidating: an epoch boundary runs (boundary).
	consolidating bool

	// configChanged wakes the loop to apply the settings (ConfigChanged).
	configChanged chan struct{}

	// epochMu serializes epoch boundaries; memMu MEMORY.md's read-modify-writes.
	epochMu sync.Mutex
	memMu   sync.Mutex

	snap atomic.Pointer[Snapshot]
}

// New loads the board and Ember's state, hooks the worker defaults and Ember's rules
// into the thread store, applies the settings (making the resident when Ember is on)
// and starts following thread and settings changes. Close stops it.
func New(ctx context.Context, opts Options) (*Store, error) {
	if opts.DB == nil || opts.Threads == nil || opts.Config == nil || opts.Dir == "" {
		return nil, errors.New("ember: Options.DB, Threads, Config and Dir are required")
	}
	if !filepath.IsAbs(opts.Dir) {
		return nil, fmt.Errorf("ember: Options.Dir %q is not absolute", opts.Dir)
	}
	if opts.Bus == nil {
		opts.Bus = bus.New()
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Location == nil {
		opts.Location = time.Local
	}
	if opts.CheckInterval <= 0 {
		opts.CheckInterval = time.Minute
	}
	if opts.ConsolidateTimeout <= 0 {
		opts.ConsolidateTimeout = 5 * time.Minute
	}
	if opts.Claude == "" {
		opts.Claude = "claude"
	}
	if opts.Consolidate == nil {
		opts.Consolidate = ClaudeRunner(opts.Claude, opts.Dir, opts.Log)
	}
	tasks, err := loadTasks(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	sortTasks(tasks)
	sctx, cancel := context.WithCancel(context.Background())
	s := &Store{opts: opts, log: opts.Log, ctx: sctx, cancel: cancel, tasks: tasks, st: loadState(opts.Log, opts.Dir),
		configChanged: make(chan struct{}, 1)}
	s.mu.Lock()
	s.reset = s.resetOrphansLocked(ctx, opts.Now())
	s.mu.Unlock()
	opts.Threads.SetResidentTools(Name, Tools)
	opts.Threads.SetCreateDefaults(s.workerDefaults)
	threadSub := bus.Subscribe[thread.Event](opts.Bus, 256)
	s.applySettings(ctx)
	s.onThreads()
	s.wg.Add(1)
	go s.run(threadSub)
	return s, nil
}

// Close stops following changes and waits for a running epoch boundary.
func (s *Store) Close() {
	s.cancel()
	s.wg.Wait()
	s.opts.Threads.SetCreateDefaults(nil)
}

// Snapshot returns the current snapshot. Never nil.
func (s *Store) Snapshot() *Snapshot {
	if p := s.snap.Load(); p != nil {
		return p
	}
	return &Snapshot{}
}

// ConfigChanged tells the store the settings changed: it applies them shortly, on its
// own goroutine. Never blocks.
func (s *Store) ConfigChanged() {
	select {
	case s.configChanged <- struct{}{}:
	default:
	}
}

// Dir is Ember's home.
func (s *Store) Dir() string { return s.opts.Dir }

// Await returns the first snapshot, the current one included, that done accepts, or
// ctx's error.
func (s *Store) Await(ctx context.Context, done func(*Snapshot) bool) (*Snapshot, error) {
	sub := bus.Subscribe[Changed](s.opts.Bus, 16)
	defer sub.Close()
	if snap := s.Snapshot(); done(snap) {
		return snap, nil
	}
	for {
		select {
		case <-ctx.Done():
			return s.Snapshot(), ctx.Err()
		case <-sub.C():
			if snap := s.Snapshot(); done(snap) {
				return snap, nil
			}
		}
	}
}

// run follows thread and settings changes and checks the epoch rules on a tick.
func (s *Store) run(threadSub *bus.Subscription[thread.Event]) {
	defer s.wg.Done()
	defer threadSub.Close()
	tick := time.NewTicker(s.opts.CheckInterval)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-threadSub.C():
			drain(threadSub.C())
			s.onThreads()
		case <-s.configChanged:
			s.applySettings(s.ctx)
			s.onThreads()
		case <-tick.C:
			s.onThreads()
		}
	}
}

// drain empties c: a burst of events is one look at the snapshots.
func drain[T any](c <-chan T) {
	for {
		select {
		case <-c:
		default:
			return
		}
	}
}

// applySettings applies the ember.* settings: enabling makes (or configures) the
// resident, disabling stops it; a model or effort change goes to the resident at once.
func (s *Store) applySettings(ctx context.Context) {
	cfg := s.opts.Config()
	s.mu.Lock()
	was, first, prev := s.enabled, !s.applied, s.cfg
	s.mu.Unlock()
	// Recorded once applied: the thread changes the actions make are looked at with the
	// new settings (onThreads runs on the same goroutine).
	defer func() {
		s.mu.Lock()
		s.cfg, s.enabled, s.applied = cfg, cfg.Enabled, true
		s.mu.Unlock()
		s.publish()
	}()
	switch {
	case cfg.Enabled && (first || !was):
		if err := s.enable(ctx, cfg); err != nil {
			s.log.Error("ember: enabling failed", "err", err)
		}
	case cfg.Enabled && (prev.Model != cfg.Model || prev.Effort != cfg.Effort):
		s.configure(ctx, cfg)
	case !cfg.Enabled && was:
		s.disable()
	}
}

// enable prepares Ember's home and makes its resident thread, seeded for its first
// epoch, or configures the one there is.
func (s *Store) enable(ctx context.Context, cfg Config) error {
	if err := s.prepareHome(); err != nil {
		return err
	}
	if t, ok := residentOf(s.opts.Threads.Snapshot()); ok {
		s.configure(ctx, cfg)
		if t.SystemPromptAppend == "" && t.SeedPrefix == "" {
			// Made without Ember's seed (by hand, or before this store): seed it now,
			// for its next session.
			sd, err := s.buildSeed(ctx, t.ID)
			if err != nil {
				return err
			}
			if _, _, err := s.opts.Threads.Reseed(ctx, t.ID, reseedOptions(sd, s.addDirs())); err != nil {
				return fmt.Errorf("ember: seed the resident thread: %w", err)
			}
			s.log.Info("ember: seeded a resident thread made without its seed", "thread", t.ID)
		}
		s.log.Info("ember enabled", "thread", t.ID)
		return nil
	}
	sd, err := s.buildSeed(ctx, "")
	if err != nil {
		return err
	}
	t, created, err := s.opts.Threads.EnsureResident(ctx, Name, thread.ResidentOptions{
		Cwd: s.opts.Dir, DisplayName: DisplayName, Model: cfg.Model, Effort: cfg.Effort, PermissionMode: thread.PermissionAuto,
		SystemPromptAppend: sd.system, AddDirs: s.addDirs(), Prefix: sd.prefix,
	})
	if err != nil {
		return fmt.Errorf("ember: make the resident thread: %w", err)
	}
	s.mu.Lock()
	if created || s.st.Epoch != t.Epoch {
		s.st.Epoch, s.st.EpochStartedAt = t.Epoch, s.opts.Now()
		s.saveStateLocked()
	}
	s.mu.Unlock()
	s.log.Info("ember enabled", "thread", t.ID, "created", created, "model", cfg.Model, "effort", cfg.Effort)
	return nil
}

// configure brings the resident's model, effort and permission mode in line with cfg.
func (s *Store) configure(ctx context.Context, cfg Config) {
	t, ok := residentOf(s.opts.Threads.Snapshot())
	if !ok {
		return
	}
	if cfg.Model != "" && t.Model != cfg.Model {
		if _, err := s.opts.Threads.SetModel(ctx, t.ID, cfg.Model); err != nil {
			s.log.Warn("ember: set the model", "thread", t.ID, "model", cfg.Model, "err", err)
		}
	}
	if cfg.Effort != "" && t.Effort != cfg.Effort {
		if _, err := s.opts.Threads.SetEffort(ctx, t.ID, cfg.Effort); err != nil {
			s.log.Warn("ember: set the effort", "thread", t.ID, "effort", cfg.Effort, "err", err)
		}
	}
	if t.PermissionMode != thread.PermissionAuto {
		if _, err := s.opts.Threads.SetPermissionMode(ctx, t.ID, thread.PermissionAuto); err != nil {
			s.log.Warn("ember: set the permission mode", "thread", t.ID, "err", err)
		}
	}
}

// disable stops the resident's process and removes its timers, in the background; the
// thread stays.
func (s *Store) disable() {
	t, ok := residentOf(s.opts.Threads.Snapshot())
	if !ok {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(s.ctx, time.Minute)
		defer cancel()
		if _, err := s.opts.Threads.Unsubscribe(ctx, thread.UnsubscribeOptions{SubscriberID: t.ID, TargetTimer: true}); err != nil &&
			!errors.Is(err, thread.ErrNotFound) {
			s.log.Warn("ember: remove its timers", "thread", t.ID, "err", err)
		}
		if t.State != thread.StateDisconnected {
			if err := s.opts.Threads.Close(ctx, t.ID); err != nil {
				s.log.Warn("ember: stop its process", "thread", t.ID, "err", err)
			}
		}
		s.log.Info("ember disabled", "thread", t.ID)
	}()
}

// prepareHome makes Ember's directories, writes SOUL.md and MEMORY.md when missing and
// installs its skill.
func (s *Store) prepareHome() error {
	for _, d := range []string{s.opts.Dir, filepath.Join(s.opts.Dir, seedDir), filepath.Join(s.opts.Dir, consolDir), s.skillsDir()} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return fmt.Errorf("ember: make %s: %w", d, err)
		}
	}
	for name, content := range map[string]string{soulFile: defaultSoul, memoryFile: defaultMemory} {
		p := filepath.Join(s.opts.Dir, name)
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			if err := writeAtomic(p, []byte(content)); err != nil {
				return err
			}
		}
	}
	if s.opts.InstallSkill != nil {
		if err := s.opts.InstallSkill(s.skillsDir()); err != nil {
			s.log.Error("ember: its skill is not installed", "dir", s.skillsDir(), "err", err)
		}
	}
	return nil
}

func (s *Store) skillsDir() string { return filepath.Join(s.opts.Dir, skillsDir) }

// addDirs are the resident's --add-dirs: its skill, then its seed.
func (s *Store) addDirs() []string {
	return []string{s.skillsDir(), filepath.Join(s.opts.Dir, seedDir)}
}

// onThreads looks at the threads: tasks whose worker failed or is blocked become
// blocked, the resident's epoch is followed, the snapshot republished when anything it
// derives changed, and an epoch boundary started when the rules say so.
func (s *Store) onThreads() {
	snap := s.opts.Threads.Snapshot()
	now := s.opts.Now()
	s.mu.Lock()
	s.blockFailedLocked(snap, now)
	res, ok := residentOf(snap)
	if ok && res.Epoch != s.st.Epoch {
		s.st.Epoch, s.st.EpochStartedAt = res.Epoch, now
		if res.Epoch == 1 && !res.CreatedAt.IsZero() {
			s.st.EpochStartedAt = res.CreatedAt
		}
		s.saveStateLocked()
	}
	reason := ""
	if ok && s.enabled && !s.consolidating {
		reason = epochDue(res, s.cfg, s.st.EpochStartedAt, now)
	}
	if reason != "" {
		s.consolidating = true
	}
	s.publishLocked(snap)
	s.mu.Unlock()
	if reason != "" {
		s.log.Info("ember: a new epoch is due", "thread", res.ID, "reason", reason, "context_tokens", res.ContextTokens,
			"epoch", res.Epoch)
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := s.boundary(s.ctx, res.ID); err != nil {
				s.log.Error("ember: new epoch", "thread", res.ID, "err", err)
			}
		}()
	}
}

// epochDue says why the resident t needs a new epoch now ("context", "age"), or "":
// only once it is quiet after a turn of the current epoch (not working, not starting, no
// pending request, no reseed or seed waiting), and then when its context passed
// cfg.EpochContextTokens or the epoch (started at started) is older than
// cfg.EpochMaxHours.
func epochDue(t thread.Thread, cfg Config, started, now time.Time) string {
	switch {
	case t.ReseedPending, t.SeedPrefix != "", t.FreshStart, t.PendingRequestID != "", t.WakePending,
		t.State == thread.StateStarting, t.Status == thread.StatusBusy:
		return ""
	case t.LastResultAt.IsZero() || !t.LastResultAt.After(started):
		return "" // no turn this epoch
	case cfg.EpochContextTokens > 0 && t.ContextTokens > int64(cfg.EpochContextTokens):
		return "context"
	case cfg.EpochMaxHours > 0 && now.Sub(started) > time.Duration(cfg.EpochMaxHours)*time.Hour:
		return "age"
	}
	return ""
}

// epochContext is the context size of t's current epoch. A reseed returns before the
// old session's process is gone (it stops once its turn ends; the thread store resets
// the row's context size then), so while the reseed waits (ReseedPending) or the fresh
// session has not started (FreshStart) the row still holds the old session's size: the
// new epoch has none yet.
func epochContext(t thread.Thread) int64 {
	if t.ReseedPending || t.FreshStart {
		return 0
	}
	return t.ContextTokens
}

// residentOf is Ember's resident thread in snap.
func residentOf(snap *thread.Snapshot) (thread.Thread, bool) {
	if snap == nil {
		return thread.Thread{}, false
	}
	i := slices.IndexFunc(snap.Threads, func(t thread.Thread) bool { return t.Kind == thread.KindResident && t.ResidentName == Name })
	if i < 0 {
		return thread.Thread{}, false
	}
	return snap.Threads[i], true
}

// publish rebuilds the snapshot from the current threads.
func (s *Store) publish() {
	snap := s.opts.Threads.Snapshot()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.publishLocked(snap)
}

// publishLocked builds the snapshot (tasks with their workers' progress, the status)
// and publishes it when it differs from the last one.
func (s *Store) publishLocked(threads *thread.Snapshot) {
	out := &Snapshot{Tasks: make([]Task, len(s.tasks))}
	var teams *teamIndex
	for i, t := range s.tasks {
		if t.ThreadID != "" {
			t.Thread = taskThread(threads, t.ThreadID)
			if staleReport(t) {
				t.Thread.Report = thread.Report{}
			}
			if t.State.Open() && !t.Thread.Removed {
				if teams == nil {
					teams = newTeamIndex(threads)
				}
				t.Thread.Team = teams.team(t.ThreadID)
			}
		}
		out.Tasks[i] = t
		switch t.State {
		case StateTodo:
			out.Status.Counts.Todo++
		case StateDoing:
			out.Status.Counts.Doing++
		case StateBlocked:
			out.Status.Counts.Blocked++
		case StateDone:
			out.Status.Counts.Done++
		case StateCancelled:
			out.Status.Counts.Cancelled++
		}
	}
	st := &out.Status
	st.Enabled, st.Consolidating = s.enabled, s.consolidating
	st.EpochContextTokens = int64(s.cfg.EpochContextTokens)
	st.LastConsolidatedAt, st.LastConsolidationError = s.st.LastConsolidatedAt, s.st.LastConsolidationError
	if u := s.st.LastConsolidationUsage; u != nil {
		st.LastConsolidationUsage = *u
	}
	st.ConsolidationUsageTotal = s.st.ConsolidationUsageTotal
	if t, ok := residentOf(threads); ok {
		st.ThreadID, st.Epoch, st.ContextTokens = t.ID, t.Epoch, epochContext(t)
		st.EpochStartedAt = s.st.EpochStartedAt
	}
	if prev := s.snap.Load(); prev != nil && reflect.DeepEqual(prev, out) {
		return
	}
	s.snap.Store(out)
	bus.Publish(s.opts.Bus, Changed{Snapshot: out})
}

// staleReport reports whether t's worker report describes an earlier run: t is doing
// and its worker's final report (done, failed or blocked) was filed before t last
// changed, as when Ember reopens a done task and sends its worker more work. The same
// rule keeps a failed report from blocking a task Ember set back to doing
// (blockFailedLocked). A progress report always shows.
func staleReport(t Task) bool {
	if t.State != StateDoing || t.Thread == nil {
		return false
	}
	switch t.Thread.Report.Status {
	case thread.ReportDone, thread.ReportFailed, thread.ReportBlocked:
		return t.Thread.Report.At.Before(t.UpdatedAt)
	}
	return false
}

// taskThread is the worker id's progress from threads.
func taskThread(threads *thread.Snapshot, id string) *TaskThread {
	t, ok := threads.Thread(id)
	if !ok {
		return &TaskThread{ID: id, Removed: true}
	}
	return &TaskThread{
		ID: id, Name: t.Name, State: t.State, Status: t.Status, StatusReason: t.StatusReason, Report: t.Report,
		CreatedAt: t.CreatedAt, LastActivityAt: t.LastActivityAt, Archived: !t.ArchivedAt.IsZero(),
	}
}

// workerDefaults is the thread store's create defaults (thread.CreateDefaultsFunc): a
// thread the resident, or a thread below it, creates without a model runs on the next
// of ember.worker_models (round robin, the counter persisted), at ember.worker_effort.
func (s *Store) workerDefaults(_ context.Context, createdBy string, needModel, needEffort bool) (model, effort string) {
	snap := s.opts.Threads.Snapshot()
	res, ok := residentOf(snap)
	if !ok || !descends(snap, createdBy, res.ID) {
		return "", ""
	}
	cfg := s.opts.Config()
	if models := cfg.WorkerModels; needModel && len(models) > 0 {
		s.mu.Lock()
		model = models[s.st.WorkerNext%len(models)]
		s.st.WorkerNext++
		s.saveStateLocked()
		s.mu.Unlock()
	}
	if needEffort {
		effort = cfg.WorkerEffort
	}
	return model, effort
}

// descends reports whether thread id is root or was created, through any number of
// creators, by root.
func descends(snap *thread.Snapshot, id, root string) bool {
	for range 64 {
		if id == root {
			return true
		}
		t, ok := snap.Thread(id)
		if !ok || t.CreatedBy == "" {
			return false
		}
		id = t.CreatedBy
	}
	return false
}

// writeAtomic writes data to path through a temporary file and a rename.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("ember: write %s: %w", path, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("ember: write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("ember: write %s: %w", path, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("ember: write %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("ember: write %s: %w", path, err)
	}
	return nil
}

// readFile is path's content, "" when it is missing (other errors logged).
func (s *Store) readFile(name string) string {
	b, err := os.ReadFile(filepath.Join(s.opts.Dir, name))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.log.Warn("ember: read", "file", name, "err", err)
	}
	return strings.TrimSpace(string(b))
}
