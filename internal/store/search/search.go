// Package search is the search dialog's daemon side (docs/notes/search-5-agent-daemon.md):
// its history, the last MaxEntries searches of both modes, and Agent search, a hidden
// one-shot Claude run on the utility model that searches the user's threads with the CLI
// (thread search, thread read) and reports the messages that answer the user's question.
//
// The run is no thread: the store starts claude itself over stream-json
// (internal/claudestream), so it never reaches the thread store's snapshot, the sidebar,
// notifications, the search index or Usage. Its cost is on its history entry. Its tools
// are Bash limited by permission rules to the four CLI verbs it needs (runArgs), in an
// empty working directory.
//
// A hit is accepted only when its quote occurs in that message's searchable text, in a
// thread of the default search scope (thread.Manager.VerifyQuote). Promote continues the
// run's Claude conversation in a normal thread without a project.
package search

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Errors. The API maps them to Connect codes; the message is for the caller (a model
// reporting a hit reads it to fix its call).
var (
	ErrNotFound           = errors.New("search not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	ErrClosed             = errors.New("search store closed")
)

// Mode is a history entry's mode.
type Mode string

// Modes.
const (
	ModeAgent Mode = "agent"
	ModeFind  Mode = "find"
)

// Status is an agent search's state. A Find entry has none.
type Status string

// Statuses.
const (
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
	StatusStopped Status = "stopped"
)

// Ended reports whether s is a finished run's status.
func (s Status) Ended() bool { return s == StatusDone || s == StatusFailed || s == StatusStopped }

// Sizes and caps.
const (
	// MaxEntries is how many searches the history keeps (both modes); older ones go.
	MaxEntries = 50
	// MaxHits is how many hits a run may report.
	MaxHits = 8
	// MaxToolCalls is how many tool calls a run makes before it is asked for its answer.
	MaxToolCalls = 24
	// WallTime is how long a run may take in all; at WrapUpAfter it is asked for its
	// answer, at WallTime it is stopped.
	WallTime    = 2 * time.Minute
	WrapUpAfter = 95 * time.Second
	// MaxQuestionRunes bounds a question.
	MaxQuestionRunes = 2000
	// MaxWhyRunes bounds a hit's why.
	MaxWhyRunes = 300
)

// Hit is one accepted hit.
type Hit struct {
	N             int            `json:"n"`
	ThreadID      string         `json:"thread_id"`
	ItemID        string         `json:"item_id"`
	Ordinal       int64          `json:"ordinal"`
	Speaker       thread.Speaker `json:"speaker"`
	ItemCreatedAt time.Time      `json:"item_created_at"`
	Quote         string         `json:"quote"`
	Why           string         `json:"why"`
	Opened        bool           `json:"opened,omitempty"`
	ReportedAt    time.Time      `json:"reported_at"`

	// ThreadName and Archived are the thread's now, filled in when an entry is read
	// (never stored).
	ThreadName string `json:"-"`
	Archived   bool   `json:"-"`
}

// StepKind is what a step did.
type StepKind string

// Step kinds.
const (
	StepSearch StepKind = "search"
	StepRead   StepKind = "read"
	StepOther  StepKind = "other"
)

// Step is one of the run's tool calls (steps.go).
type Step struct {
	Index      int      `json:"index"`
	Kind       StepKind `json:"kind"`
	Done       bool     `json:"done,omitempty"`
	Failed     bool     `json:"failed,omitempty"`
	Text       string   `json:"text"`
	Query      string   `json:"query,omitempty"`
	Hits       int      `json:"hits,omitempty"`
	ThreadID   string   `json:"thread_id,omitempty"`
	ThreadName string   `json:"thread_name,omitempty"`
	From       int64    `json:"from,omitempty"`
	To         int64    `json:"to,omitempty"`
	// Detail names an OTHER step: the call's description, else its command's start.
	Detail string `json:"detail,omitempty"`
}

// Entry is one search of the history.
type Entry struct {
	ID        string
	Mode      Mode
	Query     string
	CreatedAt time.Time
	// The rest is an agent search's.
	FinishedAt       time.Time
	Status           Status
	Error            string
	Answer           string
	Hits             []Hit
	Steps            []Step
	ClaudeSessionID  string
	Model            string
	CostUSD          float64
	Duration         time.Duration
	Unseen           bool
	PromotedThreadID string
	// Version grows with every change (not stored: it restarts at 1 with the daemon).
	Version uint64
}

// Searches is how many searches the run made, ThreadsRead how many distinct threads it
// read.
func (e Entry) Searches() int {
	n := 0
	for _, s := range e.Steps {
		if s.Kind == StepSearch {
			n++
		}
	}
	return n
}

// ThreadsRead is how many distinct threads the run read.
func (e Entry) ThreadsRead() int {
	seen := map[string]bool{}
	for _, s := range e.Steps {
		if s.Kind == StepRead && s.ThreadID != "" {
			seen[s.ThreadID] = true
		}
	}
	return len(seen)
}

func (e Entry) clone() Entry {
	e.Hits = slices.Clone(e.Hits)
	e.Steps = slices.Clone(e.Steps)
	return e
}

// EventKind is what a Changed says.
type EventKind int

// Event kinds.
const (
	// EventEntry: the entry changed in a way only a whole snapshot says (added, a hit
	// opened, seen, promoted).
	EventEntry EventKind = iota
	EventStep
	EventHit
	EventAnswer
	// EventStatus: the run ended (Entry has the final fields).
	EventStatus
	// EventRemoved: the entry was forgotten.
	EventRemoved
)

// Changed is published on the bus after every change to an entry.
type Changed struct {
	ID      string
	Version uint64
	Kind    EventKind
	Step    Step
	Hit     Hit
	Answer  string
	// Entry is the entry after the change (EventEntry, EventStatus).
	Entry Entry
}

// Threads is what the store needs of the thread store (*thread.Manager).
type Threads interface {
	Snapshot() *thread.Snapshot
	VerifyQuote(ctx context.Context, threadID, item, quote string) (thread.QuotedItem, error)
	Create(ctx context.Context, opts thread.CreateOptions) (thread.Thread, error)
}

var _ Threads = (*thread.Manager)(nil)

// Options configures a Store. DB and Threads are required.
type Options struct {
	DB      *sql.DB
	Threads Threads
	Bus     *bus.Bus     // default: a private bus
	Log     *slog.Logger // default: slog.Default()
	// Claude is the claude executable. Default "claude".
	Claude string
	// ClaudeDir is Claude's config dir (projects/<slug>/<session>.jsonl): Forget deletes
	// a run's transcript under it. Default thread.DefaultClaudePaths().Dir.
	ClaudeDir string
	// Dir is the store's directory (paths.Search): cwd/ is every run's working directory,
	// tmp/<id> its TMPDIR. Required for agent searches.
	Dir string
	// Env entries ("KEY=VALUE") are added to every run's environment: the daemon's
	// loopback endpoint and token, so the CLI inside reaches it.
	Env []string
	// UtilityModel is the model a run uses, read at its start (models.utility). Default
	// thread.UtilityModel's default.
	UtilityModel func() string
	// ThreadDefaults are the user's default model and effort for a new thread, read at
	// Promote (threads.default_model, threads.default_effort).
	ThreadDefaults func() (model, effort string)
	Now            func() time.Time

	// Caps; zero is the package constant. For tests.
	WallTime     time.Duration
	WrapUpAfter  time.Duration
	MaxToolCalls int
	MaxHits      int
	MaxEntries   int
	// StartTimeout bounds claude's initialize handshake; default 30s.
	StartTimeout time.Duration
	// KillGrace is how long a stopped run's claude has after SIGTERM before SIGKILL;
	// default 2s.
	KillGrace time.Duration
}

// Store keeps the history and runs agent searches.
type Store struct {
	opts Options
	log  *slog.Logger

	mu      sync.Mutex
	entries map[string]*Entry
	runs    map[string]*run
	closed  bool
	wg      sync.WaitGroup
	// minimal: claude refused a hardened flag once; later runs leave them out.
	minimal bool
}

// New opens the store: it reads the history and ends any run a previous daemon left
// running (FAILED, "the daemon stopped").
func New(ctx context.Context, o Options) (*Store, error) {
	if o.DB == nil || o.Threads == nil {
		return nil, errors.New("search: DB and Threads are required")
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
	if o.ClaudeDir == "" {
		if p, err := thread.DefaultClaudePaths(); err == nil {
			o.ClaudeDir = p.Dir
		}
	}
	if o.UtilityModel == nil {
		o.UtilityModel = func() string { return thread.UtilityModel(context.Background()) }
	}
	if o.ThreadDefaults == nil {
		o.ThreadDefaults = func() (string, string) { return "", "" }
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	o.WallTime = cmpOr(o.WallTime, WallTime)
	o.WrapUpAfter = cmpOr(o.WrapUpAfter, WrapUpAfter)
	o.MaxToolCalls = cmpOr(o.MaxToolCalls, MaxToolCalls)
	o.MaxHits = cmpOr(o.MaxHits, MaxHits)
	o.MaxEntries = cmpOr(o.MaxEntries, MaxEntries)
	o.StartTimeout = cmpOr(o.StartTimeout, 30*time.Second)
	o.KillGrace = cmpOr(o.KillGrace, 2*time.Second)
	s := &Store{opts: o, log: o.Log, entries: map[string]*Entry{}, runs: map[string]*run{}}
	list, err := loadEntries(ctx, o.DB)
	if err != nil {
		return nil, err
	}
	now := o.Now()
	for i := range list {
		e := &list[i]
		e.Version = 1
		if e.Status == StatusRunning {
			e.Status, e.Error, e.FinishedAt, e.Unseen = StatusFailed, "the daemon stopped while it ran", now, true
			if err := saveEntry(ctx, o.DB, *e); err != nil {
				return nil, err
			}
		}
		s.entries[e.ID] = e
	}
	return s, nil
}

func cmpOr[T comparable](v, def T) T {
	var zero T
	if v == zero {
		return def
	}
	return v
}

// Close stops every running search (FAILED, "the daemon stopped") and waits for them.
func (s *Store) Close() {
	s.mu.Lock()
	s.closed = true
	runs := make([]*run, 0, len(s.runs))
	for _, r := range s.runs {
		runs = append(runs, r)
	}
	s.mu.Unlock()
	for _, r := range runs {
		r.requestStop(stopShutdown)
	}
	s.wg.Wait()
}

// List is the history, newest first, each hit with its thread's current name, and the
// hits whose thread is gone left out.
func (s *Store) List() []Entry {
	snap := s.opts.Threads.Snapshot()
	s.mu.Lock()
	out := make([]Entry, 0, len(s.entries))
	for _, e := range s.entries {
		out = append(out, e.clone())
	}
	s.mu.Unlock()
	slices.SortFunc(out, newestFirst)
	for i := range out {
		out[i].Hits = liveHits(snap, out[i].Hits)
	}
	return out
}

// Get is one entry as List has it.
func (s *Store) Get(id string) (Entry, error) {
	s.mu.Lock()
	e, ok := s.entries[id]
	var c Entry
	if ok {
		c = e.clone()
	}
	s.mu.Unlock()
	if !ok {
		return Entry{}, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	c.Hits = liveHits(s.opts.Threads.Snapshot(), c.Hits)
	return c, nil
}

func newestFirst(a, b Entry) int {
	if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
		return c
	}
	return strings.Compare(b.ID, a.ID)
}

// liveHits are hits whose thread still exists, with its name now.
func liveHits(snap *thread.Snapshot, hits []Hit) []Hit {
	out := make([]Hit, 0, len(hits))
	for _, h := range hits {
		t, ok := snap.Thread(h.ThreadID)
		if !ok {
			continue
		}
		h.ThreadName, h.Archived = t.Name, !t.ArchivedAt.IsZero()
		out = append(out, h)
	}
	return out
}

// RecordFind records a Find entry for query (the GUI's keyword mode, when the user
// opens a result). An earlier Find entry with the same query goes, so it moves to the
// top.
func (s *Store) RecordFind(ctx context.Context, query string) (Entry, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return Entry{}, fmt.Errorf("%w: a query is required", ErrInvalidArgument)
	}
	if strings.ContainsRune(query, 0) || utf8.RuneCountInString(query) > MaxQuestionRunes {
		return Entry{}, fmt.Errorf("%w: the query is too long or has a NUL", ErrInvalidArgument)
	}
	id, err := newID()
	if err != nil {
		return Entry{}, err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Entry{}, ErrClosed
	}
	var dup []string
	for _, e := range s.entries {
		if e.Mode == ModeFind && e.Query == query {
			dup = append(dup, e.ID)
		}
	}
	e := &Entry{ID: id, Mode: ModeFind, Query: query, CreatedAt: s.opts.Now().Truncate(time.Millisecond), Version: 1}
	if err := saveEntry(ctx, s.opts.DB, *e); err != nil {
		s.mu.Unlock()
		return Entry{}, err
	}
	s.entries[id] = e
	c := e.clone()
	s.mu.Unlock()
	for _, d := range dup {
		if err := s.Forget(ctx, d); err != nil {
			s.log.Warn("search: drop an earlier find entry", "id", d, "err", err)
		}
	}
	s.publish(Changed{ID: id, Version: c.Version, Kind: EventEntry, Entry: c})
	s.prune(ctx)
	return c, nil
}

// prune drops the oldest entries past MaxEntries; a running search is never dropped.
func (s *Store) prune(ctx context.Context) {
	s.mu.Lock()
	list := make([]Entry, 0, len(s.entries))
	for _, e := range s.entries {
		list = append(list, *e)
	}
	s.mu.Unlock()
	if len(list) <= s.opts.MaxEntries {
		return
	}
	slices.SortFunc(list, newestFirst)
	for _, e := range list[s.opts.MaxEntries:] {
		if e.Status == StatusRunning {
			continue
		}
		if err := s.Forget(ctx, e.ID); err != nil {
			s.log.Warn("search: drop an old entry", "id", e.ID, "err", err)
		}
	}
}

// Forget removes entry id. A running search is stopped first; an agent search's Claude
// transcript and scratch directory are deleted. Unknown is not an error.
func (s *Store) Forget(ctx context.Context, id string) error {
	s.mu.Lock()
	r := s.runs[id]
	s.mu.Unlock()
	if r != nil {
		r.requestStop(stopUser)
		select {
		case <-r.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	e, ok := s.entries[id]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	if err := deleteEntry(ctx, s.opts.DB, id); err != nil {
		s.mu.Unlock()
		return err
	}
	delete(s.entries, id)
	gone := *e
	s.mu.Unlock()
	s.removeFiles(gone)
	s.publish(Changed{ID: id, Kind: EventRemoved})
	return nil
}

// Clear forgets every entry and returns how many went.
func (s *Store) Clear(ctx context.Context) (int, error) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.entries))
	for id := range s.entries {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	n := 0
	for _, id := range ids {
		if err := s.Forget(ctx, id); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// removeFiles deletes what an agent search left on disk: its transcript (and the
// session's directory beside it) wherever Claude wrote it, and its TMPDIR.
func (s *Store) removeFiles(e Entry) {
	if e.Mode != ModeAgent {
		return
	}
	var paths []string
	if e.ClaudeSessionID != "" && s.opts.ClaudeDir != "" && !strings.ContainsAny(e.ClaudeSessionID, `/\*?[`) {
		for _, pat := range []string{e.ClaudeSessionID + ".jsonl", e.ClaudeSessionID} {
			m, _ := filepath.Glob(filepath.Join(s.opts.ClaudeDir, "projects", "*", pat))
			paths = append(paths, m...)
		}
	}
	if s.opts.Dir != "" {
		paths = append(paths, s.tmpDir(e.ID))
	}
	for _, p := range paths {
		if err := os.RemoveAll(p); err != nil {
			s.log.Warn("search: remove a run's file", "id", e.ID, "path", p, "err", err)
		}
	}
}

// update applies fn to entry id under the lock, persists it and bumps its version. It
// returns the entry after the change; ok is false when fn changed nothing or the entry
// is gone.
func (s *Store) update(ctx context.Context, id string, fn func(e *Entry) bool) (Entry, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[id]
	if !ok {
		return Entry{}, false, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	next := e.clone()
	if !fn(&next) {
		return e.clone(), false, nil
	}
	next.Version = e.Version + 1
	if err := saveEntry(ctx, s.opts.DB, next); err != nil {
		return Entry{}, false, err
	}
	*e = next
	return next.clone(), true, nil
}

func (s *Store) publish(c Changed) { bus.Publish(s.opts.Bus, c) }

// OpenHit marks hit n of entry id opened.
func (s *Store) OpenHit(ctx context.Context, id string, n int) (Entry, error) {
	e, changed, err := s.update(ctx, id, func(e *Entry) bool {
		for i := range e.Hits {
			if e.Hits[i].N == n {
				if e.Hits[i].Opened {
					return false
				}
				e.Hits[i].Opened = true
				return true
			}
		}
		return false
	})
	if err != nil {
		return Entry{}, err
	}
	if !slices.ContainsFunc(e.Hits, func(h Hit) bool { return h.N == n }) {
		return Entry{}, fmt.Errorf("%w: search %s has no hit %d", ErrNotFound, id, n)
	}
	if changed {
		s.publish(Changed{ID: id, Version: e.Version, Kind: EventEntry, Entry: e})
	}
	return s.Get(id)
}

// MarkSeen clears entry id's unseen flag.
func (s *Store) MarkSeen(ctx context.Context, id string) (Entry, error) {
	e, changed, err := s.update(ctx, id, func(e *Entry) bool {
		if !e.Unseen {
			return false
		}
		e.Unseen = false
		return true
	})
	if err != nil {
		return Entry{}, err
	}
	if changed {
		s.publish(Changed{ID: id, Version: e.Version, Kind: EventEntry, Entry: e})
	}
	return s.Get(id)
}

// newID is a search id: "q-" and 12 hex digits.
func newID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("search id: %w", err)
	}
	return "q-" + hex.EncodeToString(b[:]), nil
}

// newSessionID is a Claude session id (a version 4 UUID).
func newSessionID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("session id: %w", err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}
