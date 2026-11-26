package project

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// lazyFixture is a project whose worktrees cover every kind jobBaseCounts handles,
// registered, with one live worktree, and origin/main about to move by a commit that
// carries the squashed worktree's change (so that one lands by content).
type lazyFixture struct {
	f                                            fixture
	h                                            *harness
	id                                           string
	plain, ahead, squashed, detached, live, main string
}

func newLazyFixture(t *testing.T, opts Options) lazyFixture {
	t.Helper()
	f := newFixture(t)
	x := lazyFixture{f: f, main: f.project}
	add := func(name string, commit bool, args ...string) string {
		p := filepath.Join(f.base, name)
		git(t, f.project, append([]string{"worktree", "add", "-q"}, append(args, p, "main")...)...)
		if commit {
			writeFile(t, filepath.Join(p, name+".txt"), name+"\n")
			git(t, p, "add", ".")
			git(t, p, "commit", "-q", "-m", name)
		}
		return p
	}
	x.plain = add("plain", false, "-b", "plain")
	x.ahead = add("ahead", true, "-b", "ahead")
	x.squashed = add("squashed", true, "-b", "squashed")
	x.detached = add("detached", false, "--detach")
	x.live = add("live", true, "-b", "live")
	x.h = startHarness(t, "", opts)
	r, err := x.h.store.Register(context.Background(), f.project)
	if err != nil {
		t.Fatal(err)
	}
	x.id = r.ID
	x.h.settle()
	x.h.store.SetLiveWorktrees([]string{x.live})
	return x
}

// moveBase lands the squashed worktree's change on origin/main from the other clone,
// fetches it into the project, and lets the store see the fetch.
func (x lazyFixture) moveBase(t *testing.T, name string) {
	t.Helper()
	writeFile(t, filepath.Join(x.f.other, "squashed.txt"), "squashed\n")
	writeFile(t, filepath.Join(x.f.other, name), name+"\n")
	git(t, x.f.other, "add", ".")
	git(t, x.f.other, "commit", "-q", "-m", "squash-merge squashed, and "+name)
	git(t, x.f.other, "push", "-q")
	git(t, x.f.project, "fetch", "-q")
	x.h.fsChanged()
	x.h.settle()
}

func (x lazyFixture) worktree(t *testing.T, path string) Worktree {
	t.Helper()
	w, ok := x.h.store.Snapshot().Worktree(x.id, path)
	if !ok {
		t.Fatalf("no worktree %s", path)
	}
	return w
}

type baseFields struct {
	ref           string
	ahead, behind int
	merged        bool
}

func fieldsOf(w Worktree) baseFields {
	return baseFields{w.Status.BaseRef, w.Status.BaseAhead, w.Status.BaseBehind, w.Status.BaseMerged}
}

// TestLazyBaseCounts: when origin/main moves, only the active worktree runs git status;
// the others get their base comparison (branch, detached, main, diverged, landed by
// content) from one for-each-ref plus rev-list and merge checks where needed, the same
// values a full refresh computes, and the next status runs reuse them.
func TestLazyBaseCounts(t *testing.T) {
	dr := &dirRunner{next: ExecRunner{}, n: map[[2]string]int{}}
	x := newLazyFixture(t, Options{Runner: dr})
	sub := func(name string) int {
		dr.mu.Lock()
		defer dr.mu.Unlock()
		n := 0
		for k, v := range dr.n {
			if k[0] == name {
				n += v
			}
		}
		return n
	}
	statusBefore, ferBefore := sub("status"), sub("for-each-ref")
	x.moveBase(t, "moved.txt")

	if got := sub("status") - statusBefore; got != 1 || dr.count("status", x.live) < 1 {
		t.Fatalf("base move ran status %d times (live: %d), want once, for the live worktree", got, dr.count("status", x.live))
	}
	if got := sub("for-each-ref") - ferBefore; got != 1 {
		t.Fatalf("base move ran for-each-ref %d times, want 1", got)
	}
	want := map[string]baseFields{
		x.main:     {"origin/main", 0, 1, false},
		x.plain:    {"origin/main", 0, 1, false},
		x.detached: {"origin/main", 0, 1, false},
		x.ahead:    {"origin/main", 1, 1, false},
		x.squashed: {"origin/main", 1, 1, true},
		x.live:     {"origin/main", 1, 1, false},
	}
	lazy := map[string]Worktree{}
	for p, wf := range want {
		w := x.worktree(t, p)
		if got := fieldsOf(w); got != wf {
			t.Errorf("%s: base %+v, want %+v", filepath.Base(p), got, wf)
		}
		lazy[p] = w
	}
	if w := lazy[x.main]; w.Status.Upstream != "origin/main" || w.Status.Ahead != 0 || w.Status.Behind != 1 {
		t.Errorf("main tracks origin/main: upstream counts not moved with the base: %+v", w.Status)
	}
	if w := lazy[x.squashed]; !w.Landed() {
		t.Errorf("squashed worktree not landed: %+v", w.Status)
	}

	// A full refresh agrees, and its status runs reuse the stored comparisons.
	revList, mergeTree := sub("rev-list"), sub("merge-tree")
	if err := x.h.store.Refresh(context.Background(), x.id); err != nil {
		t.Fatal(err)
	}
	for p := range want {
		if got, w := x.worktree(t, p).Status, lazy[p].Status; !got.equalIgnoringTime(w) {
			t.Errorf("%s: refresh computed %+v, lazy published %+v", filepath.Base(p), got, w)
		}
	}
	if n, m := sub("rev-list")-revList, sub("merge-tree")-mergeTree; n != 0 || m != 0 {
		t.Errorf("refresh after the lazy counts ran rev-list %d and merge-tree %d times, want 0", n, m)
	}

	// Nothing to do once every comparison is current; a recomputed comparison that
	// did not change publishes nothing.
	g := x.h.store
	total := func() int {
		dr.mu.Lock()
		defer dr.mu.Unlock()
		n := 0
		for _, v := range dr.n {
			n += v
		}
		return n
	}
	cmds := total()
	if err := g.sched.wait(context.Background(), jobKey{kind: jobBaseCounts, projectID: x.id}); err != nil {
		t.Fatal(err)
	}
	if n := total() - cmds; n != 0 {
		t.Fatalf("jobBaseCounts with current comparisons ran %d git commands", n)
	}
	g.slot(x.id, x.plain).base.Store(nil)
	drainEvents(x.h)
	if err := g.sched.wait(context.Background(), jobKey{kind: jobBaseCounts, projectID: x.id}); err != nil {
		t.Fatal(err)
	}
	if evs := drainEvents(x.h); len(evs) != 0 {
		t.Fatalf("an unchanged comparison published %v", evs)
	}
}

// drainEvents returns the events published so far.
func drainEvents(h *harness) []Event {
	var evs []Event
	for {
		select {
		case ev := <-h.sub.C():
			evs = append(evs, ev)
		default:
			return evs
		}
	}
}

// noAheadBehindRunner is a git before 2.41: for-each-ref rejects %(ahead-behind:).
type noAheadBehindRunner struct {
	next     Runner
	rejected atomic.Int32
}

func (r *noAheadBehindRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if args[0] == "for-each-ref" && slices.ContainsFunc(args, func(a string) bool { return strings.Contains(a, "%(ahead-behind:") }) {
		r.rejected.Add(1)
		return nil, &GitError{Dir: dir, Args: args, ExitCode: 128, Stderr: "fatal: unknown field name: ahead-behind:abc"}
	}
	return r.next.Run(ctx, dir, args...)
}

// TestLazyBaseCountsOldGit: without %(ahead-behind:) the counts come from rev-list per
// worktree, still without git status, and the batch is not tried again.
func TestLazyBaseCountsOldGit(t *testing.T) {
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	nr := &noAheadBehindRunner{next: cr}
	x := newLazyFixture(t, Options{Runner: nr})
	status, revList := cr.count("status"), cr.count("rev-list")
	x.moveBase(t, "one.txt")
	if got := cr.count("status") - status; got != 1 {
		t.Fatalf("base move ran status %d times, want 1 (the live worktree)", got)
	}
	// Each of the five inactive worktrees, and the live one's status.
	if got := cr.count("rev-list") - revList; got != 6 {
		t.Fatalf("base move ran rev-list %d times, want 6", got)
	}
	if !x.h.store.aheadBehindUnsupported.Load() || nr.rejected.Load() != 1 {
		t.Fatalf("unsupported %v after %d rejections", x.h.store.aheadBehindUnsupported.Load(), nr.rejected.Load())
	}
	if got := fieldsOf(x.worktree(t, x.squashed)); got != (baseFields{"origin/main", 1, 1, true}) {
		t.Fatalf("squashed: %+v", got)
	}
	x.moveBase(t, "two.txt")
	if nr.rejected.Load() != 1 {
		t.Fatal("for-each-ref with ahead-behind was tried again")
	}
	if got := fieldsOf(x.worktree(t, x.plain)); got != (baseFields{"origin/main", 0, 2, false}) {
		t.Fatalf("plain after two moves: %+v", got)
	}
}

// TestLazyBaseCountsBusySlot: a worktree whose status job holds its slot when the
// batch reaches it gets a status run instead, and ends with the right comparison.
func TestLazyBaseCountsBusySlot(t *testing.T) {
	dr := &dirRunner{next: ExecRunner{}, n: map[[2]string]int{}}
	x := newLazyFixture(t, Options{Runner: dr})
	g := x.h.store
	slot := g.slot(x.id, x.plain)
	slot.mu.Lock() // as a running status job does
	status := dr.count("status", x.plain)
	writeFile(t, filepath.Join(x.f.other, "moved.txt"), "moved\n")
	git(t, x.f.other, "add", ".")
	git(t, x.f.other, "commit", "-q", "-m", "moved")
	git(t, x.f.other, "push", "-q")
	git(t, x.f.project, "fetch", "-q")
	x.h.fsChanged()
	k := jobKey{kind: jobStatus, projectID: x.id, path: x.plain}
	eventually(t, "a status request for the busy worktree", 10*time.Second, func() bool {
		g.sched.mu.Lock()
		defer g.sched.mu.Unlock()
		st := g.sched.jobs[k]
		return st != nil && (st.queued || st.running)
	})
	slot.mu.Unlock()
	x.h.settle()
	if n := dr.count("status", x.plain) - status; n != 1 {
		t.Fatalf("busy worktree ran status %d times, want 1", n)
	}
	if got := fieldsOf(x.worktree(t, x.plain)); got != (baseFields{"origin/main", 0, 1, false}) {
		t.Fatalf("busy worktree: %+v", got)
	}
}

func TestParseAheadBehind(t *testing.T) {
	out := []byte("refs/heads/a\x00aaa\x002 3\nrefs/heads/b/c\x00bbb\x000 0\n")
	got, err := parseAheadBehind(out)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]refCount{"refs/heads/a": {"aaa", 2, 3}, "refs/heads/b/c": {"bbb", 0, 0}}
	if len(got) != len(want) || got["refs/heads/a"] != want["refs/heads/a"] || got["refs/heads/b/c"] != want["refs/heads/b/c"] {
		t.Fatalf("parseAheadBehind = %v, want %v", got, want)
	}
	for _, bad := range []string{"refs/heads/a\x00aaa\n", "refs/heads/a\x00aaa\x002\n"} {
		if _, err := parseAheadBehind([]byte(bad)); err == nil {
			t.Errorf("parseAheadBehind(%q) succeeded", bad)
		}
	}
}

// failStatusRunner fails `git status` in one directory while fail is set.
type failStatusRunner struct {
	next Runner
	dir  string
	fail atomic.Bool
}

func (r *failStatusRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if args[0] == "status" && dir == r.dir && r.fail.Load() {
		return nil, &GitError{Dir: dir, Args: args, ExitCode: 128, Stderr: "fatal: Unable to create index.lock: File exists"}
	}
	return r.next.Run(ctx, dir, args...)
}

// TestLazyBaseCountsRetriesFailedStatus: a worktree whose last status failed has no
// comparison to update, so a base move retries its status (as when a base move
// refreshed every status) instead of leaving the error up until the next poll.
func TestLazyBaseCountsRetriesFailedStatus(t *testing.T) {
	dr := &dirRunner{next: ExecRunner{}, n: map[[2]string]int{}}
	fr := &failStatusRunner{next: dr}
	x := newLazyFixture(t, Options{Runner: fr})
	fr.dir = x.plain
	fr.fail.Store(true)
	x.h.store.TouchNow(x.plain)
	x.h.settle()
	if w := x.worktree(t, x.plain); w.Status.Error == "" {
		t.Fatalf("the failing status was not recorded: %+v", w.Status)
	}
	fr.fail.Store(false)
	plain, ahead := dr.count("status", x.plain), dr.count("status", x.ahead)
	x.moveBase(t, "moved.txt")
	if n := dr.count("status", x.plain) - plain; n != 1 {
		t.Fatalf("the failed worktree ran status %d times on the base move, want 1", n)
	}
	if n := dr.count("status", x.ahead) - ahead; n != 0 {
		t.Fatalf("an idle worktree with a good status ran status %d times, want 0", n)
	}
	if w := x.worktree(t, x.plain); w.Status.Error != "" || fieldsOf(w) != (baseFields{"origin/main", 0, 1, false}) {
		t.Fatalf("the failed worktree after the base move: %+v", w.Status)
	}
}
