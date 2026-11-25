package project

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

	// Once origin/main moves, resolveBase fans out status to all 5 worktrees.
	writeFile(t, filepath.Join(f.other, "next.txt"), "n\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "next")
	git(t, f.other, "push", "-q")
	git(t, f.project, "fetch", "-q")

	if err := h.store.sched.wait(ctx, jobKey{kind: jobBase, projectID: r.ID}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "base change fans out status to all 5 worktrees", 5*time.Second, func() bool {
		return cr.count("status")-before == 5
	})
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

	// Remote moves: 0 reconciles, 1 status pass across all 5 worktrees.
	writeFile(t, filepath.Join(f.other, "moved.txt"), "m\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "moved")
	git(t, f.other, "push", "-q")

	beforeStatus, beforeWT = cr.count("status"), cr.count("worktree")
	h.store.fetch(ctx, r.ID)
	h.fsChanged()
	eventually(t, "moved fetch updates all 5 worktrees", 5*time.Second, func() bool {
		return cr.count("status")-beforeStatus == 5
	})
	time.Sleep(200 * time.Millisecond)
	if got := cr.count("worktree") - beforeWT; got != 0 {
		t.Fatalf("moved fetch triggered %d reconciles, want 0", got)
	}
	if got := cr.count("status") - beforeStatus; got != 5 {
		t.Fatalf("moved fetch ran status %d times, want 5 (1 pass)", got)
	}
}

// mergedByContent runs automatically during status refreshes only for managed,
// non-main, clean worktrees. When a dirty squash-merged managed worktree becomes clean
// at the same (HEAD, base), it evaluates mergedByContent without re-running rev-list.
func TestMergedByContentGuardAndDirtyToCleanTransition(t *testing.T) {
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

	// Commit on each so all 4 are ahead; squash-merge managed-dirty into main so once
	// cleaned its BaseMerged must flip to true.
	for _, pair := range [][2]string{
		{unmanaged, "unmanaged.txt"},
		{managedDirty.Path, "dirty.txt"},
		{managedClean.Path, "clean.txt"},
	} {
		writeFile(t, filepath.Join(pair[0], pair[1]), pair[1]+"\n")
		git(t, pair[0], "add", ".")
		git(t, pair[0], "commit", "-q", "-m", pair[1])
	}
	// Make origin/main move on with a squash of managed-dirty, while main also diverges locally.
	git(t, f.project, "merge", "-q", "--squash", "managed-dirty")
	git(t, f.project, "commit", "-q", "-m", "squash managed-dirty")
	git(t, f.project, "push", "-q", "origin", "main")
	writeFile(t, filepath.Join(f.project, "local-main.txt"), "m\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "local main ahead")
	// Remote moves 1 more commit so main is also behind origin/main (ahead=1, behind=1).
	git(t, f.other, "pull", "-q")
	writeFile(t, filepath.Join(f.other, "r.txt"), "r\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "r")
	git(t, f.other, "push", "-q")
	git(t, f.project, "fetch", "-q")

	// Dirty managed-dirty before Refresh.
	wip := filepath.Join(managedDirty.Path, "wip.txt")
	writeFile(t, wip, "wip\n")

	beforeMT := cr.count("merge-tree")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if got := cr.count("merge-tree") - beforeMT; got != 1 {
		t.Fatalf("merge-tree ran %d times across (main, unmanaged, managed-dirty, managed-clean), want 1", got)
	}
	wtDirty, _ := h.store.Snapshot().Worktree(r.ID, managedDirty.Path)
	if wtDirty.Status.BaseMerged {
		t.Fatal("dirty managed worktree should not have run mergedByContent yet")
	}

	// Clean managed-dirty at the exact same (HEAD, base): status should run merge-tree
	// without re-running rev-list and discover BaseMerged == true.
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
	if got := cr.count("merge-tree") - beforeMT; got != 1 {
		t.Fatalf("dirty->clean transition ran merge-tree %d times, want 1", got)
	}
	wtCleanNow, _ := h.store.Snapshot().Worktree(r.ID, managedDirty.Path)
	if !wtCleanNow.Status.BaseMerged {
		t.Fatal("cleaned squash-merged managed worktree did not report BaseMerged=true")
	}
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
