package thread

import (
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
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// ProjectSource is the part of the project store threads need: resolving worktrees and
// creating one for a new thread. *project.Git implements it.
type ProjectSource interface {
	Snapshot() *project.Snapshot
	CreateWorktree(ctx context.Context, opts project.CreateWorktreeOptions) (project.Worktree, error)
}

// Options configures a Manager. DB and Terminals are required.
type Options struct {
	DB *sql.DB
	// Terminals holds the shells terminal.new started for threads; Remove kills a
	// thread's (shells.go). Claude itself never runs in a terminal.
	Terminals terminal.Store
	// Projects resolves project ids and worktree paths. Nil accepts any existing directory
	// as a worktree (tests); the daemon always sets it.
	Projects ProjectSource
	// Workspaces lists workspaces (a workspace thread's members at every spawn) and
	// makes one for a new workspace thread. Nil refuses workspace threads; the daemon
	// always sets it.
	Workspaces WorkspaceSource
	Bus        *bus.Bus     // default: a private bus
	Log        *slog.Logger // default: slog.Default()
	// Claude is the claude executable (resolved against PATH). Default "claude".
	Claude string
	// Paths locates Claude's config dir and global config. Default
	// DefaultClaudePaths().
	Paths ClaudePaths
	// Namer names threads from their first user message. Default ClaudeNamer in
	// /tmp, which names with model.NamingDefault unless the ctx carries
	// WithNamingModel (the daemon's settingsNamer sets it per call).
	Namer Namer
	// AttachmentsDir is where StageAttachment writes images and PDFs. Empty disables
	// attachments. New creates it and removes files older than
	// AttachmentMaxAge, then again every AttachmentReapInterval until Shutdown;
	// every claude gets --add-dir for it so Read of an attachment does not ask.
	AttachmentsDir string
	// SkillsDir is the directory with the skills the daemon ships to threads in its
	// .claude/skills (internal/skills writes it): every claude gets it as its first
	// --add-dir, which loads them. Empty: none. New creates it, so claude never refuses
	// a missing --add-dir.
	SkillsDir string
	// AttachmentMaxAge is how long a staged attachment is kept. Default
	// AttachmentMaxAge (the package constant).
	AttachmentMaxAge time.Duration
	// AttachmentReapInterval is how often staged attachments are reaped while the
	// Manager runs. Default AttachmentReapInterval (the package constant).
	AttachmentReapInterval time.Duration
	// RefExists reports whether ref exists in the repository at dir; Create uses it
	// to keep new worktree branches unique. Default: git rev-parse --verify.
	RefExists func(ctx context.Context, dir, ref string) bool
	// FetchBranch fetches origin's branch in the repository at dir and reports whether
	// origin has it; a thread whose cleaned-up worktree is recreated looks there before
	// making the branch again from its base (recreate.go). Default: git fetch.
	FetchBranch func(ctx context.Context, dir, branch string) bool
	// WorktreeRoot is the directory the app makes worktrees in (paths.Worktrees, the
	// project store's Options.WorktreeRoot). Only a missing cwd under it is recreated
	// when its thread starts (recreate.go); empty recreates none.
	WorktreeRoot string
	// Env entries ("KEY=VALUE") are added to every claude process's environment
	// (Create, Reconnect, Fork). The daemon passes its loopback endpoint and token so
	// the CLI inside a thread reaches it without the Unix socket. Every process also
	// gets its own thread's id as paths.EnvThread (CODE_FOUNDRY_THREAD), which the CLI
	// sends as its default --context-thread.
	Env []string
	// WorktreeCreated, when set, is called after Create made a new worktree for a thread
	// (CreateOptions.NewWorktree) and the thread has started. It must not block: the
	// daemon runs the project's on-worktree-create actions from it in the background.
	WorktreeCreated func(threadID, projectID, worktree string)
	// Home is the cwd of a thread without a project (CreateOptions.NoProject). Default:
	// os.UserHomeDir().
	Home string
	// ActionRun looks up an action run (with its output) for wake subscriptions to runs
	// (subscriptions.go); nil refuses them. The daemon reads the action store; it also
	// calls Manager.ActionRunFinished for every run that ends.
	ActionRun func(ctx context.Context, id string) (ActionRun, bool)
	// WakeLimit is how many wakes a subscriber gets per rolling WakeWindow at most
	// (subscriptions_fire.go). Default WakeLimit (the package constant).
	WakeLimit int
	// DisablePreTrust skips writing folder trust into Claude's config before spawning
	// and before a RunIn move (set_cwd refuses an untrusted folder). For tests.
	DisablePreTrust bool

	NamingTimeout time.Duration // default 20s
	StartTimeout  time.Duration // bound on the initialize handshake (STARTING -> CONNECTED); default 15s
	CloseTimeout  time.Duration // graceful close (stdin closed) before SIGTERM; default 10s
	Tick          time.Duration // transcript poll and housekeeping; default 1s
	// WakeTimeout is how long a background end at the prompt holds the thread for the turn
	// Claude starts by itself (wake.go); default 10s.
	WakeTimeout    time.Duration
	StatusDebounce time.Duration // default 100ms
	// SlugTimeout bounds how long Create waits for the namer before naming a new
	// worktree's branch after the thread id. Default 6s.
	SlugTimeout time.Duration
	// NamingRetryDelay is the pause before the one retry of a rate-limited naming
	// call. Default 2s.
	NamingRetryDelay time.Duration
	// ActivityPublish is the minimum interval between updates published only because
	// last_activity_at moved. Default 15s: an idle Claude still redraws every few
	// seconds, so this is mostly noise. It is persisted at most every 30s.
	ActivityPublish time.Duration
	// AgentIdleClose is the safety net for subagent runs: a run whose transcript has not
	// grown for this long while its thread sits at the prompt stops being followed
	// (six times longer for a background run). Default 10m.
	AgentIdleClose time.Duration
	// CacheTTL is the prompt cache lifetime a thread's CacheExpiresAt counts
	// from its last result (the threads.cache_ttl_seconds setting; SetCacheTTL changes
	// it live). Default DefaultCacheTTL.
	CacheTTL time.Duration
	// SnoozeCheckInterval is how often snoozed threads are checked against the wall
	// clock (wakeSnoozed). Default SnoozeCheckInterval (the package constant).
	SnoozeCheckInterval time.Duration
	// IdleCheckInterval is how often connected threads are checked for an idle stop at
	// their prompt cache expiry (stopIdle). Default IdleCheckInterval (the package
	// constant).
	IdleCheckInterval time.Duration
	// IdleGrace is how long a process stays up at least before an idle stop. Default
	// IdleGrace (the package constant).
	IdleGrace time.Duration
	// Now is the wall clock: timestamps, snooze validation and wake-ups, idle stops.
	// Default time.Now.
	Now func() time.Time
}

func (o Options) withDefaults() (Options, error) {
	if o.DB == nil || o.Terminals == nil {
		return o, errors.New("thread: Options.DB and Options.Terminals are required")
	}
	if o.Bus == nil {
		o.Bus = bus.New()
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Claude == "" {
		o.Claude = "claude"
	}
	if o.Paths.Dir == "" {
		p, err := DefaultClaudePaths()
		if err != nil {
			return o, err
		}
		o.Paths = p
	}
	if o.Namer == nil {
		o.Namer = ClaudeNamer(o.Claude, "/tmp", o.Log)
	}
	if o.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return o, fmt.Errorf("thread: home directory: %w", err)
		}
		o.Home = home
	}
	if o.RefExists == nil {
		o.RefExists = gitRefExists
	}
	if o.FetchBranch == nil {
		o.FetchBranch = gitFetchBranch
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&o.NamingTimeout, 20*time.Second)
	def(&o.SlugTimeout, 6*time.Second)
	def(&o.NamingRetryDelay, 2*time.Second)
	def(&o.StartTimeout, 15*time.Second)
	def(&o.CloseTimeout, 10*time.Second)
	def(&o.Tick, time.Second)
	def(&o.WakeTimeout, 10*time.Second)
	def(&o.StatusDebounce, 100*time.Millisecond)
	def(&o.ActivityPublish, 15*time.Second)
	def(&o.AgentIdleClose, defaultAgentIdleClose)
	def(&o.AttachmentMaxAge, AttachmentMaxAge)
	def(&o.AttachmentReapInterval, AttachmentReapInterval)
	def(&o.CacheTTL, DefaultCacheTTL)
	def(&o.SnoozeCheckInterval, SnoozeCheckInterval)
	def(&o.IdleCheckInterval, IdleCheckInterval)
	def(&o.IdleGrace, IdleGrace)
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.WakeLimit <= 0 {
		o.WakeLimit = WakeLimit
	}
	return o, nil
}

// Manager is the Store backed by SQLite.
type Manager struct {
	opts   Options
	log    *slog.Logger
	ctx    context.Context // cancelled by Shutdown; parent of naming calls
	cancel context.CancelFunc
	wg     sync.WaitGroup // runners and naming calls

	mu     sync.Mutex
	recs   map[string]*record
	closed bool
	// viewers counts each thread's item watchers (WatchItems).
	viewers map[string]int
	snap    atomic.Pointer[Snapshot]
	// retired is the retired usage ledger (Snapshot.RetiredUsage). Copy on write.
	retired []UsageBucket
	// cacheTTL is the prompt cache lifetime (SetCacheTTL); guarded by mu.
	cacheTTL time.Duration

	// threads are the threads' item logs loaded so far (items.go).
	tmu     sync.Mutex
	threads map[string]*threadLog

	// subs are the wake subscriptions (subscriptions.go).
	subs *subscriptions
	// reqs are the request ids being created now (requests.go).
	reqs requests
}

type record struct {
	s           Thread
	run         *runner // non-nil while a claude process belongs to the thread
	namingTried bool    // one naming call per thread (per daemon run)
	// first is the thread's first prompt, handed to its runner by spawn.
	first *outgoing
	// reserved is set while a stopped thread starts and has no runner yet (reserve in
	// lifecycle.go); it is closed when the start resolves.
	reserved chan struct{}
}

var _ Store = (*Manager)(nil)

// New loads persisted threads and returns the Manager. Threads that were live when
// the daemon last stopped without a clean shutdown are marked DISCONNECTED, keeping
// their last published status by the same rule as any disconnect
// (disconnectedStatus: busy becomes interrupted).
func New(ctx context.Context, opts Options) (*Manager, error) {
	opts, err := opts.withDefaults()
	if err != nil {
		return nil, err
	}
	// Nothing runs yet: a run saved as running lost its process (agents_db.go).
	orphaned, err := failOrphanedRuns(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	if orphaned > 0 {
		opts.Log.Info("subagent runs failed: the daemon restarted while they ran", "runs", orphaned)
	}
	rows, err := loadThreads(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	retired, err := loadRetiredUsage(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, recs: map[string]*record{}, retired: retired,
		viewers: map[string]int{}, threads: map[string]*threadLog{}, cacheTTL: opts.CacheTTL}
	m.ctx, m.cancel = context.WithCancel(context.WithoutCancel(ctx))
	var lost []string
	for _, s := range rows {
		if s.State != StateDisconnected {
			lost = append(lost, s.ID)
			s.State, s.DisconnectReason = StateDisconnected, ReasonDaemonRestarts
			st, reason := disconnectedStatus(s.Status, s.StatusReason)
			s.setStatus(st, reason, opts.Now())
			if err := saveThread(ctx, opts.DB, s); err != nil {
				return nil, err
			}
		}
		s.CacheExpiresAt = cacheExpiry(s.LastResultAt, opts.CacheTTL)
		m.recs[s.ID] = &record{s: s, namingTried: s.namedForGood()}
	}
	// Wake subscriptions, armed with the threads as loaded (subscriptions.go).
	if m.subs, err = loadSubscriptionState(ctx, opts.DB, opts.Log, m.recs); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.rebuildLocked()
	m.mu.Unlock()
	// The runs the daemon lost: loading a stopped thread's log closes what its run left
	// open, the turn included (closeLostRun); done now, not when someone first reads the
	// items, so the timeline is whole at once.
	for _, id := range lost {
		if _, err := m.thread(ctx, id); err != nil {
			m.log.Warn("close the open turn of a thread the daemon lost", "thread", id, "err", err)
		}
	}
	// Rows from before threads.branch get theirs from the project store (recreate.go).
	m.startBackfill()
	// Snoozes that ended while the daemon was stopped wake now, then the clock is
	// checked on every tick (snooze.go).
	m.wakeSnoozed()
	snoozeTicker := time.NewTicker(opts.SnoozeCheckInterval)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer snoozeTicker.Stop()
		m.wakeSnoozedLoop(snoozeTicker.C)
	}()
	// Idle threads stop at their cache expiry (lifecycle.go). Nothing runs at startup.
	idleTicker := time.NewTicker(opts.IdleCheckInterval)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer idleTicker.Stop()
		m.stopIdleLoop(idleTicker.C)
	}()
	if opts.SkillsDir != "" {
		// Exists for claude --add-dir (claudeCommand) even if the daemon cannot write
		// the skills.
		if err := os.MkdirAll(opts.SkillsDir, 0o700); err != nil {
			m.log.Warn("create skills dir", "dir", opts.SkillsDir, "err", err)
		}
	}
	if opts.AttachmentsDir != "" {
		// Exists for claude --add-dir (see spawn) before anything is staged.
		if err := os.MkdirAll(opts.AttachmentsDir, 0o700); err != nil {
			m.log.Warn("create attachments dir", "dir", opts.AttachmentsDir, "err", err)
		}
		m.reapAttachmentsNow()
		ticker := time.NewTicker(opts.AttachmentReapInterval)
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			defer ticker.Stop()
			m.reapAttachmentsLoop(ticker.C)
		}()
	}
	return m, nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot returns the current snapshot.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

// Get returns one thread.
func (m *Manager) Get(_ context.Context, id string) (Thread, error) {
	if s, ok := m.Snapshot().Thread(id); ok {
		return s, nil
	}
	return Thread{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}

// rebuildLocked publishes a new snapshot. Callers hold m.mu.
func (m *Manager) rebuildLocked() {
	out := make([]Thread, 0, len(m.recs))
	for _, r := range m.recs {
		out = append(out, r.s)
	}
	slices.SortFunc(out, func(a, b Thread) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	m.snap.Store(&Snapshot{Threads: out, RetiredUsage: m.retired})
}

// update applies fn to a record, optionally persists, rebuilds the snapshot, and
// publishes Updated. Everything happens under m.mu so the snapshot, the database, and
// the event order agree (bus.Publish never blocks).
func (m *Manager) update(id string, persist bool, fn func(*record)) (Thread, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return Thread{}, false
	}
	fn(rec)
	m.commitLocked(rec, persist)
	return rec.s, true
}

// commitLocked persists (when asked) before it swaps in the snapshot: Snapshot is read
// without m.mu, so saving second would let a reader see a change the database does not
// have yet, and a crash in that window would lose a status the GUI already showed.
func (m *Manager) commitLocked(rec *record, persist bool) {
	if persist {
		if err := saveThread(context.Background(), m.opts.DB, rec.s); err != nil {
			m.log.Error("persist thread", "thread", rec.s.ID, "err", err)
		}
	}
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Updated{Thread: rec.s})
	m.observeLocked(rec.s) // wake subscriptions (subscriptions.go)
}

func (m *Manager) record(id string) (*record, error) {
	rec, ok := m.recs[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	return rec, nil
}

// Create spawns claude in a worktree. The thread is returned STARTING. With
// NewWorktree it first creates the worktree (synchronously: on failure nothing is
// persisted); see newWorktree. With NoProject it runs in Options.Home and has no
// owner.
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Thread, error) {
	if err := validateModelEffort(o.Model, o.Effort); err != nil {
		return Thread{}, err
	}
	if !o.PermissionMode.valid() {
		return Thread{}, fmt.Errorf("%w: permission mode %d", ErrInvalidArgument, o.PermissionMode)
	}
	name, err := cleanName(o.Name, true)
	if err != nil {
		return Thread{}, err
	}
	attachments, err := messageAttachments(ctx, m.opts.AttachmentsDir, o.Attachments)
	if err != nil {
		return Thread{}, err
	}
	prompt := buildPrompt(o.InitialPrompt, attachments)
	if strings.ContainsRune(prompt, 0) {
		return Thread{}, fmt.Errorf("%w: prompt contains a NUL byte", ErrInvalidArgument)
	}
	brief, err := CleanBrief(o.Brief)
	if err != nil {
		return Thread{}, err
	}
	labels, err := CleanLabels(o.Labels)
	if err != nil {
		return Thread{}, err
	}
	if err := CheckBudget(o.BudgetUSD); err != nil {
		return Thread{}, err
	}
	// The creator's name now: the note and created_by_name keep it (metadata.go).
	creatorID, creatorName, err := m.creator(o.CreatedBy)
	if err != nil {
		return Thread{}, err
	}
	if err := m.checkNotify(o.Notify, creatorID); err != nil {
		return Thread{}, err
	}
	id, err := newThreadID()
	if err != nil {
		return Thread{}, err
	}
	cid, err := newUUID()
	if err != nil {
		return Thread{}, err
	}
	s := Thread{
		ID: id, Name: name, Model: o.Model, Effort: o.Effort, PermissionMode: o.PermissionMode, State: StateStarting,
		CreatedBy: creatorID, CreatedByName: creatorName, Brief: brief, Labels: labels, BudgetUSD: o.BudgetUSD,
	}
	namingTried := name != ""
	var late <-chan namingResult
	var members []workspace.Member // a workspace thread's, for file references
	if (o.NewWorkspace != nil && (o.NewWorktree != nil || o.WorkspaceID != "")) || (o.NewWorktree != nil && o.WorkspaceID != "") {
		return Thread{}, fmt.Errorf("%w: new workspace, new worktree and workspace are exclusive", ErrInvalidArgument)
	}
	if o.NoProject && (o.ProjectID != "" || o.WorktreePath != "" || o.NewWorktree != nil || o.WorkspaceID != "" || o.NewWorkspace != nil) {
		return Thread{}, fmt.Errorf("%w: no_project excludes a project, worktree, new worktree, workspace and new workspace", ErrInvalidArgument)
	}
	switch {
	case o.NoProject:
		// No owner: ProjectID and WorkspaceID stay empty and claude starts in the home
		// directory, trusted like any cwd (spawn).
		s.WorktreePath = m.opts.Home
	case o.NewWorkspace != nil:
		cw, err := m.newWorkspace(ctx, id, name, o)
		if err != nil {
			return Thread{}, err
		}
		s.WorkspaceID, s.ProjectID, s.WorktreePath, s.BaseRef, s.CreatedWorktree = cw.workspaceID, cw.projectID, cw.path, cw.baseRef, true
		s.Branch = cw.branch
		members = cw.members
		if cw.name != "" {
			s.Name, s.AutoNamed = cw.name, true
		}
		namingTried = namingTried || cw.namerCalled
		late = cw.late
	case o.WorkspaceID != "":
		w, mem, err := m.workspaceMember(o.WorkspaceID, o.ProjectID, o.WorktreePath)
		if err != nil {
			return Thread{}, err
		}
		s.WorkspaceID, s.ProjectID, s.WorktreePath = w.ID, mem.ProjectID, mem.WorktreePath
		members = w.Members
	case o.NewWorktree != nil:
		nw, err := m.newWorktree(ctx, id, name, o)
		if err != nil {
			return Thread{}, err
		}
		s.ProjectID, s.WorktreePath, s.BaseRef, s.CreatedWorktree = nw.projectID, nw.path, nw.baseRef, true
		s.Branch = nw.branch
		if nw.name != "" {
			s.Name, s.AutoNamed = nw.name, true
		}
		namingTried = namingTried || nw.namerCalled
		late = nw.late
	default:
		if s.ProjectID, s.WorktreePath, err = m.resolveWorktree(o.ProjectID, o.WorktreePath); err != nil {
			return Thread{}, err
		}
	}
	if s.Name == "" {
		// Until the namer answers (provisional.go); namingTried stays false so it runs.
		s.nameProvisionally(o.ComposerPrompt, o.InitialPrompt)
	}
	// The worktrees exist now: point file references at them (see filerefs.go).
	prompt, dropped := rewriteFileRefs(prompt, func(projectID string) (string, bool) {
		if i := slices.IndexFunc(members, func(mem workspace.Member) bool { return mem.ProjectID == projectID }); i >= 0 {
			return members[i].WorktreePath, true
		}
		return s.WorktreePath, s.ProjectID != "" && projectID == s.ProjectID
	})
	if len(dropped) > 0 {
		m.log.Warn("file references outside the thread's projects; passing their relative paths",
			"thread", id, "project", s.ProjectID, "workspace", s.WorkspaceID, "refs", dropped)
	}
	now := m.opts.Now()
	s.CreatedAt, s.LastActivityAt = now, now
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Thread{}, ErrClosed
	}
	rec := &record{s: s, namingTried: namingTried}
	if prompt != "" {
		// The prompt goes in as the first user message; the item keeps it as typed.
		rec.first = &outgoing{text: strings.TrimSpace(o.InitialPrompt), composer: strings.TrimSpace(o.ComposerPrompt), attachments: attachments, prompt: prompt}
	}
	m.recs[id] = rec
	m.mu.Unlock()
	drop := func() {
		m.mu.Lock()
		delete(m.recs, id)
		m.tmu.Lock()
		delete(m.threads, id) // the thread's log, loaded by spawnStream
		m.tmu.Unlock()
		m.mu.Unlock()
	}
	var note *Item
	if creatorID != "" {
		// Before spawn, so the note precedes the first message (written once Claude
		// answers its handshake); its row once spawn wrote the thread's, like a fork's
		// copy (fork.go).
		// The text keeps the name at creation (the CLI's and a removed creator's
		// fallback); NoteCreatedBy lets the GUI show the creator's current name.
		it, err := m.startNote(ctx, id, Item{ID: createdByNoteID, Text: createdByNoteText(creatorName, brief), NoteCreatedBy: creatorID})
		if err != nil {
			drop()
			return Thread{}, err
		}
		note = &it
	}
	if err := m.spawn(ctx, id, launch{newID: cid}); err != nil {
		drop()
		return Thread{}, err
	}
	if note != nil {
		m.saveItem(id, *note)
		m.log.Info("thread created by another thread", "thread", id, "created_by", creatorID)
	}
	if late != nil {
		m.applyLateName(id, late)
	}
	if o.NewWorktree != nil && m.opts.WorktreeCreated != nil {
		m.opts.WorktreeCreated(id, s.ProjectID, s.WorktreePath)
	}
	if o.Notify {
		m.notifyCreator(ctx, creatorID, id)
	}
	return m.Get(ctx, id)
}

// Fork starts a new thread that continues id's conversation under a new Claude
// session id (claude --resume <id> --fork-session --session-id <new>). Its items start
// as a copy of id's, ended by a "Forked from <name>" note (fork.go).
func (m *Manager) Fork(ctx context.Context, id, name string) (Thread, error) {
	name, err := cleanName(name, true)
	if err != nil {
		return Thread{}, err
	}
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return Thread{}, err
	}
	parent := rec.s
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return Thread{}, ErrClosed
	}
	if parent.ClaudeSessionID == "" {
		return Thread{}, fmt.Errorf("%w: thread %s has no saved conversation to fork yet", ErrFailedPrecondition, id)
	}
	if _, ok := m.opts.Paths.transcriptPath(parent.WorktreePath, parent.ClaudeSessionID); !ok {
		return Thread{}, fmt.Errorf("%w: transcript of %s not found", ErrFailedPrecondition, parent.ClaudeSessionID)
	}
	if _, err := os.Stat(parent.WorktreePath); err != nil {
		return Thread{}, fmt.Errorf("%w: worktree %s: %v", ErrFailedPrecondition, parent.WorktreePath, err)
	}
	newID, err := newThreadID()
	if err != nil {
		return Thread{}, err
	}
	cid, err := newUUID()
	if err != nil {
		return Thread{}, err
	}
	autoNamed := false
	if name == "" && parent.Name != "" {
		// A parent's provisional name is the fork's for good: no namer runs for a fork.
		name, autoNamed = forkName(parent.Name), parent.AutoNamed
	}
	now := m.opts.Now()
	s := Thread{
		ID: newID, ProjectID: parent.ProjectID, WorktreePath: parent.WorktreePath, WorkspaceID: parent.WorkspaceID,
		// The fork runs in the parent's worktree, so it inherits what the worktree was made
		// for: a cleanup that removes it is undone when either resumes (recreate.go).
		BaseRef: parent.BaseRef, CreatedWorktree: parent.CreatedWorktree, Branch: parent.Branch,
		Name: name, AutoNamed: autoNamed,
		Model: parent.Model, Effort: parent.Effort, PermissionMode: parent.PermissionMode,
		State: StateStarting, CreatedAt: now, LastActivityAt: now, ParentID: parent.ID,
	}
	m.mu.Lock()
	// The fork's transcript starts with the copied history, so its first user
	// message is the parent's: never auto-name a fork from it.
	m.recs[newID] = &record{s: s, namingTried: true}
	m.mu.Unlock()
	drop := func() {
		m.mu.Lock()
		delete(m.recs, newID)
		m.tmu.Lock()
		delete(m.threads, newID)
		m.tmu.Unlock()
		m.mu.Unlock()
	}
	items, err := m.forkLog(ctx, parent, newID)
	if err != nil {
		drop()
		return Thread{}, err
	}
	if err := m.spawn(ctx, newID, launch{resume: parent.ClaudeSessionID, fork: true, newID: cid}); err != nil {
		drop()
		return Thread{}, err
	}
	m.persistForkLog(ctx, newID, items)
	return m.Get(ctx, newID)
}

// Reconnect resumes a DISCONNECTED thread without a prompt. Without a resumable
// conversation (no Claude session id yet, or its transcript is gone) it starts a new
// conversation in the same worktree and says so in LastError. It unarchives and
// unsnoozes the thread. No command calls it any more (a message starts a stopped
// thread: Send); it stays for ThreadService.Reconnect and tests.
func (m *Manager) Reconnect(ctx context.Context, id string) (Thread, error) {
	if _, err := m.startStopped(ctx, id, startOpts{backToList: true}); err != nil {
		if errors.Is(err, errNotStopped) {
			return Thread{}, fmt.Errorf("%w: thread %s is not stopped; only a stopped thread can be started this way", ErrFailedPrecondition, id)
		}
		return Thread{}, err
	}
	return m.Get(ctx, id)
}

// spawn starts claude for record id (claude -p over stream-json, stream.go) and its
// runner. The record's first prompt, if any, is sent once the handshake succeeds.
func (m *Manager) spawn(ctx context.Context, id string, l launch) error {
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	s := rec.s
	first := rec.first
	rec.first = nil
	m.mu.Unlock()

	if !m.opts.DisablePreTrust {
		if changed, err := trustWorktree(m.opts.Paths.Config, s.WorktreePath); err != nil {
			m.log.Warn("pre-trust worktree failed", "thread", id, "path", s.WorktreePath, "err", err)
		} else if changed {
			m.log.Info("pre-trusted worktree in claude config", "thread", id, "path", realPath(s.WorktreePath))
		}
	}

	r := newRunner(m, id, s.WorktreePath, l)
	if s.ParentID != "" {
		// A fork's transcript starts with a copy of its parent's records, billed to
		// the parent; they keep their original times (usage.go).
		r.usage.notBefore = s.CreatedAt
	}
	argv, env := m.claudeCommand(s, l, grants{})
	if err := m.spawnStream(ctx, rec, r, argv, env, first); err != nil {
		return err
	}
	now := m.opts.Now()
	m.mu.Lock()
	if m.closed {
		// Shutdown began while claude started: it would never stop this runner, and
		// m.wg.Add must not race its m.wg.Wait. The process goes; the start fails.
		m.mu.Unlock()
		r.abandon()
		return ErrClosed
	}
	rec.run = r
	rec.release()
	rec.s.State = StateStarting
	// The fresh process owns status from here: the persisted one is cleared, or, with a
	// message waiting for the handshake, the thread is on that turn already.
	if first != nil {
		rec.s.setStatus(StatusBusy, "working", now)
	} else {
		rec.s.setStatus(StatusUnknown, "", now)
	}
	rec.s.DisconnectReason, rec.s.ExitCode = "", 0
	rec.s.LastActivityAt = now
	m.commitLocked(rec, true)
	m.wg.Add(1)
	m.mu.Unlock()
	m.log.Info("thread spawned", "thread", id, "pid", r.st.proc.Pid(), "argv", argv, "cwd", s.WorktreePath)
	go func() {
		defer m.wg.Done()
		r.run()
	}()
	return nil
}

// claudeCommand is the argv and environment of a claude spawn for s: its model,
// effort and permission mode, --add-dir for the skills dir, the attachments dir, the
// workspace members and the granted dirs (in that order, every spawn), the system
// prompt line (ThreadPrompt, and the workspace's) and the workspace env. The prompt is
// never in argv (it is the first user message). g is what the conversation's
// allow-for-thread answers granted (an effort restart's; a fresh spawn starts without).
func (m *Manager) claudeCommand(s Thread, l launch, g grants) (argv, env []string) {
	sa := spawnArgs{model: s.Model, effort: s.Effort, perm: s.PermissionMode,
		allowedTools: g.allow, disallowedTools: g.deny, appendSystemPrompt: systemPrompt("")}
	if m.opts.SkillsDir != "" {
		// First, so the skills load whatever else is added (docs/notes/agent-skills.md).
		sa.addDirs = append(sa.addDirs, m.opts.SkillsDir)
	}
	if m.opts.AttachmentsDir != "" {
		// Every spawn (not only the first prompt's): a resumed or forked conversation
		// may read its images again.
		sa.addDirs = append(sa.addDirs, m.opts.AttachmentsDir)
	}
	env = append(slices.Clip(m.opts.Env), paths.EnvThread+"="+s.ID)
	if s.WorkspaceID != "" {
		// The current members, every spawn (create, reconnect, fork): a project added to
		// the workspace since the row was written is included.
		var ws *workspace.Snapshot
		if m.opts.Workspaces != nil {
			ws = m.opts.Workspaces.Snapshot()
		}
		if wl, ok := workspaceLaunch(ws, s.WorkspaceID, s.WorktreePath, isDir); ok {
			sa.addDirs = append(sa.addDirs, wl.addDirs...)
			sa.appendSystemPrompt = systemPrompt(wl.prompt)
			env = append(slices.Clip(env), wl.env...)
			if len(wl.missing) > 0 {
				m.log.Warn("workspace member worktrees missing; not passed to claude", "thread", s.ID,
					"workspace", s.WorkspaceID, "paths", wl.missing)
			}
		} else {
			m.log.Warn("workspace of thread not found; starting without its members", "thread", s.ID, "workspace", s.WorkspaceID)
		}
	}
	sa.addDirs = append(sa.addDirs, g.dirs...)
	return l.argv(m.opts.Claude, sa), env
}

// Rename sets a user-chosen name and disables auto-naming.
func (m *Manager) Rename(_ context.Context, id, name string) (Thread, error) {
	name, err := cleanName(name, false)
	if err != nil {
		return Thread{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	rec.s.Name, rec.s.AutoNamed, rec.s.NameProvisional, rec.namingTried = name, false, false, true
	m.commitLocked(rec, true)
	return rec.s, nil
}

// Pin sets or clears the user's pin. It works in any state and is persisted. Pinning an
// archived or snoozed thread unarchives or unsnoozes it.
func (m *Manager) Pin(_ context.Context, id string, pinned bool) (Thread, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	unarchived := pinned && m.unarchiveLocked(rec)
	unsnoozed := pinned && m.unsnoozeLocked(rec)
	if rec.s.Pinned == pinned && !unarchived && !unsnoozed {
		return rec.s, nil
	}
	rec.s.Pinned = pinned
	m.commitLocked(rec, true)
	return rec.s, nil
}

// Close ends the process gracefully and waits until the thread is DISCONNECTED.
// Archive, Snooze and Remove close through it; no command calls it directly any more.
func (m *Manager) Close(ctx context.Context, id string) error {
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	r := rec.run
	m.mu.Unlock()
	if r == nil {
		return nil
	}
	r.requestClose()
	select {
	case <-r.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Remove closes the thread if needed, kills and removes the shells that belong to it
// (terminals labelled termlabel.KindShell with its id), then forgets it.
func (m *Manager) Remove(ctx context.Context, id string) error {
	if err := m.Close(ctx, id); err != nil {
		return err
	}
	if err := m.removeShells(ctx, id); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return err
	}
	if rec.run != nil || rec.reserved != nil {
		return fmt.Errorf("%w: thread %s was started while being removed", ErrFailedPrecondition, id)
	}
	// The thread's usage moves to the retired ledger in the delete's transaction.
	if err := retireThread(ctx, m.opts.DB, id, rec.s.Usage); err != nil {
		return err
	}
	delete(m.recs, id)
	m.tmu.Lock()
	delete(m.threads, id)
	m.tmu.Unlock()
	if len(rec.s.Usage) > 0 {
		m.retired = SumUsage(m.retired, rec.s.Usage)
	}
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Removed{ID: id})
	m.forgetLocked(id, "removed") // wake subscriptions (subscriptions.go)
	if len(rec.s.Usage) > 0 {
		bus.Publish[Event](m.opts.Bus, RetiredUsage{Buckets: m.retired})
	}
	return nil
}

// Shutdown stops every runner, which terminates its claude process (it talks to the
// daemon over pipes and cannot outlive it), and records live threads as DISCONNECTED
// ("daemon stopped"). The Manager is unusable afterwards.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	var runners []*runner
	for _, rec := range m.recs {
		if rec.run != nil {
			runners = append(runners, rec.run)
		}
	}
	m.mu.Unlock()
	for _, r := range runners {
		r.stop()
	}
	m.cancel()
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("thread: shutdown: %w", ctx.Err())
	}
}

// detach clears a finished runner from its record, applying fn to the thread.
func (m *Manager) detach(r *runner, fn func(*Thread)) {
	m.update(r.id, true, func(rec *record) {
		if rec.run == r {
			rec.run = nil
		}
		fn(&rec.s)
	})
}

// startNaming names a thread from its first user message, once.
func (m *Manager) startNaming(id, msg string) {
	m.mu.Lock()
	rec, ok := m.recs[id]
	if !ok || rec.namingTried || rec.s.namedForGood() || m.closed {
		m.mu.Unlock()
		return
	}
	rec.namingTried = true
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		ctx, cancel := context.WithTimeout(withNamingThread(m.ctx, id), m.opts.NamingTimeout)
		defer cancel()
		start := time.Now()
		name, err := m.opts.Namer(ctx, msg)
		if err != nil {
			m.log.Warn("auto-naming failed", "thread", id, "err", err)
			return
		}
		applied := false
		if _, ok := m.update(id, true, func(rec *record) { applied = rec.s.applyNamerTitle(name) }); !ok {
			return // removed meanwhile
		}
		took := time.Since(start).Round(time.Millisecond).String()
		if applied {
			m.log.Info("thread auto-named", "thread", id, "name", name, "took", took)
		} else {
			m.log.Info("naming answer ignored: the thread was named meanwhile", "thread", id, "name", name, "took", took)
		}
	}()
}

// projectByRef finds a registered project by id, by name (when exactly one has it), or
// by an absolute path inside one of its worktrees, as thread.list's filter does
// (workspace.ResolveProject): the CLI guide promises "a project id or name" wherever a
// command takes a project. A ref that names nothing is NotFound.
func (m *Manager) projectByRef(snap *project.Snapshot, ref string) (project.Project, error) {
	r, err := workspace.ResolveProject(snap, ref)
	switch {
	case err == nil:
		return r, nil
	case errors.Is(err, workspace.ErrInvalidArgument):
		return project.Project{}, fmt.Errorf("%w: project %q: %v", ErrInvalidArgument, ref, err)
	default:
		return project.Project{}, fmt.Errorf("%w: project %s", ErrNotFound, ref)
	}
}

// resolveWorktree maps (project id, name or path; worktree path) to a registered
// project's worktree.
func (m *Manager) resolveWorktree(projectID, path string) (string, string, error) {
	if path != "" {
		if !filepath.IsAbs(path) {
			return "", "", fmt.Errorf("%w: worktree path %q must be absolute", ErrInvalidArgument, path)
		}
		path = filepath.Clean(path)
	}
	if projectID == "" && path == "" {
		return "", "", fmt.Errorf("%w: a project, a worktree path, a workspace or no project is required", ErrInvalidArgument)
	}
	if m.opts.Projects == nil {
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			return "", "", fmt.Errorf("%w: worktree %q is not a directory", ErrInvalidArgument, path)
		}
		return projectID, path, nil
	}
	snap := m.opts.Projects.Snapshot()
	var projects []project.Project
	if projectID != "" {
		r, err := m.projectByRef(snap, projectID)
		if err != nil {
			return "", "", err
		}
		if path == "" {
			if len(r.Worktrees) > 0 {
				return r.ID, r.Worktrees[0].Path, nil
			}
			return r.ID, r.Path, nil
		}
		projects = []project.Project{r}
	} else if snap != nil {
		projects = snap.Projects
	}
	real := realPath(path)
	for _, r := range projects {
		for _, w := range r.Worktrees {
			if w.Path == path || realPath(w.Path) == real {
				return r.ID, w.Path, nil
			}
		}
		if len(r.Worktrees) == 0 && (r.Path == path || realPath(r.Path) == real) {
			return r.ID, r.Path, nil
		}
	}
	if projectID != "" {
		return "", "", fmt.Errorf("%w: %s is not a worktree of project %s", ErrFailedPrecondition, path, projectID)
	}
	return "", "", fmt.Errorf("%w: %s is not a worktree of a registered project (register it first)", ErrFailedPrecondition, path)
}

// cleanName trims and validates a display name.
func cleanName(name string, optional bool) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "" && optional:
		return "", nil
	case name == "":
		return "", fmt.Errorf("%w: name is empty", ErrInvalidArgument)
	case len(name) > 200 || strings.ContainsAny(name, "\x00\n\r"):
		return "", fmt.Errorf("%w: name must be one line of at most 200 bytes", ErrInvalidArgument)
	}
	return name, nil
}

// forkName is the default name of a fork of a thread named parent: "<parent> (fork)".
func forkName(parent string) string {
	return parent + " (fork)"
}
