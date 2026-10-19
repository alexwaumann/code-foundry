package thread

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Removed threads (docs/notes/removed-thread-signal.md). Remove forgets a thread, but an
// agent that created it, waits on it or is subscribed to it should learn that the user
// removed it, not see "not found" as for a typo. So Remove keeps a tombstone, in memory
// for RemovedTTL (a daemon restart forgets them, like the wake limit): ids and names,
// the creator, the labels, the last report and when. A lookup of the id is then a
// *RemovedError (it wraps ErrNotFound), the Wait RPC answers "removed", a removal fires
// a CondRemoved wake (subscriptions_removed.go), and thread.reports --all lists them.
//
// While Remove closes the thread its record carries Thread.Removing: the thread meets no
// condition then (Meets), so neither a wait nor a wake mistakes the closing snapshot
// for a thread that settled.

// RemovedTTL is how long a removed thread is remembered.
const RemovedTTL = 24 * time.Hour

// RemovedThread is what the store keeps of a removed thread. Values; never mutate one
// returned.
type RemovedThread struct {
	ID, Name    string
	ProjectID   string
	WorkspaceID string
	// CreatedBy is the creator's id ("" for the user); Owner the owner (owner.go).
	CreatedBy string
	Owner     string
	Labels    []string
	// CreatedAt is when the thread was created: its place among its siblings in a
	// subtree it is no longer listed in (lineage.go).
	CreatedAt time.Time
	// Report is the thread's last report; the zero value when it never reported.
	Report    Report
	RemovedAt time.Time
	// Usage and BudgetUSD are the thread's at removal, so what it cost is still known
	// (E4 4.6: an orchestrator's cost table undercounted a removed child). Usage is
	// shared with the thread's last snapshot (copy on write, never mutated).
	Usage     []UsageBucket
	BudgetUSD float64
}

// removedThread is the tombstone of t, removed at.
func removedThread(t Thread, at time.Time) RemovedThread {
	return RemovedThread{
		ID: t.ID, Name: t.Name, ProjectID: t.ProjectID, WorkspaceID: t.WorkspaceID, CreatedBy: t.CreatedBy, Owner: t.Owner,
		Labels: slices.Clone(t.Labels), CreatedAt: t.CreatedAt, Report: t.Report, RemovedAt: at, Usage: t.Usage, BudgetUSD: t.BudgetUSD,
	}
}

// TombstoneOf is the tombstone Remove keeps of t, removed at; fake stores keep the same.
func TombstoneOf(t Thread, at time.Time) RemovedThread { return removedThread(t, at) }

// Label is how messages name r: `"Fix the login" (s-1)`, or its id when unnamed.
func (r RemovedThread) Label() string {
	if r.Name == "" {
		return r.ID
	}
	return strconv.Quote(r.Name) + " (" + r.ID + ")"
}

// RemovedError is the error of a look-up of a thread removed within RemovedTTL. It is
// ErrNotFound (errors.Is) with what is known of the thread.
type RemovedError struct{ Thread RemovedThread }

func (e *RemovedError) Error() string {
	return "thread " + e.Thread.Label() + " was removed at " + e.Thread.RemovedAt.Local().Format("2006-01-02 15:04:05")
}

// Unwrap makes a RemovedError ErrNotFound.
func (e *RemovedError) Unwrap() error { return ErrNotFound }

// tombstones are the removed threads, by id. The zero value is ready. Its lock is a
// leaf: it may be taken under m.mu.
type tombstones struct {
	mu   sync.Mutex
	byID map[string]RemovedThread
}

// add keeps r and drops the tombstones older than RemovedTTL.
func (t *tombstones) add(r RemovedThread) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(r.RemovedAt)
	if t.byID == nil {
		t.byID = map[string]RemovedThread{}
	}
	t.byID[r.ID] = r
}

// get returns id's tombstone when it is younger than RemovedTTL at now.
func (t *tombstones) get(id string, now time.Time) (RemovedThread, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	r, ok := t.byID[id]
	if !ok || now.Sub(r.RemovedAt) >= RemovedTTL {
		return RemovedThread{}, false
	}
	return r, true
}

// list returns the tombstones younger than RemovedTTL at now.
func (t *tombstones) list(now time.Time) []RemovedThread {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pruneLocked(now)
	out := make([]RemovedThread, 0, len(t.byID))
	for _, r := range t.byID {
		out = append(out, r)
	}
	return out
}

func (t *tombstones) pruneLocked(now time.Time) {
	for id, r := range t.byID {
		if now.Sub(r.RemovedAt) >= RemovedTTL {
			delete(t.byID, id)
		}
	}
}

// notFound is the error for a thread id that is not in the store: a *RemovedError when
// it was removed within RemovedTTL, else ErrNotFound.
func (m *Manager) notFound(id string) error {
	if r, ok := m.removed.get(id, m.opts.Now()); ok {
		return &RemovedError{Thread: r}
	}
	return fmt.Errorf("%w: %s", ErrNotFound, id)
}

// Removed returns what is kept of thread id when it was removed within RemovedTTL.
func (m *Manager) Removed(id string) (RemovedThread, bool) {
	return m.removed.get(id, m.opts.Now())
}

// ListRemoved returns the threads removed within RemovedTTL that o selects
// (FilterRemoved), resolving its Project and Workspace like List.
func (m *Manager) ListRemoved(_ context.Context, o ListOptions) ([]RemovedThread, error) {
	o, err := m.resolveListRefs(o)
	if err != nil {
		return nil, err
	}
	return FilterRemoved(m.removed.list(m.opts.Now()), o), nil
}

// FilterRemoved returns the removed threads o selects, the most recently removed first,
// at most o.Limit of them. A removed thread has no status or state: o.Status or o.State
// leaves every one out, and so does o.DescendantsOf (a subtree lists live threads
// only). Archived or not does not apply.
func FilterRemoved(removed []RemovedThread, o ListOptions) []RemovedThread {
	if o.Status != StatusUnknown || o.State != StateUnspecified || o.DescendantsOf != "" {
		return nil
	}
	o.IncludeArchived = true
	var out []RemovedThread
	for _, r := range removed {
		if o.matches(Thread{ID: r.ID, ProjectID: r.ProjectID, WorkspaceID: r.WorkspaceID, CreatedBy: r.CreatedBy, Owner: r.Owner, Labels: r.Labels}) {
			out = append(out, r)
		}
	}
	slices.SortFunc(out, func(a, b RemovedThread) int {
		return cmp.Or(b.RemovedAt.Compare(a.RemovedAt), strings.Compare(a.ID, b.ID))
	})
	if o.Limit > 0 && len(out) > o.Limit {
		out = out[:o.Limit]
	}
	return out
}
