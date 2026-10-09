// Package gitopstest provides an in-memory gitops.Store for tests of code that consumes
// the gitops store (API handlers, EventService).
package gitopstest

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
)

// Fake is an in-memory gitops.Store. Every call finishes immediately: it publishes
// Started and Finished on the bus it was given (if any) and returns an op that succeeds
// with summary "<kind> ok", unless Fail is set.
type Fake struct {
	bus *bus.Bus

	mu   sync.Mutex
	seq  int
	snap gitops.Snapshot

	// Err, when set, is returned by every operation method (a bad request).
	Err error
	// Fail, when set, makes every op finish FAILED with this summary.
	Fail string
	// URL is set on every op's URL.
	URL string
	// Slugs maps a repo id or worktree path to its GitHub slug for GitHubSlug.
	Slugs map[string]string
	// LocalOnlyRepos holds the repo ids and worktree paths LocalOnly reports true for.
	LocalOnlyRepos map[string]bool
	// Calls records calls, e.g. "Push /w force=true".
	Calls []string
}

var _ gitops.Store = (*Fake)(nil)

// New returns a fake publishing to b (which may be nil).
func New(b *bus.Bus) *Fake {
	return &Fake{bus: b, Slugs: map[string]string{}, LocalOnlyRepos: map[string]bool{}}
}

// Snapshot implements gitops.Store.
func (f *Fake) Snapshot() *gitops.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := gitops.Snapshot{Ops: append([]gitops.Op(nil), f.snap.Ops...)}
	return &s
}

// Put replaces the snapshot (no event is published).
func (f *Fake) Put(ops ...gitops.Op) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.snap.Ops = append([]gitops.Op(nil), ops...)
}

// Publish publishes ev as the real store would.
func (f *Fake) Publish(ev gitops.Event) {
	if f.bus != nil {
		bus.Publish(f.bus, ev)
	}
}

func (f *Fake) do(kind gitops.Kind, path, call string) (gitops.Op, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, call)
	if f.Err != nil {
		err := f.Err
		f.mu.Unlock()
		return gitops.Op{}, err
	}
	f.seq++
	now := time.Unix(1_700_000_000, 0)
	op := gitops.Op{
		ID: fmt.Sprintf("op-%d", f.seq), Kind: kind, State: gitops.StateRunning,
		Title: kind.String() + " " + path, WorktreePath: path, QueuedAt: now, StartedAt: now,
	}
	f.mu.Unlock()
	f.Publish(gitops.Event{Type: gitops.Started, Op: op})

	op.FinishedAt, op.Duration = now.Add(time.Second), time.Second
	op.State, op.Summary, op.URL = gitops.StateSucceeded, kind.String()+" ok", f.URL
	op.Output = "$ " + call + "\n"
	if f.Fail != "" {
		op.State, op.Summary = gitops.StateFailed, f.Fail
	}
	f.mu.Lock()
	f.snap.Ops = append([]gitops.Op{op}, f.snap.Ops...)
	f.mu.Unlock()
	f.Publish(gitops.Event{Type: gitops.Finished, Op: op})
	return op, nil
}

// Fetch implements gitops.Store.
func (f *Fake) Fetch(_ context.Context, o gitops.FetchOptions) (gitops.Op, error) {
	call := "Fetch " + o.WorktreePath
	if o.Remote != "" || o.Branch != "" {
		call += fmt.Sprintf(" remote=%q branch=%q", o.Remote, o.Branch)
	}
	return f.do(gitops.KindFetch, o.WorktreePath, call)
}

// Pull implements gitops.Store.
func (f *Fake) Pull(_ context.Context, o gitops.PullOptions) (gitops.Op, error) {
	return f.do(gitops.KindPull, o.WorktreePath, fmt.Sprintf("Pull %s rebase=%v", o.WorktreePath, o.Rebase))
}

// Push implements gitops.Store.
func (f *Fake) Push(_ context.Context, o gitops.PushOptions) (gitops.Op, error) {
	return f.do(gitops.KindPush, o.WorktreePath, fmt.Sprintf("Push %s force=%v", o.WorktreePath, o.ForceWithLease))
}

// CreatePR implements gitops.Store.
func (f *Fake) CreatePR(_ context.Context, o gitops.CreatePROptions) (gitops.Op, error) {
	return f.do(gitops.KindPRCreate, o.WorktreePath, fmt.Sprintf("CreatePR %s title=%q body=%q draft=%v base=%q", o.WorktreePath, o.Title, o.Body, o.Draft, o.Base))
}

// OpenPR implements gitops.Store.
func (f *Fake) OpenPR(_ context.Context, path string) (gitops.Op, error) {
	return f.do(gitops.KindPROpen, path, "OpenPR "+path)
}

// OpenEditor implements gitops.Store.
func (f *Fake) OpenEditor(_ context.Context, path string) (gitops.Op, error) {
	return f.do(gitops.KindOpenEditor, path, "OpenEditor "+path)
}

// Reveal implements gitops.Store.
func (f *Fake) Reveal(_ context.Context, path string) (gitops.Op, error) {
	return f.do(gitops.KindReveal, path, "Reveal "+path)
}

// OpenURL implements gitops.Store.
func (f *Fake) OpenURL(_ context.Context, url string) (gitops.Op, error) {
	return f.do(gitops.KindOpenURL, "", "OpenURL "+url)
}

// GitHubSlug implements gitops.Store: Slugs[worktreePath], else Slugs[repoID].
func (f *Fake) GitHubSlug(repoID, worktreePath string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.Slugs[worktreePath]; ok && worktreePath != "" {
		return s
	}
	return f.Slugs[repoID]
}

// LocalOnly implements gitops.Store: LocalOnlyRepos[worktreePath], else
// LocalOnlyRepos[repoID].
func (f *Fake) LocalOnly(repoID, worktreePath string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if worktreePath != "" && f.LocalOnlyRepos[worktreePath] {
		return true
	}
	return f.LocalOnlyRepos[repoID]
}
