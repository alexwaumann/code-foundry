package session

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
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// RepoSource is the part of the repo store sessions need: resolving worktrees and
// creating one for a new session. *repo.Git implements it.
type RepoSource interface {
	Snapshot() *repo.Snapshot
	CreateWorktree(ctx context.Context, opts repo.CreateWorktreeOptions) (repo.Worktree, error)
}

// Options configures a Manager. DB and Terminals are required.
type Options struct {
	DB *sql.DB
	// Terminals holds the shells terminal.new started for threads; Remove kills a
	// thread's (shells.go). Claude itself never runs in a terminal.
	Terminals terminal.Store
	// Repos resolves repo ids and worktree paths. Nil accepts any existing directory
	// as a worktree (tests); the daemon always sets it.
	Repos RepoSource
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
	// Namer names sessions from their first user message. Default ClaudeNamer in
	// /tmp, which names with model.NamingDefault unless the ctx carries
	// WithNamingModel (the daemon's settingsNamer sets it per call).
	Namer Namer
	// AttachmentsDir is where StageAttachment writes images. Empty disables
	// attachments. New creates it and removes files older than
	// AttachmentMaxAge, then again every AttachmentReapInterval until Shutdown;
	// every claude gets --add-dir for it so Read of an attachment does not ask.
	AttachmentsDir string
	// AttachmentMaxAge is how long a staged attachment is kept. Default
	// AttachmentMaxAge (the package constant).
	AttachmentMaxAge time.Duration
	// AttachmentReapInterval is how often staged attachments are reaped while the
	// Manager runs. Default AttachmentReapInterval (the package constant).
	AttachmentReapInterval time.Duration
	// WorktreePath, when set, picks the path of a worktree Create makes for branch in
	// r; "" leaves it to the repo store's default. The daemon applies the
	// repos.worktree_dir setting with it, as repo.worktree.new does.
	WorktreePath func(r repo.Repo, branch string) string
	// RefExists reports whether ref exists in the repository at dir; Create uses it
	// to keep new worktree branches unique. Default: git rev-parse --verify.
	RefExists func(ctx context.Context, dir, ref string) bool
	// Env entries ("KEY=VALUE") are added to every claude process's environment
	// (Create, Reconnect, Fork). The daemon passes its loopback endpoint and token so
	// the CLI inside a session reaches it without the Unix socket. Every process also
	// gets its own thread's id as paths.EnvSession (CODE_FOUNDRY_SESSION), which the CLI
	// sends as its default --context-session.
	Env []string
	// WorktreeCreated, when set, is called after Create made a new worktree for a thread
	// (CreateOptions.NewWorktree) and the thread has started. It must not block: the
	// daemon runs the project's on-worktree-create actions from it in the background.
	WorktreeCreated func(sessionID, repoID, worktree string)
	// Home is the cwd of a thread without a project (CreateOptions.NoProject). Default:
	// os.UserHomeDir().
	Home string
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
	// worktree's branch after the session id. Default 6s.
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
	// from its last result (the sessions.cache_ttl_seconds setting; SetCacheTTL changes
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
		return o, errors.New("session: Options.DB and Options.Terminals are required")
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
			return o, fmt.Errorf("session: home directory: %w", err)
		}
		o.Home = home
	}
	if o.RefExists == nil {
		o.RefExists = gitRefExists
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
}

type record struct {
	s           Session
	run         *runner // non-nil while a claude process belongs to the session
	namingTried bool    // one naming call per session (per daemon run)
	// first is the thread's first prompt, handed to its runner by spawn.
	first *outgoing
	// reserved is set while a stopped thread starts and has no runner yet (reserve in
	// lifecycle.go); it is closed when the start resolves.
	reserved chan struct{}
}

var _ Store = (*Manager)(nil)

// New loads persisted sessions and returns the Manager. Sessions that were live when
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
	rows, err := loadSessions(ctx, opts.DB)
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
	for _, s := range rows {
		if s.State != StateDisconnected {
			s.State, s.DisconnectReason = StateDisconnected, ReasonDaemonRestarts
			st, reason := disconnectedStatus(s.Status, s.StatusReason)
			s.setStatus(st, reason, opts.Now())
			if err := saveSession(ctx, opts.DB, s); err != nil {
				return nil, err
			}
		}
		s.CacheExpiresAt = cacheExpiry(s.LastResultAt, opts.CacheTTL)
		m.recs[s.ID] = &record{s: s, namingTried: s.Name != ""}
	}
	m.mu.Lock()
	m.rebuildLocked()
	m.mu.Unlock()
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

// Get returns one session.
func (m *Manager) Get(_ context.Context, id string) (Session, error) {
	if s, ok := m.Snapshot().Session(id); ok {
		return s, nil
	}
	return Session{}, fmt.Errorf("%w: %s", ErrNotFound, id)
}

// rebuildLocked publishes a new snapshot. Callers hold m.mu.
func (m *Manager) rebuildLocked() {
	out := make([]Session, 0, len(m.recs))
	for _, r := range m.recs {
		out = append(out, r.s)
	}
	slices.SortFunc(out, func(a, b Session) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	m.snap.Store(&Snapshot{Sessions: out, RetiredUsage: m.retired})
}

// update applies fn to a record, optionally persists, rebuilds the snapshot, and
// publishes Updated. Everything happens under m.mu so the snapshot, the database, and
// the event order agree (bus.Publish never blocks).
func (m *Manager) update(id string, persist bool, fn func(*record)) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return Session{}, false
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
		if err := saveSession(context.Background(), m.opts.DB, rec.s); err != nil {
			m.log.Error("persist session", "session", rec.s.ID, "err", err)
		}
	}
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Updated{Session: rec.s})
}

func (m *Manager) record(id string) (*record, error) {
	rec, ok := m.recs[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	return rec, nil
}

// Create spawns claude in a worktree. The session is returned STARTING. With
// NewWorktree it first creates the worktree (synchronously: on failure nothing is
// persisted); see newWorktree. With NoProject it runs in Options.Home and has no
// owner.
func (m *Manager) Create(ctx context.Context, o CreateOptions) (Session, error) {
	if err := validateModelEffort(o.Model, o.Effort); err != nil {
		return Session{}, err
	}
	if !o.PermissionMode.valid() {
		return Session{}, fmt.Errorf("%w: permission mode %d", ErrInvalidArgument, o.PermissionMode)
	}
	name, err := cleanName(o.Name, true)
	if err != nil {
		return Session{}, err
	}
	attachments, err := checkAttachments(m.opts.AttachmentsDir, o.Attachments)
	if err != nil {
		return Session{}, err
	}
	prompt := buildPrompt(o.InitialPrompt, attachments)
	if strings.ContainsRune(prompt, 0) {
		return Session{}, fmt.Errorf("%w: prompt contains a NUL byte", ErrInvalidArgument)
	}
	id, err := newSessionID()
	if err != nil {
		return Session{}, err
	}
	cid, err := newUUID()
	if err != nil {
		return Session{}, err
	}
	s := Session{
		ID: id, Name: name, Model: o.Model, Effort: o.Effort, PermissionMode: o.PermissionMode, State: StateStarting,
	}
	namingTried := name != ""
	var late <-chan namingResult
	var members []workspace.Member // a workspace thread's, for file references
	if (o.NewWorkspace != nil && (o.NewWorktree != nil || o.WorkspaceID != "")) || (o.NewWorktree != nil && o.WorkspaceID != "") {
		return Session{}, fmt.Errorf("%w: new workspace, new worktree and workspace are exclusive", ErrInvalidArgument)
	}
	if o.NoProject && (o.RepoID != "" || o.WorktreePath != "" || o.NewWorktree != nil || o.WorkspaceID != "" || o.NewWorkspace != nil) {
		return Session{}, fmt.Errorf("%w: no project excludes a repo, worktree, new worktree, workspace and new workspace", ErrInvalidArgument)
	}
	switch {
	case o.NoProject:
		// No owner: RepoID and WorkspaceID stay empty and claude starts in the home
		// directory, trusted like any cwd (spawn).
		s.WorktreePath = m.opts.Home
	case o.NewWorkspace != nil:
		cw, err := m.newWorkspace(ctx, id, name, o)
		if err != nil {
			return Session{}, err
		}
		s.WorkspaceID, s.RepoID, s.WorktreePath, s.BaseRef, s.CreatedWorktree = cw.workspaceID, cw.repoID, cw.path, cw.baseRef, true
		members = cw.members
		if cw.name != "" {
			s.Name, s.AutoNamed = cw.name, true
		}
		namingTried = namingTried || cw.namerCalled
		late = cw.late
	case o.WorkspaceID != "":
		w, mem, err := m.workspaceMember(o.WorkspaceID, o.RepoID, o.WorktreePath)
		if err != nil {
			return Session{}, err
		}
		s.WorkspaceID, s.RepoID, s.WorktreePath = w.ID, mem.RepoID, mem.WorktreePath
		members = w.Members
	case o.NewWorktree != nil:
		nw, err := m.newWorktree(ctx, id, name, o)
		if err != nil {
			return Session{}, err
		}
		s.RepoID, s.WorktreePath, s.BaseRef, s.CreatedWorktree = nw.repoID, nw.path, nw.baseRef, true
		if nw.name != "" {
			s.Name, s.AutoNamed = nw.name, true
		}
		namingTried = namingTried || nw.namerCalled
		late = nw.late
	default:
		if s.RepoID, s.WorktreePath, err = m.resolveWorktree(o.RepoID, o.WorktreePath); err != nil {
			return Session{}, err
		}
	}
	// The worktrees exist now: point file references at them (see filerefs.go).
	prompt, dropped := rewriteFileRefs(prompt, func(repoID string) (string, bool) {
		if i := slices.IndexFunc(members, func(mem workspace.Member) bool { return mem.RepoID == repoID }); i >= 0 {
			return members[i].WorktreePath, true
		}
		return s.WorktreePath, s.RepoID != "" && repoID == s.RepoID
	})
	if len(dropped) > 0 {
		m.log.Warn("file references outside the thread's projects; passing their relative paths",
			"session", id, "repo", s.RepoID, "workspace", s.WorkspaceID, "refs", dropped)
	}
	now := m.opts.Now()
	s.CreatedAt, s.LastActivityAt = now, now
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Session{}, ErrClosed
	}
	rec := &record{s: s, namingTried: namingTried}
	if prompt != "" {
		// The prompt goes in as the first user message; the item keeps it as typed.
		rec.first = &outgoing{text: strings.TrimSpace(o.InitialPrompt), composer: strings.TrimSpace(o.ComposerPrompt), attachments: attachments, prompt: prompt}
	}
	m.recs[id] = rec
	m.mu.Unlock()
	if err := m.spawn(ctx, id, launch{newID: cid}); err != nil {
		m.mu.Lock()
		delete(m.recs, id)
		m.tmu.Lock()
		delete(m.threads, id) // the thread's log, loaded by spawnStream
		m.tmu.Unlock()
		m.mu.Unlock()
		return Session{}, err
	}
	if late != nil {
		m.applyLateName(id, late)
	}
	if o.NewWorktree != nil && m.opts.WorktreeCreated != nil {
		m.opts.WorktreeCreated(id, s.RepoID, s.WorktreePath)
	}
	return m.Get(ctx, id)
}

// Fork starts a new session that continues id's conversation under a new Claude
// session id (claude --resume <id> --fork-session --session-id <new>). Its items start
// as a copy of id's, ended by a "Forked from <name>" note (fork.go).
func (m *Manager) Fork(ctx context.Context, id, name string) (Session, error) {
	name, err := cleanName(name, true)
	if err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return Session{}, err
	}
	parent := rec.s
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return Session{}, ErrClosed
	}
	if parent.ClaudeSessionID == "" {
		return Session{}, fmt.Errorf("%w: session %s has no saved conversation to fork yet", ErrFailedPrecondition, id)
	}
	if _, ok := m.opts.Paths.transcriptPath(parent.WorktreePath, parent.ClaudeSessionID); !ok {
		return Session{}, fmt.Errorf("%w: transcript of %s not found", ErrFailedPrecondition, parent.ClaudeSessionID)
	}
	if _, err := os.Stat(parent.WorktreePath); err != nil {
		return Session{}, fmt.Errorf("%w: worktree %s: %v", ErrFailedPrecondition, parent.WorktreePath, err)
	}
	newID, err := newSessionID()
	if err != nil {
		return Session{}, err
	}
	cid, err := newUUID()
	if err != nil {
		return Session{}, err
	}
	autoNamed := false
	if name == "" && parent.Name != "" {
		name, autoNamed = forkName(parent.Name), parent.AutoNamed
	}
	now := m.opts.Now()
	s := Session{
		ID: newID, RepoID: parent.RepoID, WorktreePath: parent.WorktreePath, WorkspaceID: parent.WorkspaceID,
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
		return Session{}, err
	}
	if err := m.spawn(ctx, newID, launch{resume: parent.ClaudeSessionID, fork: true, newID: cid}); err != nil {
		drop()
		return Session{}, err
	}
	m.persistForkLog(ctx, newID, items)
	return m.Get(ctx, newID)
}

// Reconnect resumes a DISCONNECTED session without a prompt. Without a resumable
// conversation (no Claude session id yet, or its transcript is gone) it starts a new
// conversation in the same worktree and says so in LastError. It unarchives and
// unsnoozes the thread. No command calls it any more (a message starts a stopped
// thread: Send); it stays for SessionService.Reconnect and tests.
func (m *Manager) Reconnect(ctx context.Context, id string) (Session, error) {
	if _, err := m.startStopped(ctx, id, startOpts{backToList: true}); err != nil {
		if errors.Is(err, errNotStopped) {
			s, _ := m.Get(ctx, id)
			return Session{}, fmt.Errorf("%w: session %s is %s; only a disconnected session can be reconnected", ErrFailedPrecondition, id, s.State)
		}
		return Session{}, err
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
			m.log.Warn("pre-trust worktree failed", "session", id, "path", s.WorktreePath, "err", err)
		} else if changed {
			m.log.Info("pre-trusted worktree in claude config", "session", id, "path", realPath(s.WorktreePath))
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
	m.log.Info("session spawned", "session", id, "pid", r.st.proc.Pid(), "argv", argv, "cwd", s.WorktreePath)
	go func() {
		defer m.wg.Done()
		r.run()
	}()
	return nil
}

// claudeCommand is the argv and environment of a claude spawn for s: its model,
// effort and permission mode, the attachments dir and workspace members as --add-dir,
// the workspace prompt and env. The prompt is never in argv (it is the first user
// message). g is what the conversation's allow-for-session answers granted (an effort
// restart's; a fresh spawn starts without).
func (m *Manager) claudeCommand(s Session, l launch, g grants) (argv, env []string) {
	sa := spawnArgs{model: s.Model, effort: s.Effort, perm: s.PermissionMode,
		allowedTools: g.allow, disallowedTools: g.deny}
	if m.opts.AttachmentsDir != "" {
		// Every spawn (not only the first prompt's): a resumed or forked conversation
		// may read its images again.
		sa.addDirs = []string{m.opts.AttachmentsDir}
	}
	env = append(slices.Clip(m.opts.Env), paths.EnvSession+"="+s.ID)
	if s.WorkspaceID != "" {
		// The current members, every spawn (create, reconnect, fork): a repo added to
		// the workspace since the row was written is included.
		var ws *workspace.Snapshot
		if m.opts.Workspaces != nil {
			ws = m.opts.Workspaces.Snapshot()
		}
		if wl, ok := workspaceLaunch(ws, s.WorkspaceID, s.WorktreePath, isDir); ok {
			sa.addDirs = append(sa.addDirs, wl.addDirs...)
			sa.appendSystemPrompt = wl.prompt
			env = append(slices.Clip(env), wl.env...)
			if len(wl.missing) > 0 {
				m.log.Warn("workspace member worktrees missing; not passed to claude", "session", s.ID,
					"workspace", s.WorkspaceID, "paths", wl.missing)
			}
		} else {
			m.log.Warn("workspace of thread not found; starting without its members", "session", s.ID, "workspace", s.WorkspaceID)
		}
	}
	sa.addDirs = append(sa.addDirs, g.dirs...)
	return l.argv(m.opts.Claude, sa), env
}

// Rename sets a user-chosen name and disables auto-naming.
func (m *Manager) Rename(_ context.Context, id, name string) (Session, error) {
	name, err := cleanName(name, false)
	if err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Session{}, err
	}
	rec.s.Name, rec.s.AutoNamed, rec.namingTried = name, false, true
	m.commitLocked(rec, true)
	return rec.s, nil
}

// Pin sets or clears the user's pin. It works in any state and is persisted. Pinning an
// archived or snoozed thread unarchives or unsnoozes it.
func (m *Manager) Pin(_ context.Context, id string, pinned bool) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Session{}, err
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

// Close ends the process gracefully and waits until the session is DISCONNECTED.
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

// Remove closes the session if needed, kills and removes the shells that belong to it
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
		return fmt.Errorf("%w: session %s was started while being removed", ErrFailedPrecondition, id)
	}
	// The session's usage moves to the retired ledger in the delete's transaction.
	if err := retireSession(ctx, m.opts.DB, id, rec.s.Usage); err != nil {
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
	if len(rec.s.Usage) > 0 {
		bus.Publish[Event](m.opts.Bus, RetiredUsage{Buckets: m.retired})
	}
	return nil
}

// Shutdown stops every runner, which terminates its claude process (it talks to the
// daemon over pipes and cannot outlive it), and records live sessions as DISCONNECTED
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
		return fmt.Errorf("session: shutdown: %w", ctx.Err())
	}
}

// detach clears a finished runner from its record, applying fn to the session.
func (m *Manager) detach(r *runner, fn func(*Session)) {
	m.update(r.id, true, func(rec *record) {
		if rec.run == r {
			rec.run = nil
		}
		fn(&rec.s)
	})
}

// startNaming names a session from its first user message, once.
func (m *Manager) startNaming(id, msg string) {
	m.mu.Lock()
	rec, ok := m.recs[id]
	if !ok || rec.namingTried || rec.s.Name != "" || m.closed {
		m.mu.Unlock()
		return
	}
	rec.namingTried = true
	m.wg.Add(1)
	m.mu.Unlock()
	go func() {
		defer m.wg.Done()
		ctx, cancel := context.WithTimeout(withNamingSession(m.ctx, id), m.opts.NamingTimeout)
		defer cancel()
		start := time.Now()
		name, err := m.opts.Namer(ctx, msg)
		if err != nil {
			m.log.Warn("auto-naming failed", "session", id, "err", err)
			return
		}
		if _, ok := m.update(id, true, func(rec *record) {
			if rec.s.Name == "" {
				rec.s.Name, rec.s.AutoNamed = name, true
			}
		}); ok {
			m.log.Info("session auto-named", "session", id, "name", name, "took", time.Since(start).Round(time.Millisecond).String())
		}
	}()
}

// resolveWorktree maps (repo id, path) to a registered repo's worktree.
func (m *Manager) resolveWorktree(repoID, path string) (string, string, error) {
	if path != "" {
		if !filepath.IsAbs(path) {
			return "", "", fmt.Errorf("%w: worktree path %q must be absolute", ErrInvalidArgument, path)
		}
		path = filepath.Clean(path)
	}
	if repoID == "" && path == "" {
		return "", "", fmt.Errorf("%w: a repo, a worktree path, a workspace or no project is required", ErrInvalidArgument)
	}
	if m.opts.Repos == nil {
		if fi, err := os.Stat(path); err != nil || !fi.IsDir() {
			return "", "", fmt.Errorf("%w: worktree %q is not a directory", ErrInvalidArgument, path)
		}
		return repoID, path, nil
	}
	snap := m.opts.Repos.Snapshot()
	var repos []repo.Repo
	if repoID != "" {
		r, ok := snap.Repo(repoID)
		if !ok {
			return "", "", fmt.Errorf("%w: repo %s", ErrNotFound, repoID)
		}
		if path == "" {
			if len(r.Worktrees) > 0 {
				return r.ID, r.Worktrees[0].Path, nil
			}
			return r.ID, r.Path, nil
		}
		repos = []repo.Repo{r}
	} else if snap != nil {
		repos = snap.Repos
	}
	real := realPath(path)
	for _, r := range repos {
		for _, w := range r.Worktrees {
			if w.Path == path || realPath(w.Path) == real {
				return r.ID, w.Path, nil
			}
		}
		if len(r.Worktrees) == 0 && (r.Path == path || realPath(r.Path) == real) {
			return r.ID, r.Path, nil
		}
	}
	if repoID != "" {
		return "", "", fmt.Errorf("%w: %s is not a worktree of repo %s", ErrFailedPrecondition, path, repoID)
	}
	return "", "", fmt.Errorf("%w: %s is not a worktree of a registered repository (register it first)", ErrFailedPrecondition, path)
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
