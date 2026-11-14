package thread

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"maps"
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

// ProjectSource is the part of the project store threads need: resolving worktrees,
// deriving a member's worktree path, and creating (or, when a Create fails half way,
// removing again) the worktrees of a thread's members. *project.Git implements it.
type ProjectSource interface {
	Snapshot() *project.Snapshot
	CreateWorktree(ctx context.Context, opts project.CreateWorktreeOptions) (project.Worktree, error)
	// FetchBase fetches a new branch's base ahead of CreateWorktree, while the branch
	// still has no name.
	FetchBase(ctx context.Context, opts project.CreateWorktreeOptions)
	RemoveWorktree(ctx context.Context, opts project.RemoveWorktreeOptions) error
	// AbandonWorktree removes what an add that never finished left behind.
	AbandonWorktree(ctx context.Context, opts project.AbandonWorktreeOptions) error
	// Refresh reads a project's worktrees now, rather than at the next event.
	Refresh(ctx context.Context, id string) error
	DefaultWorktreePath(projectID, branch string) string
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
	// /tmp, which names with model.UtilityDefault unless the ctx carries
	// WithUtilityModel (the daemon's settingsNamer sets it per call).
	Namer Namer
	// BranchNaming returns the branch naming settings, read at every new worktree or
	// workspace (branchname.go). Default: DefaultBranchNaming.
	BranchNaming func() BranchNaming
	// BaseFromOrigin reads projects.base_from_origin at every new or recreated
	// worktree (project.CreateWorktreeOptions.BaseFromOrigin). Default: on.
	BaseFromOrigin func() bool
	// NewWorktreeDefault reads threads.default_worktree at every Move that leaves the
	// placement unspecified (move.go): true places the thread in a new worktree, false in
	// the project's folder (each member's own checkout). Default: false (the setting's
	// default, "current").
	NewWorktreeDefault func() bool
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
	// Memory reads the app memory (internal/store/memory: the user's standing
	// preferences) at every spawn, never cached across spawns; non-empty, its entries
	// follow ThreadPrompt in --append-system-prompt (memoryPrompt). An error is logged
	// and the thread starts without them. Nil: no memory.
	Memory func() ([]string, error)
	// AttachmentMaxAge is how long a staged attachment is kept. Default
	// AttachmentMaxAge (the package constant).
	AttachmentMaxAge time.Duration
	// AttachmentReapInterval is how often staged attachments are reaped while the
	// Manager runs. Default AttachmentReapInterval (the package constant).
	AttachmentReapInterval time.Duration
	// RefExists reports whether ref exists in the repository at dir; Create uses it
	// to keep new worktree branches unique. Default: git rev-parse --verify.
	RefExists func(ctx context.Context, dir, ref string) bool
	// CheckoutFacts reads what git says about the checkout at dir, against
	// origin/<defaultBranch>, for a wake (checkoutfacts.go). Default: git.
	CheckoutFacts func(ctx context.Context, dir, defaultBranch string) (CheckoutFacts, bool)
	// FetchBranch fetches origin's branch in the repository at dir and reports whether
	// origin has it; a thread whose cleaned-up worktree is recreated looks there before
	// making the branch again from its base (recreate.go). Default: git fetch.
	FetchBranch func(ctx context.Context, dir, branch string) bool
	// WorktreeRoot is the directory the app makes worktrees in (paths.Worktrees, the
	// project store's Options.WorktreeRoot). Only a missing cwd under it is recreated
	// when its thread starts (recreate.go); empty recreates none.
	WorktreeRoot string
	// TmpRoot is the directory each thread's TMPDIR is made under, one per thread id
	// (paths.Tmp; childcontext.go): made at every spawn, removed with the thread and,
	// for threads that are gone, at New. Empty: threads keep the daemon's TMPDIR.
	TmpRoot string
	// PagesRoot is the directory each thread's pages directory is made under, one per
	// thread id (paths.Pages; childcontext.go): made at every spawn and given to claude
	// as paths.EnvPages and --add-dir, removed with the thread and, for threads that
	// are gone, at New. Empty: none.
	PagesRoot string
	// PageStorageRoot is the directory each thread's page storage is kept under, one
	// directory per thread id (paths.PageStorage; pagestorage.go): what its pages keep
	// with cf.storage, removed with the thread and, for threads that are gone, at New.
	// Empty: the thread's pages cannot store anything.
	PageStorageRoot string
	// Env entries ("KEY=VALUE") are added to every claude process's environment
	// (Create, a start, Fork). The daemon passes its loopback endpoint and token so
	// the CLI inside a thread reaches it without the Unix socket. Every process also
	// gets its own thread's id as paths.EnvThread (CODE_FOUNDRY_THREAD), which the CLI
	// sends as its default --context-thread.
	Env []string
	// WorktreeCreated, when set, is called after Create made a new worktree for a thread
	// (CreateOptions.NewWorktree) and the thread has started. It must not block: the
	// daemon runs the project's on-worktree-create actions from it in the background.
	WorktreeCreated func(threadID, projectID, worktree string)
	// Archived, when set, is called with each thread an archive just archived (the
	// cascade's included), under the store's lock: it must return at once and not call
	// back into the store. The daemon removes the thread's worktree-mode worktrees nobody
	// else has from it, in the background (docs/notes/workspaces-v2-1-threads.md).
	Archived func(t Thread)
	// Removed, when set, is called with each thread Remove just removed, as it was (the
	// cascade's hidden threads included, each in turn), after its tombstone is in and
	// its row is gone from the snapshot, under the store's lock: it
	// must return at once and not call back into the store. The daemon removes the
	// thread's worktree-mode worktrees nobody else has from it, as for an archive
	// (docs/notes/remove-cleans-worktrees.md).
	Removed func(t Thread)
	// ShellsGoing, when set, is called when a thread's shells are about to be killed and
	// removed because it is archived, snoozed (or saved for later), or removed: after its
	// process closed, before its shells go, without the store's lock (shells.go). It runs
	// synchronously, so what it reads of the shells (what runs in them) is still there.
	// The daemon's layout glue closes the thread's tabs there, a snooze keeping its
	// terminal tabs to come back as fresh shells (docs/notes/shell-6-lifecycle.md).
	ShellsGoing func(ctx context.Context, id string, why ShellsGo)
	// Home is the cwd of a thread without a project (CreateOptions.NoProject). Default:
	// os.UserHomeDir().
	Home string
	// ActionRun looks up an action run (with its output) for wake subscriptions to runs
	// (subscriptions.go); nil refuses them. The daemon reads the action store; it also
	// calls Manager.ActionRunFinished for every run that ends.
	ActionRun func(ctx context.Context, id string) (ActionRun, bool)
	// PullRequest looks up a pull request ("owner/name#123") from the GitHub store's cache
	// only, for listings (subscriptions_pr.go); false when it is not there. The copy may be
	// old: it decides no wake. The daemon also calls Manager.PullRequestChanged for every
	// change the GitHub poll sees.
	PullRequest func(ctx context.Context, target string) (PullRequestInfo, bool)
	// LookupPullRequest asks GitHub for a pull request now, for Subscribe; an error
	// wrapping ErrNotFound means GitHub answered that it does not exist, any other that
	// the question failed. Subscribe bounds it and holds no lock. nil refuses wake
	// subscriptions to pull requests.
	LookupPullRequest func(ctx context.Context, target string) (PullRequestInfo, error)
	// WatchPullRequests is told the pull requests the subscriptions watch (sorted
	// "owner/name#123") whenever that set changes, from New on, so the GitHub poll keeps
	// them in scope. Called under the store's locks: it must not call back into it.
	WatchPullRequests func(targets []string)
	// WakeLimit is how many wakes a subscriber gets per rolling WakeWindow at most
	// (subscriptions_fire.go). Default WakeLimit (the package constant).
	WakeLimit int
	// WakeBatch is how long a thread wake waits for others to the same subscriber to
	// join it in one message (subscriptions_batch.go). Default WakeBatchWindow (1s);
	// negative: no batching, each wake goes alone and at once.
	WakeBatch time.Duration
	// DisablePreTrust skips writing folder trust into Claude's config before spawning
	// and before a RunIn move (set_cwd refuses an untrusted folder). For tests.
	DisablePreTrust bool

	NamingTimeout time.Duration // default 20s
	StartTimeout  time.Duration // bound on the initialize handshake (STARTING -> CONNECTED); default 15s
	CloseTimeout  time.Duration // graceful close (stdin closed) before SIGTERM; default 10s
	Tick          time.Duration // transcript poll and housekeeping; default 1s
	// WakeStartBackoff is how long wakes to a thread wait after its Claude failed to
	// start, doubling with each failure in a row (wakebackoff.go); default 1m.
	WakeStartBackoff time.Duration
	// ControlTimeout bounds the answer to a control request a Store call makes for its
	// caller (Interrupt, SetModel, SetPermissionMode; boundedControl); default 10s.
	ControlTimeout time.Duration
	// SendTimeout bounds writing a message to Claude's stdin: a Claude that stopped
	// reading it fails the send and the thread closes (onStalled); default 30s.
	SendTimeout time.Duration
	// WakeTimeout is how long a background end at the prompt holds the thread for the turn
	// Claude starts by itself (wake.go); default 10s.
	WakeTimeout    time.Duration
	StatusDebounce time.Duration // default 100ms
	// SlugTimeout bounds how long Create waits for the namer before naming a new
	// worktree's branch after the thread id. Default 10s.
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
	// TimerCheckInterval is how often timer wake subscriptions are checked against the
	// wall clock (fireTimers). Default TimerCheckInterval (the package constant).
	TimerCheckInterval time.Duration
	// IdleCheckInterval is how often connected threads are checked for an idle stop at
	// their prompt cache expiry (stopIdle). Default IdleCheckInterval (the package
	// constant).
	IdleCheckInterval time.Duration
	// IdleGrace is how long a process stays up at least before an idle stop. Default
	// IdleGrace (the package constant).
	IdleGrace time.Duration
	// McpPollInterval is how often an unsettled MCP status is asked again (mcp.go
	// settleMcp). Default 3s.
	McpPollInterval time.Duration
	// ServerProbe maps background shells to their process groups and finds the TCP ports
	// those listen on (servers.go). Default: procscan, with lsof.
	ServerProbe ServerProbe
	// Attended reports whether the user is looking at the app now (a GUI window is
	// visible and key). Only then does a viewer acknowledge a thread and see its
	// until-seen flags; the daemon calls AttendedChanged on each change (attended.go).
	// Must be safe to call with the store's locks held. Nil means always attended.
	Attended func() bool
	// Now is the wall clock: timestamps, snooze validation and wake-ups, idle stops.
	// Default time.Now.
	Now func() time.Time
	// batchClock is the wake batch window's clock (batchclock.go); tests set a manual
	// one. Default the monotonic clock.
	batchClock batchClock
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
	if o.BranchNaming == nil {
		o.BranchNaming = DefaultBranchNaming
	}
	if o.BaseFromOrigin == nil {
		o.BaseFromOrigin = func() bool { return true }
	}
	if o.NewWorktreeDefault == nil {
		o.NewWorktreeDefault = func() bool { return false }
	}
	if o.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return o, fmt.Errorf("thread: home directory: %w", err)
		}
		o.Home = home
	}
	if o.CheckoutFacts == nil {
		o.CheckoutFacts = gitCheckoutFacts
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
	def(&o.SlugTimeout, 10*time.Second)
	def(&o.NamingRetryDelay, 2*time.Second)
	def(&o.StartTimeout, 15*time.Second)
	def(&o.CloseTimeout, 10*time.Second)
	def(&o.ControlTimeout, 10*time.Second)
	def(&o.WakeStartBackoff, time.Minute)
	def(&o.SendTimeout, 30*time.Second)
	def(&o.Tick, time.Second)
	def(&o.WakeTimeout, 10*time.Second)
	def(&o.StatusDebounce, 100*time.Millisecond)
	def(&o.ActivityPublish, 15*time.Second)
	def(&o.AgentIdleClose, defaultAgentIdleClose)
	def(&o.AttachmentMaxAge, AttachmentMaxAge)
	def(&o.AttachmentReapInterval, AttachmentReapInterval)
	def(&o.CacheTTL, DefaultCacheTTL)
	def(&o.SnoozeCheckInterval, SnoozeCheckInterval)
	def(&o.TimerCheckInterval, TimerCheckInterval)
	def(&o.IdleCheckInterval, IdleCheckInterval)
	def(&o.IdleGrace, IdleGrace)
	def(&o.McpPollInterval, mcpPendingInterval)
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.batchClock == nil {
		o.batchClock = realClock{}
	}
	if o.ServerProbe == nil {
		o.ServerProbe = lsofProbe{}
	}
	if o.WakeLimit <= 0 {
		o.WakeLimit = WakeLimit
	}
	if o.WakeBatch == 0 {
		o.WakeBatch = WakeBatchWindow
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
	// removed are the tombstones of removed threads (tombstones.go).
	removed tombstones
	// pageStore serializes reads and writes of the threads' page storage (pagestorage.go).
	pageStore sync.Mutex
	// spawnExtras is what every spawn adds (spawnextras.go); nil: nothing.
	spawnExtras atomic.Pointer[SpawnExtrasFunc]
	// createDefaults picks the model and effort of threads some threads create
	// (residenthooks.go); nil: none.
	createDefaults atomic.Pointer[CreateDefaultsFunc]
	// servers maps the threads' background shells to their processes and probes the
	// ports they listen on (servers.go).
	servers *serverWatch
	// shellStops are the background shells StopShell is stopping (servers.go).
	shellStops struct {
		sync.Mutex
		keys map[shellKey]bool
	}
	// wtLocks serialize making one (project, branch) worktree (placement.go): key -> a
	// chan struct{} of one, held while full.
	wtLocks sync.Map
	// branchRes are the auto-named new branches Creates picked and are making now
	// (reserveBranch, branchname.go): "<repo path>\x00<branch>".
	branchResMu sync.Mutex
	branchRes   map[string]struct{}
	// residentTools are each resident's own --allowedTools rules (residenthooks.go):
	// resident name -> ResidentTools.
	residentTools sync.Map
	// wakeNotes are each resident's wake notes (residenthooks.go): resident name ->
	// WakeNoteFunc.
	wakeNotes sync.Map
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
	// envPrint fingerprints the spawn extras the running process got (envstale.go);
	// nil while no process runs. Replaced, never mutated.
	envPrint *extrasPrint
	// wait is the waiting overlay's state (waiting.go).
	wait waitState
	// startFails counts the failed starts since the last one that came up: wakes
	// back off (wakebackoff.go).
	startFails failedStarts
	// away is set while an archive or a snooze closes the thread (putaway.go
	// markPuttingAway): the close's end publishes a cut-off turn as idle at once.
	away *awayClose
	// archiving is set while an archive closes the thread, before ArchivedAt
	// (archive_group.go): wake counts leave it out.
	archiving bool
	// putAway is what the thread asked of itself mid-turn, carried out when the turn
	// ends (putaway.go). In memory only: a daemon restart loses the turn anyway.
	putAway *PutAway
	// moving is set while a Move places the thread or waits for its set_cwd (move.go):
	// a second Move is refused meanwhile.
	moving bool
	// lateMoveName is the title a move's naming gave after SlugTimeout while the move
	// was still queued: applied when it lands (move.go, applyLateMoveName).
	lateMoveName string
	// setup is the thread's setup stage while one runs (setup_run.go).
	setup *setupJob
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
	flags, err := loadFlags(ctx, opts.DB)
	if err != nil {
		return nil, err
	}
	m := &Manager{opts: opts, log: opts.Log, recs: map[string]*record{}, retired: retired,
		viewers: map[string]int{}, threads: map[string]*threadLog{}, cacheTTL: opts.CacheTTL}
	m.ctx, m.cancel = context.WithCancel(context.WithoutCancel(ctx))
	m.servers = newServerWatch(m, opts.ServerProbe)
	var lost, unmade []string
	reported := map[string]bool{}
	transcripts := &transcriptIndex{paths: opts.Paths} // transcriptmissing.go
	for _, s := range rows {
		s.unwaitLoaded() // nothing is waited on at startup (waiting.go)
		if s.SettingUp() && !s.Setup.Background {
			// The Create waiting for it died too: its caller got a connection error and
			// knows of no such thread. The row stays until what it made is gone (setup_run.go).
			opts.Log.Warn("thread lost with the create that waited for it: discarding it", "thread", s.ID)
			s.failSetup(opts.Now(), SetupRestarted)
			s.Removing = true
			unmade = append(unmade, s.ID)
			m.recs[s.ID] = &record{s: s}
			continue
		}
		if s.SettingUp() {
			// It lost its setup with the daemon: what it made is on the row (setup.go).
			opts.Log.Warn("thread setup lost: the daemon stopped during it", "thread", s.ID)
			lost = append(lost, s.ID)
			s.failSetup(opts.Now(), SetupRestarted)
			if err := saveThread(ctx, opts.DB, s); err != nil {
				return nil, err
			}
		}
		if s.State != StateDisconnected {
			lost = append(lost, s.ID)
			s.State, s.DisconnectReason = StateDisconnected, ReasonDaemonRestarts
			st, reason := disconnectedStatus(s.Status, s.StatusReason, false)
			switch {
			case reportedAtLoad(ctx, m, s):
				// Its final report came after its last message: it finished
				// (restartcut.go); its subscribers hear so after the start.
				reported[s.ID] = true
				st, reason = StatusNeedsAttention, "finished"
				opts.Log.Info("the daemon died after a thread's final report: finished, not interrupted", "thread", s.ID)
			case s.PendingFirst != nil:
				// Its first message never went out: no turn to resume (firstprompt.go).
				opts.Log.Warn("first message not delivered: the daemon died; it goes at the next start", "thread", s.ID)
			case midTurn(s):
				// The turn died with the daemon (resumenote.go).
				s.ResumeNote = ResumeNote{Cause: ResumeRestart, At: opts.Now()}
			}
			s.setStatus(st, reason, opts.Now())
			if err := saveThread(ctx, opts.DB, s); err != nil {
				return nil, err
			}
		}
		// Archived or snoozed again after a wake, before Archive and Snooze cleared
		// the "snooze ended" status (snooze.go).
		if (!s.ArchivedAt.IsZero() || s.Snoozed()) && clearSnoozeEnded(&s, opts.Now()) {
			if err := saveThread(ctx, opts.DB, s); err != nil {
				return nil, err
			}
		}
		s.CacheExpiresAt = cacheExpiry(s.LastResultAt, opts.CacheTTL)
		s.Flags = flags[s.ID]
		s.TranscriptMissing = transcripts.gone(s) // every thread is stopped here
		m.recs[s.ID] = &record{s: s, namingTried: s.namedForGood()}
	}
	// Links that predate copying them up the CreatedBy chain (prlink_children.go).
	m.foldChildLinks(ctx)
	// Wake subscriptions, armed with the threads as loaded (subscriptions.go).
	if m.subs, err = loadSubscriptionState(ctx, opts.DB, opts.Log, m.recs, opts.WatchPullRequests); err != nil {
		return nil, err
	}
	m.subs.changed = func(id string) { bus.Publish(opts.Bus, SubscriptionsChanged{SubscriberID: id}) }
	m.subs.reportedAtStop = reported
	m.mu.Lock()
	m.rebuildLocked()
	m.mu.Unlock()
	// Nothing runs yet: the TMPDIRs of threads that are gone go (childcontext.go).
	m.reapThreadTmps()
	// The runs the daemon lost: loading a stopped thread's log closes what its run left
	// open, the turn included (closeLostRun); done now, not when someone first reads the
	// items, so the timeline is whole at once.
	for _, id := range lost {
		if _, err := m.thread(ctx, id); err != nil {
			m.log.Warn("close the open turn of a thread the daemon lost", "thread", id, "err", err)
		}
	}
	m.startDiscardingUnmade(unmade)
	// Rows from before threads.branch get theirs from the project store (recreate.go).
	m.startBackfill()
	// Threads from before the search index get their documents (search_index.go).
	m.startSearchBackfill(ctx)
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
	// Timer wake subscriptions, from the first tick on, so a timer that came due while
	// the daemon was stopped fires once the daemon is up (subscriptions_timer.go).
	timerTicker := time.NewTicker(opts.TimerCheckInterval)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer timerTicker.Stop()
		m.fireTimersLoop(timerTicker.C)
	}()
	// Background shells' servers (servers.go): idle until a shell runs.
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.servers.run(m.ctx)
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
	return Thread{}, m.notFound(id)
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
//
// The status shown is the waiting overlay's (waiting.go); the thread's subscribers are
// re-evaluated after the wake subscriptions saw the change (a one-shot that fired is
// gone by then, its wake queued).
func (m *Manager) commitLocked(rec *record, persist bool) {
	if m.applyWaitingLocked(rec) {
		persist = true
	}
	if persist {
		if err := saveThread(context.Background(), m.opts.DB, rec.s); err != nil {
			m.log.Error("persist thread", "thread", rec.s.ID, "err", err)
		}
	}
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Updated{Thread: rec.s})
	var subscribers []string
	if m.subs != nil {
		subscribers = m.subs.subscribersOf(rec.s.ID)
	}
	m.observeLocked(rec.s) // wake subscriptions (subscriptions.go)
	m.rewaitLocked(subscribers)
	m.releaseHeldLocked(rec.s.ID) // a lead's held wake (subscriptions_hold.go)
}

func (m *Manager) record(id string) (*record, error) {
	rec, ok := m.recs[id]
	if !ok {
		return nil, m.notFound(id)
	}
	return rec, nil
}

// Create spawns claude in a worktree, in two stages (setup.go). The fast stage refuses
// what needs no slow work, with nothing made, then publishes the thread with its
// provisional name and its first message in the timeline. The setup stage names the
// branch, makes the worktrees and spawns (setup_run.go). Create waits for it and returns
// the thread STARTING; a failure removes the thread and what was made, and is the error.
// With BackgroundSetup it returns from the fast stage and the thread follows in
// Thread.Setup; a failure stays on the thread. With NoProject it runs in Options.Home and
// has no owner.
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
	attachments, err := messageAttachments(m.opts.AttachmentsDir, o.Attachments)
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
	appendPrompt, err := cleanSeed(o.SystemPromptAppend, nil, "")
	if err != nil {
		return Thread{}, err
	}
	// The creator's name now: the note and created_by_name keep it (metadata.go).
	creatorID, creatorName, err := m.creator(o.CreatedBy)
	if err != nil {
		return Thread{}, err
	}
	if err := m.applyCreateDefaults(ctx, creatorID, &o); err != nil {
		return Thread{}, err
	}
	if err := m.checkNotify(o.Notify, o.NotifyGroup, creatorID); err != nil {
		return Thread{}, err
	}
	owner, err := checkOwner(o)
	if err != nil {
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
		Owner: owner, SpawnEnv: slices.Clone(o.Env), SpawnAddDirs: slices.Clone(o.AddDirs), Epoch: 1,
		SystemPromptAppend: appendPrompt.prompt,
	}
	if o.Cwd != "" && !o.NoProject {
		return Thread{}, fmt.Errorf("%w: cwd is for a thread without a project (a project's thread runs in its worktree)", ErrInvalidArgument)
	}
	if o.ResumeSession != "" {
		if !o.NoProject {
			return Thread{}, fmt.Errorf("%w: resume_session is for a thread without a project", ErrInvalidArgument)
		}
		if !SessionIDPattern.MatchString(o.ResumeSession) {
			return Thread{}, fmt.Errorf("%w: resume_session %q is not a Claude session id", ErrInvalidArgument, o.ResumeSession)
		}
		if _, ok := m.opts.Paths.transcriptPath(m.opts.Home, o.ResumeSession); !ok {
			return Thread{}, ErrTranscriptMissing
		}
	}
	if o.NoProject && (o.ProjectID != "" || o.WorktreePath != "" || o.NewWorktree != nil || o.WorkspaceID != "" ||
		len(o.ProjectIDs) > 0 || o.Like != "" || o.NewBranch || o.CheckoutMode) {
		return Thread{}, fmt.Errorf("%w: no_project excludes a project, projects, worktree, new worktree, like and workspace", ErrInvalidArgument)
	}
	if len(o.DraftJSON) > MaxDraftJSON {
		return Thread{}, fmt.Errorf("%w: the draft has more than %d bytes", ErrInvalidArgument, MaxDraftJSON)
	}
	var p placedThread
	var w *worktreePlan
	switch {
	case o.NoProject:
		// No owner: ProjectID and WorkspaceID stay empty and claude starts in the home
		// directory (or Cwd inside it), trusted like any cwd (spawn).
		if p.path, err = m.noProjectCwd(o.Cwd); err != nil {
			return Thread{}, err
		}
	default:
		if p, w, err = m.planThread(ctx, id, name, creatorID, o); err != nil {
			return Thread{}, err
		}
	}
	shown := p
	if w != nil {
		// Its cwd comes with its worktrees, even a workspace's folder that exists now: a
		// path here would read as a landed placement, and each member as its main checkout.
		shown.path = ""
	}
	s = shown.apply(s)
	if s.Name == "" {
		// Until the namer answers (provisional.go); namingTried stays false so it runs.
		s.nameProvisionally(o.ComposerPrompt, o.InitialPrompt)
	}
	now := m.opts.Now()
	s.CreatedAt, s.LastActivityAt = now, now
	s.setStatus(StatusBusy, ReasonSettingUp, now)
	s.Setup = &Setup{Phase: SetupRunning, StartedAt: now, Steps: m.setupSteps(w), Request: setupRequestOf(o), Background: o.BackgroundSetup, Held: w.sharedPaths()}
	if prompt != "" {
		// The prompt goes in as the first user message; the item keeps it as typed. It is on
		// the row until Claude has it, so a daemon stop before the handshake keeps it for
		// the next start (firstprompt.go). Its references are rewritten once the worktrees
		// exist (landPlacement).
		s.PendingFirst = pendingFirstOf(&outgoing{text: strings.TrimSpace(o.InitialPrompt),
			composer: strings.TrimSpace(o.ComposerPrompt), attachments: attachments, prompt: prompt, by: creatorID})
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Thread{}, ErrClosed
	}
	rec := &record{s: s, namingTried: name != ""}
	rec.reserve()
	m.recs[id] = rec
	m.commitLocked(rec, true)
	m.mu.Unlock()
	if err := m.openTimeline(ctx, s, creatorName, brief); err != nil {
		m.discardCreate(id)
		return Thread{}, err
	}
	l := launch{newID: cid}
	if o.ResumeSession != "" {
		l = launch{resume: o.ResumeSession, fork: true, newID: cid, freshPrompt: true}
	}
	j := &setupJob{id: id, creatorID: creatorID, o: o, p: p, w: w, prompt: prompt, l: l}
	if err := m.beginSetup(ctx, j); err != nil {
		m.discardCreate(id)
		return Thread{}, err
	}
	if o.BackgroundSetup {
		go func() { _ = m.finishSetup(j) }()
	} else if err := m.finishSetup(j); err != nil {
		return Thread{}, err
	}
	return m.Get(ctx, id)
}

// openTimeline writes a new thread's first items: its creator's note, then the user's
// message, which goes out under this id once Claude answers (firstprompt.go).
func (m *Manager) openTimeline(ctx context.Context, s Thread, creatorName, brief string) error {
	if s.CreatedBy != "" {
		// The text keeps the name at creation (the CLI's and a removed creator's
		// fallback); NoteCreatedBy lets the GUI show the creator's current name.
		note, err := m.startNote(ctx, s.ID, Item{ID: createdByNoteID, Text: createdByNoteText(creatorName, brief), NoteCreatedBy: s.CreatedBy})
		if err != nil {
			return err
		}
		m.saveItem(s.ID, note)
		m.log.Info("thread created by another thread", "thread", s.ID, "created_by", s.CreatedBy)
	}
	if s.PendingFirst == nil {
		return nil
	}
	log, err := m.thread(ctx, s.ID)
	if err != nil {
		return fmt.Errorf("thread: create %s: %w", s.ID, err)
	}
	first := s.PendingFirst.outgoing()
	if _, err := recordUser(itemWriter{log: log, save: func(it Item) { m.saveItem(s.ID, it) }}, first); err != nil {
		return err
	}
	m.setPendingFirstItem(s.ID, first.itemID)
	return nil
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
	if err := m.refuseResident(id, "forked"); err != nil {
		return Thread{}, err
	}
	if err := setupRefusal(parent, "forked"); err != nil {
		return Thread{}, err
	}
	if parent.ClaudeSessionID == "" {
		return Thread{}, fmt.Errorf("%w: thread %s has no saved conversation to fork yet", ErrFailedPrecondition, id)
	}
	if _, ok := m.opts.Paths.transcriptPath(parent.WorktreePath, parent.ClaudeSessionID); !ok {
		// A stopped parent says so from now on (transcriptmissing.go).
		m.setTranscriptMissing(id, parent.ClaudeSessionID, parent.needsTranscript())
		return Thread{}, ErrTranscriptMissing
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
		ID: newID, ProjectID: parent.ProjectID, ProjectIDs: parent.Projects(), WorktreePath: parent.WorktreePath, WorkspaceID: parent.WorkspaceID,
		// The fork runs in the parent's checkouts, so it inherits what the worktree was made
		// for: a cleanup that removes it is undone when either resumes (recreate.go).
		BaseRef: parent.BaseRef, CreatedWorktree: parent.CreatedWorktree, Branch: parent.Branch,
		CheckoutPaths: maps.Clone(parent.CheckoutPaths), LastHeads: maps.Clone(parent.LastHeads),
		Name: name, AutoNamed: autoNamed,
		Model: parent.Model, Effort: parent.Effort, PermissionMode: parent.PermissionMode,
		State: StateStarting, CreatedAt: now, LastActivityAt: now, ParentID: parent.ID, Epoch: 1,
		// The fork resumes the parent's conversation, system prompt and all (memory.go).
		MemoryHash: parent.MemoryHash,
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
	// The fork shares the parent's checkouts: one a cleanup removed is made again first.
	remade, replaced, err := m.ensureMembers(ctx, s)
	if err != nil {
		drop()
		return Thread{}, err
	}
	if err := m.spawn(ctx, newID, launch{resume: parent.ClaudeSessionID, fork: true, newID: cid}); err != nil {
		drop()
		return Thread{}, err
	}
	m.persistForkLog(ctx, newID, items)
	if len(remade) > 0 || len(replaced) > 0 {
		// As a start's (startStopped): the notes in the fork's timeline, then the
		// projects' on-worktree-create actions.
		if log, err := m.thread(ctx, newID); err != nil {
			m.log.Warn("note the recreated worktrees", "thread", newID, "err", err)
		} else {
			w := itemWriter{log: log, save: func(it Item) { m.saveItem(newID, it) }}
			if len(remade) > 0 {
				w.add(Item{ID: "note-" + itemSuffix(), Kind: KindNote, Text: remadeNote(remade, s.Branch)})
			}
			for _, note := range replaced {
				w.add(Item{ID: "note-" + itemSuffix(), Kind: KindNote, Text: note})
			}
		}
		if m.opts.WorktreeCreated != nil {
			for _, w := range remade {
				m.opts.WorktreeCreated(newID, w.projectID, w.path)
			}
		}
	}
	return m.Get(ctx, newID)
}

// spawn starts claude for record id (claude -p over stream-json, stream.go) and its
// runner. The thread's pending first message (firstprompt.go), then the record's
// message that started it, if any, are sent once the handshake succeeds.
func (m *Manager) spawn(ctx context.Context, id string, l launch) error {
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	s := rec.s
	first := firstMessages(s, rec.first)
	rec.first = nil
	m.mu.Unlock()
	m.rewriteQueued(s, first)
	// Every other member's checkout is an --add-dir, and claude refuses a missing one.
	if err := m.requireCheckouts(s); err != nil {
		return err
	}
	if err := m.ensureCwd(ctx, s); err != nil {
		return err // not exec's ENOENT, which reads as a missing claude (cwd.go)
	}

	m.preTrustCheckouts(s)

	r := newRunner(m, id, s.WorktreePath, l)
	if l.resume == "" {
		// A fresh session: a reseed's prefix goes with its first message (reseed.go).
		r.seed = s.SeedPrefix
	}
	if s.ParentID != "" {
		// A fork's transcript starts with a copy of its parent's records, billed to
		// the parent; they keep their original times (usage.go).
		r.usage.notBefore = s.CreatedAt
	}
	cs := s
	if l.move != nil {
		cs = s.withMove(l.move) // the destination's --add-dir list and instructions (move.go)
	}
	argv, env, extras, mem := m.claudeCommand(ctx, cs, l, grants{}, true)
	r.memNote, r.memHash = mem.note, mem.hash
	if err := m.spawnStream(ctx, s, r, argv, env, first); err != nil {
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
	if rec.setup != nil && rec.setup.cancelAsked {
		// A cancel came first: this commit is the line between its two answers (CancelSetup).
		m.mu.Unlock()
		r.abandon()
		return errSetupCancelled
	}
	rec.run = r
	rec.release()
	if rec.s.SettingUp() {
		rec.s.Setup = rec.s.Setup.done(now) // with the process, in one commit (setup.go)
	}
	late := lateMessages(rec.s, first) // sent since the read above; nothing else has them
	first = append(first, late...)
	rec.spawnedWith(extras)
	if mem.fresh {
		rec.s.MemoryHash = mem.hash // its system prompt has the memory as it is now
	}
	rec.s.State = StateStarting
	// The fresh process owns status from here: the persisted one is cleared, or, with a
	// message waiting for the handshake, the thread is on that turn already.
	if len(first) > 0 {
		rec.s.setStatus(StatusBusy, "working", now)
	} else {
		rec.s.setStatus(StatusUnknown, "", now)
	}
	rec.s.DisconnectReason, rec.s.ExitCode = "", 0
	rec.s.LastActivityAt = now
	placed := rec.s
	m.commitLocked(rec, true)
	m.wg.Add(1)
	m.mu.Unlock()
	if len(late) > 0 {
		// Before run starts, which owns the state from then on.
		m.rewriteQueued(placed, late)
		r.st.addQueued(late)
	}
	if len(first) > 0 && first[0].itemID == "" {
		// A row's first message with no item yet (Create writes its own at once) goes into
		// the timeline now, before the handshake: a start that fails leaves the message,
		// then why, for the user to copy or send again. sendMessage delivers it under
		// this id. Before run starts, so nothing else writes the log yet. The row's
		// pending first message keeps the id, so a later start does not write it again
		// (firstprompt.go).
		if _, err := recordUser(r.st.proj.w, first[0]); err != nil {
			m.log.Warn("record the first prompt before the handshake", "thread", id, "err", err)
		} else if first[0].first {
			m.setPendingFirstItem(id, first[0].itemID)
		}
	}
	m.log.Info("thread spawned", "thread", id, "pid", r.st.proc.Pid(), "argv", argv, "cwd", s.WorktreePath)
	go func() {
		defer m.wg.Done()
		r.run()
	}()
	return nil
}

// claudeCommand is the argv and environment of a claude spawn for s: its model,
// effort and permission mode, --add-dir for the skills dir, the spawn extras' dirs
// (plugins), the attachments dir, its pages dir, a referenced workspace's managed dir,
// the other members' checkouts and the granted dirs (in that order, every spawn), the
// system prompt (ThreadPrompt, the workspace's instructions, the app memory read now,
// the thread's own append), then the extras' env and PATH entries. The prompt is never in argv (it
// is the first user message). g is what the conversation's allow-for-session answers
// granted (an effort restart's; a fresh spawn starts without). wait lets the extras wait
// briefly for a plugin still starting (spawnextras.go); the effort restart passes false.
// x is the extras it applied, for the staleness fingerprint (envstale.go); mem is what
// the spawn did with the app memory (memory.go).
func (m *Manager) claudeCommand(ctx context.Context, s Thread, l launch, g grants, wait bool) (argv, env []string, x SpawnExtras, mem spawnMemory) {
	// A resident's own rules (residenthooks.go) come before the conversation's grants.
	residentAllow, residentDeny := m.residentRules(s)
	entries, memOK := m.memory(s.ID)
	mem = memorySpawned(l, s.MemoryHash, entries, memOK)
	sa := spawnArgs{model: s.Model, effort: s.Effort, perm: s.PermissionMode,
		allowedTools: allowedTools(append(residentAllow, g.allow...)), disallowedTools: append(residentDeny, g.deny...),
		appendSystemPrompt: systemPrompt("", entries, ownAppend(s))}
	if m.opts.SkillsDir != "" {
		// First, so the skills load whatever else is added (docs/notes/agent-skills.md).
		sa.addDirs = append(sa.addDirs, m.opts.SkillsDir)
	}
	env = append(slices.Clip(m.opts.Env), paths.EnvThread+"="+s.ID)
	// Its own TMPDIR, before the workspace's and the thread's own env, which may set
	// another (childcontext.go); plugins cannot (a reserved name).
	env = append(env, m.tmpEnv(s.ID)...)
	// Where it writes the pages it shows (childcontext.go): an --add-dir below too.
	pages := m.pagesDir(s.ID)
	if pages != "" {
		env = append(env, paths.EnvPages+"="+pages)
	}
	members := m.memberProjects(s) // the plugins' scope (spawnextras.go)
	// A referenced workspace: its managed dir (links re-checked) and its instructions,
	// read now (workspace.go).
	ws := m.workspaceSpawn(ctx, s)
	if ws.prompt != "" {
		sa.appendSystemPrompt = systemPrompt(ws.prompt, entries, ownAppend(s))
	}
	x = m.extras(ctx, spawnInfoOf(s, members, wait))
	sa.addDirs = append(sa.addDirs, x.AddDirs...)
	for _, d := range s.SpawnAddDirs { // the thread's own, after the plugins' (owner.go)
		if !slices.Contains(sa.addDirs, d) && isDir(d) {
			sa.addDirs = append(sa.addDirs, d)
		}
	}
	if m.opts.AttachmentsDir != "" {
		// Every spawn (not only the first prompt's): a resumed or forked conversation
		// may read its images again.
		sa.addDirs = append(sa.addDirs, m.opts.AttachmentsDir)
	}
	if pages != "" {
		sa.addDirs = append(sa.addDirs, pages)
	}
	// The workspace's managed dir, then every other member's checkout (checkouts.go).
	if ws.addDir != "" {
		sa.addDirs = append(sa.addDirs, ws.addDir)
	}
	dirs, missing := m.memberDirs(s)
	if len(missing) > 0 && wait {
		m.log.Warn("member checkouts missing; not passed to claude", "thread", s.ID, "projects", len(missing))
	}
	sa.addDirs = append(sa.addDirs, dirs...)
	sa.addDirs = append(sa.addDirs, g.dirs...)
	env = append(slices.Clip(env), x.Env...)
	env = append(env, s.SpawnEnv...)
	if p := prependPath(env, x.PathPrepend, os.Getenv("PATH")); p != "" {
		env = append(env, p)
	}
	return l.argv(m.opts.Claude, sa), env, x, mem
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

// Remove forgets a thread: it closes it like Close, kills and removes the shells that
// belong to it (terminals labelled termlabel.KindShell with its id), stops what it left
// running in its worktree (stopStrays), retires its usage and deletes its row, keeping a
// tombstone for RemovedTTL (tombstones.go). Meanwhile the thread is Removing, so the
// closing snapshot meets no wait or wake condition; once it is forgotten its subscribers
// get a CondRemoved wake (subscriptions_removed.go). When it fails the thread stays, no
// longer Removing.
//
// Removing first removes, the same way, the threads below it (ArchiveCascade, as Archive
// does): the thread's own process is
// closed first, so it creates no more; then each pass takes the hidden threads below it
// that are not being removed yet, in tree order, their closes beginning together, until a
// pass finds none (one created below it while the others were being removed is caught by
// the next pass); then the thread itself. A hidden archived thread below it goes too:
// nothing would lead to it once the thread is gone. One that fails is skipped (logged,
// and named in the *CascadeError returned once the thread itself was removed); once its
// creator is gone it is shown in the sidebar (Thread.InSidebar), nothing stored.
func (m *Manager) Remove(ctx context.Context, id string) (err error) {
	if err := m.refuseResident(id, "removed"); err != nil {
		return err
	}
	if err := m.setRemoving(id, true); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = m.setRemoving(id, false) // gone meanwhile: nothing to clear
		}
	}()
	if err := m.stopSetup(ctx, id); err != nil { // its goroutine must not outlive the record
		return err
	}
	if err := m.Close(ctx, id); err != nil { // before the cascade: it creates no more
		return err
	}
	tried := map[string]bool{}
	var failed []CascadeFailure
	cascaded := 0
	for pass := 0; pass < removeCascadePasses; pass++ {
		targets := m.removeCascadeTargets(id, tried)
		if len(targets) == 0 {
			break
		}
		// They are all marked first, then their closes begin together.
		for _, t := range targets {
			tried[t.ID] = true
			_ = m.setRemoving(t.ID, true) // gone meanwhile: removeOne says so
		}
		for _, t := range targets {
			m.requestClose(t.ID)
		}
		for _, t := range targets {
			if err := m.removeOne(ctx, t.ID); err != nil {
				m.log.Warn("remove a hidden thread with the thread above it", "thread", t.ID, "root", id, "err", err)
				failed = append(failed, CascadeFailure{ID: t.ID, Err: err})
				_ = m.setRemoving(t.ID, false) // shown once its creator is gone
				continue
			}
			cascaded++
			m.log.Info("removed thread with the thread above it", "thread", t.ID, "root", id, "depth", t.Depth)
		}
	}
	if err := m.removeOne(ctx, id); err != nil {
		return err
	}
	if cascaded > 0 || len(failed) > 0 {
		m.log.Info("removed thread's hidden threads", "thread", id, "cascaded", cascaded, "cascade_failed", len(failed))
	}
	if len(failed) > 0 {
		return &CascadeError{ID: id, Failed: failed, Verb: "removed"}
	}
	return nil
}

// removeCascadePasses bounds Remove's passes over the hidden threads below the thread:
// each pass closes what the last one found, so only a thread created in that window
// needs another, and the root's own process is closed before the first.
const removeCascadePasses = 4

// removeCascadeTargets are the hidden threads below id that removing id takes with it
// now (ArchiveCascade): not being removed, not in skip. Archived ones included.
func (m *Manager) removeCascadeTargets(id string, skip map[string]bool) []Thread {
	var out []Thread
	for _, t := range ArchiveCascade(m.Snapshot().Threads, id) {
		if !t.Removing && !skip[t.ID] {
			out = append(out, t)
		}
	}
	return out
}

// removeOne is Remove for one thread, marked Removing already (setRemoving): it closes
// it, kills and removes its shells, stops its strays and its TMPDIR, then, under m.mu,
// retires its usage, deletes its row and leaves its tombstone. Its children not being
// removed are shown in the sidebar from then on (Thread.InSidebar). A start meanwhile
// fails it.
func (m *Manager) removeOne(ctx context.Context, id string) error {
	if err := m.stopSetup(ctx, id); err != nil {
		return err
	}
	m.cleanSetup(ctx, id) // nothing else knows what a setup that never finished made
	if err := m.Close(ctx, id); err != nil {
		return err
	}
	if err := m.removeShells(ctx, id, ShellsRemoved); err != nil {
		return err
	}
	m.stopStrays(ctx, id) // what its Bash calls left running in its worktree (strays.go)
	// Its process is gone, and a start meanwhile fails the removal below: its TMPDIR
	// goes (a failed removal leaves the thread to make it again at its next spawn).
	m.removeThreadTmp(id)
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
	// The tombstone goes in before the event: a waiter that sees Removed finds it.
	tomb := removedThread(rec.s, m.opts.Now().Round(0).Truncate(time.Millisecond))
	m.removed.add(tomb)
	m.rebuildLocked()
	m.log.Info("thread removed", "thread", id, "name", rec.s.Name, "created_by", rec.s.CreatedBy)
	if m.opts.Removed != nil {
		m.opts.Removed(rec.s) // its worktrees nobody else has go (the daemon's archiveCleaner)
	}
	bus.Publish[Event](m.opts.Bus, Removed{ID: id})
	m.fireRemovedLocked(tomb)     // before forgetLocked deletes the subscriptions
	m.forgetLocked(id, "removed") // wake subscriptions (subscriptions.go)
	m.releaseHeldLocked(rec.s.CreatedBy)
	if len(rec.s.Usage) > 0 {
		bus.Publish[Event](m.opts.Bus, RetiredUsage{Buckets: m.retired})
	}
	return nil
}

// setRemoving sets or clears Thread.Removing (tombstones.go) and publishes the thread.
func (m *Manager) setRemoving(id string, on bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return err
	}
	if rec.s.Removing != on {
		rec.s.Removing = on
		m.commitLocked(rec, false)
	}
	return nil
}

// Shutdown stops every runner, which terminates its claude process (it talks to the
// daemon over pipes and cannot outlive it), and records live threads as DISCONNECTED
// ("daemon stopped"). A runner still going when ctx ends is stuck: its process group
// is killed (runner.kill). The Manager is unusable afterwards.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	m.suppressHeldLocked() // held wakes go at the next start (subscriptions_restart.go)
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
		// A runner still going is stuck (a write Claude does not read): its process
		// must not outlive the daemon.
		for _, r := range runners {
			select {
			case <-r.done:
			default:
				r.kill()
			}
		}
		return fmt.Errorf("thread: shutdown: %w", ctx.Err())
	}
}

// detach clears a finished runner from its record, applying fn to the thread. A viewer
// that is there while attended sees what the runner leaves: viewersChanged may have come
// too late for it, and a close puts back the status from when it began (attended.go).
func (m *Manager) detach(r *runner, fn func(*Thread)) {
	m.update(r.id, true, func(rec *record) {
		if rec.run == r {
			rec.run = nil
			if r.startFailed {
				rec.noteStartFailed() // wakes back off (wakebackoff.go)
			}
			// The process is gone: the next spawn gets the current extras.
			rec.envPrint = nil
			rec.s.PluginEnvStale, rec.s.PluginEnvChange = false, ""
			m.dropPutAwayLocked(rec, "Claude's process ended") // the turn it waited for is over
		}
		fn(&rec.s)
		if rec.away != nil && putAwayStatus(&rec.s, rec.away.reason, m.opts.Now()) {
			rec.away.cut = true
		}
		m.seenStoppedLocked(rec)
	})
	m.servers.changed() // its shells are gone (servers.go)
}

// startNaming names a thread from its first user message, once (callNamer).
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
		n, err := m.callNamer(ctx, id, NamingRequest{Message: msg})
		if err != nil {
			m.log.Warn("auto-naming failed", "thread", id, "err", err)
			return
		}
		name := n.Title
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
		return project.Project{}, classified{kind: ErrNotFound, err: fmt.Errorf("project %s is not registered", ref)}
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
