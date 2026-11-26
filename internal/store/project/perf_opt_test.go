package project

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// CreateWorktree registers the new worktree directly and waits only for that new
// worktree's status instead of refreshing every existing worktree in the project.
func TestCreateWorktreeFastPath(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: fmt.Sprintf("wt-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	beforeStatus := cr.count("status")
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "wt-fast"})
	if err != nil {
		t.Fatal(err)
	}
	if !w.Managed || w.Status.RefreshedAt.IsZero() || w.Status.BaseRef != "origin/main" {
		t.Fatalf("created worktree = %+v", w)
	}
	if got := cr.count("status") - beforeStatus; got != 1 {
		t.Fatalf("CreateWorktree ran git status %d times across 7 worktrees, want 1", got)
	}
}

// resolveBase skips fanning out jobStatus when the resolved base SHA is unchanged,
// except for worktrees that have never completed a status refresh yet.
func TestResolveBaseUnchangedSkipsStatusFanout(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: fmt.Sprintf("b-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	before := cr.count("status")
	if err := h.store.sched.wait(ctx, jobKey{kind: jobBase, projectID: r.ID}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if got := cr.count("status") - before; got != 0 {
		t.Fatalf("unchanged resolveBase triggered %d status runs, want 0", got)
	}

	// Once origin/main moves, every worktree's base comparison follows; none is active,
	// so jobBaseCounts does it without a status (project-lazy-base-counts.md).
	writeFile(t, filepath.Join(f.other, "next.txt"), "n\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "next")
	git(t, f.other, "push", "-q")
	git(t, f.project, "fetch", "-q")

	if err := h.store.sched.wait(ctx, jobKey{kind: jobBase, projectID: r.ID}); err != nil {
		t.Fatal(err)
	}
	h.settle()
	if got := cr.count("status") - before; got != 0 {
		t.Fatalf("base change ran status %d times for idle worktrees, want 0", got)
	}
	for _, w := range h.store.Snapshot().Projects[0].Worktrees {
		if w.Status.BaseBehind != 1 {
			t.Fatalf("%s after the base moved: %+v", w.Path, w.Status)
		}
	}
}

// A store-initiated fetch coalesces with the FSEvents FETCH_HEAD and remote-ref events
// it causes: a no-op fetch runs zero reconciles and zero status jobs; a fetch that
// moves origin/main runs one status pass without reconciling.
func TestFetchCoalescesWatcherBurst(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	for i := range 4 {
		if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: fmt.Sprintf("f-%d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	h.fsChanged() // flush setup changes into fakeStream baseline
	time.Sleep(200 * time.Millisecond)

	// No-op fetch: 0 reconciles, 0 status runs.
	beforeStatus, beforeWT := cr.count("status"), cr.count("worktree")
	h.store.fetch(ctx, r.ID)
	h.fsChanged()
	time.Sleep(200 * time.Millisecond)
	if got := cr.count("worktree") - beforeWT; got != 0 {
		t.Fatalf("no-op fetch triggered %d reconciles, want 0", got)
	}
	if got := cr.count("status") - beforeStatus; got != 0 {
		t.Fatalf("no-op fetch triggered %d status runs, want 0", got)
	}

	// Remote moves: 0 reconciles; the 5 idle worktrees' base comparisons follow with
	// no status (one for-each-ref).
	writeFile(t, filepath.Join(f.other, "moved.txt"), "m\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "moved")
	git(t, f.other, "push", "-q")

	beforeStatus, beforeWT = cr.count("status"), cr.count("worktree")
	h.store.fetch(ctx, r.ID)
	beforeFER := cr.count("for-each-ref")
	h.fsChanged()
	eventually(t, "moved fetch updates all 5 worktrees", 5*time.Second, func() bool {
		for _, w := range h.store.Snapshot().Projects[0].Worktrees {
			if w.Status.BaseBehind != 1 {
				return false
			}
		}
		return true
	})
	h.settle()
	if got := cr.count("worktree") - beforeWT; got != 0 {
		t.Fatalf("moved fetch triggered %d reconciles, want 0", got)
	}
	if got, fer := cr.count("status")-beforeStatus, cr.count("for-each-ref")-beforeFER; got != 0 || fer != 1 {
		t.Fatalf("moved fetch ran status %d and for-each-ref %d times, want 0 and 1", got, fer)
	}
}

// mergedByContent skips the main worktree (never a cleanup/leftover candidate) while
// still evaluating non-main worktrees (including dirty and unmanaged worktrees so
// Landed() stays accurate for "Worktrees without threads"), and memoizes per (head, base).
func TestMergedByContentSkipsMainAndMemoizes(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	unmanaged := filepath.Join(f.base, "unmanaged")
	git(t, f.project, "worktree", "add", "-q", "-b", "unmanaged", unmanaged, "main")
	managedDirty, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "managed-dirty"})
	if err != nil {
		t.Fatal(err)
	}
	managedClean, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "managed-clean"})
	if err != nil {
		t.Fatal(err)
	}

	// Commit on each so all 4 are ahead; squash-merge managed-dirty into main so its
	// BaseMerged / Landed reports true even while dirty.
	for _, pair := range [][2]string{
		{unmanaged, "unmanaged.txt"},
		{managedDirty.Path, "dirty.txt"},
		{managedClean.Path, "clean.txt"},
	} {
		writeFile(t, filepath.Join(pair[0], pair[1]), pair[1]+"\n")
		git(t, pair[0], "add", ".")
		git(t, pair[0], "commit", "-q", "-m", pair[1])
	}
	git(t, f.project, "merge", "-q", "--squash", "managed-dirty")
	git(t, f.project, "commit", "-q", "-m", "squash managed-dirty")
	git(t, f.project, "push", "-q", "origin", "main")
	writeFile(t, filepath.Join(f.project, "local-main.txt"), "m\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "local main ahead")
	git(t, f.other, "pull", "-q")
	writeFile(t, filepath.Join(f.other, "r.txt"), "r\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "r")
	git(t, f.other, "push", "-q")
	git(t, f.project, "fetch", "-q")

	wip := filepath.Join(managedDirty.Path, "wip.txt")
	writeFile(t, wip, "wip\n")

	beforeMT := cr.count("merge-tree")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	// 3 non-main diverged worktrees run merge-tree; main is skipped.
	if got := cr.count("merge-tree") - beforeMT; got != 3 {
		t.Fatalf("merge-tree ran %d times across (main, unmanaged, managed-dirty, managed-clean), want 3 (main skipped)", got)
	}
	wtDirty, _ := h.store.Snapshot().Worktree(r.ID, managedDirty.Path)
	if !wtDirty.Status.BaseMerged || !wtDirty.Landed() {
		t.Fatalf("dirty squash-merged worktree: BaseMerged=%v Landed=%v; want true", wtDirty.Status.BaseMerged, wtDirty.Landed())
	}

	// Cleaning at the exact same (HEAD, base) reuses the memo with 0 rev-list and 0 merge-tree.
	if err := os.Remove(wip); err != nil {
		t.Fatal(err)
	}
	beforeMT, beforeRL := cr.count("merge-tree"), cr.count("rev-list")
	if err := h.store.sched.wait(ctx, jobKey{kind: jobStatus, projectID: r.ID, path: managedDirty.Path}); err != nil {
		t.Fatal(err)
	}
	if got := cr.count("rev-list") - beforeRL; got != 0 {
		t.Fatalf("dirty->clean transition re-ran rev-list %d times, want 0", got)
	}
	if got := cr.count("merge-tree") - beforeMT; got != 0 {
		t.Fatalf("dirty->clean transition re-ran merge-tree %d times, want 0 (memoized)", got)
	}
}

// A reconcile whose `git worktree list` ran before CreateWorktree's `git worktree add`
// must not delete the newly registered worktree slot when it acquires g.mu afterwards.
func TestCreateWorktreeSurvivesInFlightReconcile(t *testing.T) {
	f := newFixture(t)
	listed := make(chan struct{}, 1)
	release := make(chan struct{})
	var hold atomic.Bool
	hook := &hookRunner{
		next: ExecRunner{},
		after: func(args []string) {
			if hold.Load() && len(args) >= 2 && args[0] == "worktree" && args[1] == "list" {
				hold.Store(false)
				select {
				case listed <- struct{}{}:
				default:
				}
				<-release
			}
		},
	}
	h := startHarness(t, "", Options{Runner: hook, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}

	// Start a reconcile and pause it right after `git worktree list` returns (before it locks g.mu).
	hold.Store(true)
	reconcileDone := make(chan struct{})
	go func() {
		defer close(reconcileDone)
		h.store.reconcile(ctx, r.ID)
	}()
	<-listed

	// Create a new worktree while that stale reconcile is paused.
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/raced"})
	if err != nil {
		close(release)
		t.Fatalf("CreateWorktree: %v", err)
	}

	// Let the stale reconcile finish its locked section.
	close(release)
	<-reconcileDone

	if _, ok := h.store.Snapshot().Worktree(r.ID, wt.Path); !ok {
		t.Fatalf("stale reconcile deleted newly created worktree %s from snapshot", wt.Path)
	}
}

type hookRunner struct {
	next  Runner
	after func(args []string)
}

func (h *hookRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, err := h.next.Run(ctx, dir, args...)
	if h.after != nil {
		h.after(args)
	}
	return out, err
}

// A non-default remote ref moving (e.g. pushing a feature branch) refreshes only the
// worktree tracking/on that branch, not unrelated worktrees.
func TestRemoteFeatureRefUpdatesOnlyMatchingWorktree(t *testing.T) {
	f := newFixture(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	feat, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "other-branch"}); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(feat.Path, "f.txt"), "1\n")
	git(t, feat.Path, "add", ".")
	git(t, feat.Path, "commit", "-q", "-m", "f1")
	git(t, feat.Path, "push", "-q", "-u", "origin", "feat")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	// Make a second commit on feat so it is 1 ahead of origin/feat, then settle.
	writeFile(t, filepath.Join(feat.Path, "f.txt"), "2\n")
	git(t, feat.Path, "add", ".")
	git(t, feat.Path, "commit", "-q", "-m", "f2")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h.fsChanged() // flush setup changes into fakeStream baseline
	time.Sleep(200 * time.Millisecond)

	// Push feat: only refs/remotes/origin/feat changes (origin/main is unchanged).
	before := cr.count("status")
	git(t, feat.Path, "push", "-q", "origin", "feat")
	h.fsChanged()
	h.waitFor("feat ahead cleared after push", worktreeUpdated(feat.Path, func(w Worktree) bool { return w.Status.Ahead == 0 }))
	time.Sleep(150 * time.Millisecond)
	if got := cr.count("status") - before; got != 1 {
		t.Fatalf("pushing feature branch ran status %d times across 3 worktrees, want 1", got)
	}
}
