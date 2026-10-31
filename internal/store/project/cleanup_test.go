package project

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCleanupVerdict(t *testing.T) {
	now := time.Unix(1700000000, 0)
	old := now.Add(-time.Hour)
	// merged: made an hour ago, one commit since (Head moved off CreatedHead), and that
	// commit is in origin/main.
	merged := Worktree{
		Path: "/wt/a", Branch: "cf/a", Head: "c2", Managed: true, CreatedAt: old, CreatedHead: "c1",
		Status: Status{BaseRef: "origin/main", RefreshedAt: now},
	}
	with := func(f func(*Worktree)) Worktree {
		w := merged
		f(&w)
		return w
	}
	const (
		inBase   = "branch is in origin/main"
		noCommit = "no commits since it was made"
		landed   = "a rebased or squash-merged copy is in origin/main"
		fresh    = "no commits yet, made less than 10 minutes ago"
	)
	tests := []struct {
		name      string
		w         Worktree
		removable bool
		reason    string
	}{
		{"merged and clean", merged, true, inBase},
		{"behind the base is fine", with(func(w *Worktree) { w.Status.BaseBehind = 7 }), true, inBase},
		{"ahead of its upstream only", with(func(w *Worktree) { w.Status.Ahead = 2 }), true, inBase},
		{"main worktree", with(func(w *Worktree) { w.IsMain = true }), false, "main worktree"},
		{"not made by Code Foundry", with(func(w *Worktree) { w.Managed = false }), false, NotManagedReason},
		{"not made by Code Foundry, zero commits and new", with(func(w *Worktree) {
			w.Managed, w.CreatedAt, w.CreatedHead, w.Head = false, time.Time{}, "", "c1"
		}), false, NotManagedReason},
		{"unmanaged wins over dirty", with(func(w *Worktree) { w.Managed, w.Status.Dirty = false, true }), false, NotManagedReason},
		{"detached", with(func(w *Worktree) { w.Detached, w.Branch = true, "" }), false, "detached HEAD"},
		{"no branch", with(func(w *Worktree) { w.Branch = "" }), false, "detached HEAD"},
		{"status error", with(func(w *Worktree) { w.Status.Error = "boom" }), false, "git status failed: boom"},
		{"never refreshed", with(func(w *Worktree) { w.Status.RefreshedAt = time.Time{} }), false, "git status not read yet"},
		{"dirty", with(func(w *Worktree) { w.Status.Dirty = true }), false, "uncommitted changes"},
		{"staged", with(func(w *Worktree) { w.Status.Staged = 1 }), false, "uncommitted changes"},
		{"modified", with(func(w *Worktree) { w.Status.Modified = 1 }), false, "uncommitted changes"},
		{"untracked", with(func(w *Worktree) { w.Status.Untracked = 1 }), false, "uncommitted changes"},
		{"conflicted", with(func(w *Worktree) { w.Status.Conflicted = 1 }), false, "uncommitted changes"},
		{"operation in progress", with(func(w *Worktree) { w.Status.Operation = OpBisect }), false, "bisect in progress"},
		{"operation wins over dirty", with(func(w *Worktree) { w.Status.Operation, w.Status.Dirty = OpMerge, true }), false, "merge in progress"},
		{"no base ref", with(func(w *Worktree) { w.Status.BaseRef = "" }), false, "no remote default branch to compare with"},
		{"one commit ahead", with(func(w *Worktree) { w.Status.BaseAhead = 1 }), false, "1 commit not in origin/main"},
		{"commits ahead", with(func(w *Worktree) { w.Status.BaseAhead = 3 }), false, "3 commits not in origin/main"},
		{"main wins over dirty", with(func(w *Worktree) { w.IsMain, w.Status.Dirty = true, true }), false, "main worktree"},

		// Zero commits past the base: the empty branch is "in" origin/main, so only its
		// age keeps it.
		{"zero commits, just made", with(func(w *Worktree) { w.Head, w.CreatedAt = "c1", now.Add(-time.Minute) }), false, fresh},
		{"zero commits, made 9m59s ago", with(func(w *Worktree) { w.Head, w.CreatedAt = "c1", now.Add(-FreshFor+time.Second) }), false, fresh},
		{"zero commits, made 10m ago", with(func(w *Worktree) { w.Head, w.CreatedAt = "c1", now.Add(-FreshFor) }), true, noCommit},
		{"zero commits, made an hour ago", with(func(w *Worktree) { w.Head = "c1" }), true, noCommit},
		{"zero commits, archived thread's worktree made a minute ago", with(func(w *Worktree) {
			w.Head, w.CreatedAt = "c1", now.Add(-time.Minute)
		}), false, fresh},
		{"just made, head unknown (recorded before heads were)", with(func(w *Worktree) {
			w.CreatedHead, w.CreatedAt = "", now.Add(-time.Minute)
		}), false, fresh},
		{"old, head unknown", with(func(w *Worktree) { w.CreatedHead = "" }), true, inBase},
		{"no creation time", with(func(w *Worktree) { w.Head, w.CreatedAt = "c1", time.Time{} }), true, noCommit},
		{"just made but committed and merged already", with(func(w *Worktree) { w.CreatedAt = now.Add(-time.Minute) }), true, inBase},
		{"just made from a branch whose copy landed", with(func(w *Worktree) {
			w.Head, w.CreatedAt, w.Status.BaseAhead, w.Status.BaseBehind, w.Status.BaseMerged = "c1", now.Add(-time.Minute), 2, 3, true
		}), false, fresh},
		{"dirty wins over just made", with(func(w *Worktree) { w.Head, w.CreatedAt, w.Status.Untracked = "c1", now, 1 }), false, "uncommitted changes"},

		// Commits past the base whose changes landed another way.
		{"rebased copy merged", with(func(w *Worktree) {
			w.Status.BaseAhead, w.Status.BaseBehind, w.Status.BaseMerged = 2, 5, true
		}), true, landed},
		{"squash-merged", with(func(w *Worktree) {
			w.Status.BaseAhead, w.Status.BaseBehind, w.Status.BaseMerged = 1, 1, true
		}), true, landed},
		{"ahead and behind, changes not in the base", with(func(w *Worktree) {
			w.Status.BaseAhead, w.Status.BaseBehind = 2, 5
		}), false, "2 commits not in origin/main"},
		{"landed but dirty", with(func(w *Worktree) {
			w.Status.BaseAhead, w.Status.BaseMerged, w.Status.Modified = 2, true, 1
		}), false, "uncommitted changes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			removable, reason := CleanupVerdict(tt.w, now)
			if removable != tt.removable || reason != tt.reason {
				t.Errorf("CleanupVerdict = %v, %q; want %v, %q", removable, reason, tt.removable, tt.reason)
			}
			if got := tt.w.MergedClean(now); got != tt.removable {
				t.Errorf("MergedClean = %v, want %v", got, tt.removable)
			}
		})
	}
}

func TestWorktreeLanded(t *testing.T) {
	base := Status{BaseRef: "origin/main"}
	with := func(f func(*Status)) Worktree {
		st := base
		f(&st)
		return Worktree{Path: "/wt/a", Branch: "cf/a", Status: st}
	}
	tests := []struct {
		name string
		w    Worktree
		want bool
	}{
		{"in the base", with(func(*Status) {}), true},
		{"behind the base is still landed", with(func(s *Status) { s.BaseBehind = 4 }), true},
		{"dirty but its commits are in", with(func(s *Status) { s.Modified, s.Dirty = 2, true }), true},
		{"commits not in the base", with(func(s *Status) { s.BaseAhead = 3 }), false},
		{"a rebased or squash-merged copy landed", with(func(s *Status) { s.BaseAhead, s.BaseMerged = 3, true }), true},
		{"no base ref", with(func(s *Status) { s.BaseRef = "" }), false},
		{"status read failed", with(func(s *Status) { s.Error = "boom" }), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.w.Landed(); got != tt.want {
				t.Errorf("Landed = %v, want %v", got, tt.want)
			}
		})
	}
}

// A worktree whose threads are all archived or removed is not kept for being new: no
// one is about to commit in it. Every other rule still holds.
func TestCleanupVerdictAbandoned(t *testing.T) {
	now := time.Unix(1700000000, 0)
	fresh := Worktree{
		Path: "/wt/a", Branch: "cf/a", Head: "c1", Managed: true, CreatedAt: now.Add(-time.Minute), CreatedHead: "c1",
		Status: Status{BaseRef: "origin/main", RefreshedAt: now},
	}
	with := func(f func(*Worktree)) Worktree {
		w := fresh
		f(&w)
		return w
	}
	tests := []struct {
		name      string
		w         Worktree
		abandoned bool
		removable bool
		reason    string
	}{
		{"fresh, a thread may still commit", fresh, false, false, "no commits yet, made less than 10 minutes ago"},
		{"fresh, its thread archived", fresh, true, true, AbandonedReason},
		{"fresh, head unknown, its thread archived", with(func(w *Worktree) { w.CreatedHead = "" }), true, true, AbandonedReason},
		{"fresh and dirty, its thread archived", with(func(w *Worktree) { w.Status.Untracked = 1 }), true, false, UncommittedReason},
		{"fresh, unmanaged, its thread archived", with(func(w *Worktree) { w.Managed = false }), true, false, NotManagedReason},
		{"fresh from a branch with commits not in the base", with(func(w *Worktree) { w.Status.BaseAhead = 2 }), true, false, "2 commits not in origin/main"},
		{"fresh from a branch whose copy landed", with(func(w *Worktree) { w.Status.BaseAhead, w.Status.BaseMerged = 2, true }), true, true,
			"a rebased or squash-merged copy is in origin/main"},
		{"old, its thread archived", with(func(w *Worktree) { w.CreatedAt = now.Add(-time.Hour) }), true, true, "no commits since it was made"},
		{"committed and merged, its thread archived", with(func(w *Worktree) { w.Head = "c2" }), true, true, "branch is in origin/main"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			removable, reason := cleanupVerdict(tt.w, now, tt.abandoned)
			if removable != tt.removable || reason != tt.reason {
				t.Errorf("cleanupVerdict = %v, %q; want %v, %q", removable, reason, tt.removable, tt.reason)
			}
		})
	}
}

func TestInsideRoot(t *testing.T) {
	tests := []struct {
		name  string
		path  string
		roots []string
		want  bool
	}{
		{"inside", "/x/worktrees/owner/repo/cf-a", []string{"/x/worktrees"}, true},
		{"directly inside", "/x/worktrees/cf-a", []string{"/x/worktrees"}, true},
		{"root with a trailing slash", "/x/worktrees/cf-a", []string{"/x/worktrees/"}, true},
		{"the root itself", "/x/worktrees", []string{"/x/worktrees"}, false},
		{"shares only a prefix string", "/x/worktrees2/cf-a", []string{"/x/worktrees"}, false},
		{"parent", "/x", []string{"/x/worktrees"}, false},
		{"elsewhere", "/Users/me/.t3/worktrees/code-foundry/t3code-1", []string{"/Users/me/.code-foundry/worktrees"}, false},
		{"dot-dot escapes", "/x/worktrees/../other/cf-a", []string{"/x/worktrees"}, false},
		{"a dot-dot-prefixed name stays inside", "/x/worktrees/..cf-a", []string{"/x/worktrees"}, true},
		{"second root", "/dev/wt/repo/cf-a", []string{"/x/worktrees", "/dev/wt/repo"}, true},
		{"no roots", "/x/worktrees/cf-a", nil, false},
		{"empty root qualifies nothing", "/x/worktrees/cf-a", []string{""}, false},
		{"empty path", "", []string{"/x/worktrees"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := InsideRoot(tt.path, tt.roots...); got != tt.want {
				t.Errorf("InsideRoot(%q, %q) = %v, want %v", tt.path, tt.roots, got, tt.want)
			}
		})
	}
}

func TestInsideRootResolvesRootSymlinks(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.MkdirAll(filepath.Join(real, "cf-a"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	resolvedPath, err := filepath.EvalSymlinks(filepath.Join(real, "cf-a"))
	if err != nil {
		t.Fatal(err)
	}
	// Snapshot paths are resolved; a root given through a symlink still contains them.
	if !InsideRoot(resolvedPath, link) {
		t.Errorf("%s is not inside %s (a symlink to %s)", resolvedPath, link, real)
	}
}

// TestCleanupRealProject: a worktree under the store's WorktreeRoot whose branch is merged
// into origin/main and clean is removed (its branch stays); a merged one with an
// untracked file, one with a commit not on origin/main, one a hold names, and a merged
// clean one outside WorktreeRoot (made by another tool) are kept with their reasons.

// TestCleanupRealProject runs the rule against real git. Code Foundry made seven
// worktrees: merged (a commit merged into origin/main), rebased (its commit landed as a
// copy on a moved main, the branch still at the original), squashed (two commits
// squash-merged) are removed with their reasons, branches kept; dirty (merged, plus an
// untracked file), unmerged (a commit not on origin/main), held (merged, but the hold
// names it) and fresh (no commits, just made) are kept. Two worktrees git made by hand
// are kept whatever their branch: one elsewhere, one under the worktrees directory
// (what an agent's `git worktree add` there looks like). Once FreshFor has passed, the
// fresh one goes too.
func TestCleanupRealProject(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	defer h.close()
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	commit := func(dir, name string) {
		t.Helper()
		writeFile(t, filepath.Join(dir, name+".txt"), name+"\n")
		git(t, dir, "add", ".")
		git(t, dir, "commit", "-q", "-m", name)
	}
	wt := map[string]string{}
	for _, b := range []string{"merged", "dirty", "unmerged", "held", "fresh", "rebased", "squashed"} {
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/" + b})
		if err != nil {
			t.Fatal(err)
		}
		if !w.Managed || w.CreatedAt.IsZero() || w.CreatedHead == "" || w.CreatedHead != w.Head {
			t.Fatalf("made worktree %s: Managed %v, CreatedAt %v, CreatedHead %q (head %q)", b, w.Managed, w.CreatedAt, w.CreatedHead, w.Head)
		}
		wt[b] = w.Path
	}
	// The store's configured root is not symlink-resolved (a temp dir under /var, which
	// is /private/var); the snapshot's paths are.
	root, err := filepath.EvalSymlinks(h.store.wtRoot)
	if err != nil {
		t.Fatal(err)
	}
	byHand := filepath.Join(root, "_local", "proj", "by-hand")
	elsewhere := filepath.Join(f.base, "elsewhere")
	git(t, f.project, "worktree", "add", "-q", "-b", "by-hand", byHand, "main")
	git(t, f.project, "worktree", "add", "-q", "-b", "elsewhere", elsewhere, "main")

	for _, b := range []string{"merged", "dirty", "held"} {
		commit(wt[b], b)
		git(t, f.project, "merge", "-q", "--no-ff", "-m", "merge "+b, "cf/"+b)
	}
	commit(elsewhere, "elsewhere")
	git(t, f.project, "merge", "-q", "--no-ff", "-m", "merge elsewhere", "elsewhere")
	commit(wt["unmerged"], "unmerged")
	// Main moves on, then a copy of cf/rebased lands on it (a rebase and merge), and
	// cf/squashed lands as one squashed commit.
	commit(wt["rebased"], "rebased")
	commit(wt["squashed"], "squashed-1")
	commit(wt["squashed"], "squashed-2")
	commit(f.project, "main-moves-on")
	git(t, f.project, "cherry-pick", "cf/rebased")
	git(t, f.project, "merge", "-q", "--squash", "cf/squashed")
	git(t, f.project, "commit", "-q", "-m", "squashed")
	git(t, f.project, "push", "-q", "origin", "main")
	writeFile(t, filepath.Join(wt["dirty"], "scratch.txt"), "wip\n")

	hold := func(w Worktree) string {
		if w.Path == wt["held"] {
			return "a live thread runs in it"
		}
		return ""
	}
	wantRemoved := map[string]string{
		wt["merged"]:   "branch is in origin/main",
		wt["rebased"]:  "a rebased or squash-merged copy is in origin/main",
		wt["squashed"]: "a rebased or squash-merged copy is in origin/main",
	}
	wantKept := map[string]string{
		wt["dirty"]:    "uncommitted changes",
		wt["unmerged"]: "1 commit not in origin/main",
		wt["held"]:     "a live thread runs in it",
		wt["fresh"]:    "no commits yet, made less than 10 minutes ago",
		byHand:         "not a Code Foundry worktree",
		elsewhere:      "not a Code Foundry worktree",
	}
	check := func(what string, res CleanupResult, removed, kept map[string]string) {
		t.Helper()
		if got := reasons(res.Removed); !maps.Equal(got, removed) {
			t.Errorf("%s removed %v\nwant %v", what, got, removed)
		}
		if got := reasons(res.Skipped); !maps.Equal(got, kept) {
			t.Errorf("%s kept %v\nwant %v (the main worktree is not listed)", what, got, kept)
		}
	}

	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	removing := map[string]string{}
	told := func(_ context.Context, w Worktree) {
		if _, err := os.Stat(w.Path); err != nil {
			t.Errorf("told of %s after it was removed", w.Path)
		}
		removing[w.Path] = wantRemoved[w.Path]
	}
	dry, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, DryRun: true, Hold: hold, Removing: told})
	if err != nil {
		t.Fatal(err)
	}
	check("dry run", dry, wantRemoved, wantKept)
	if _, err := os.Stat(wt["merged"]); err != nil {
		t.Fatalf("dry run removed something: %v", err)
	}
	if len(removing) != 0 {
		t.Errorf("a dry run told Removing of %v", removing)
	}
	// The fresh worktree of an archived thread would go at once.
	abandoned, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Path: wt["fresh"], DryRun: true, Hold: hold,
		Abandoned: func(w Worktree) bool { return w.Path == wt["fresh"] }})
	if err != nil {
		t.Fatal(err)
	}
	check("dry run, abandoned", abandoned, map[string]string{wt["fresh"]: AbandonedReason}, map[string]string{})

	res, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Hold: hold, Removing: told})
	if err != nil {
		t.Fatal(err)
	}
	check("cleanup", res, wantRemoved, wantKept)
	if !maps.Equal(removing, wantRemoved) {
		t.Errorf("Removing told of %v, want %v", removing, wantRemoved)
	}
	for p := range wantRemoved {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still on disk: %v", p, err)
		}
		if _, ok := h.store.Snapshot().Worktree(r.ID, p); ok {
			t.Errorf("snapshot still lists the removed %s", p)
		}
		if h.made(p) {
			t.Errorf("the record of the removed %s is still there", p)
		}
	}
	for p := range wantKept {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was removed: %v", p, err)
		}
	}
	for _, b := range []string{"cf/merged", "cf/rebased", "cf/squashed"} {
		if out := git(t, f.project, "branch", "--list", b); !strings.Contains(out, b) {
			t.Errorf("branch %s was deleted", b)
		}
	}

	// Later, the fresh worktree with no commits goes; the rest stays as it was.
	later := func() time.Time { return time.Now().Add(FreshFor + time.Minute) }
	res, err = Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Hold: hold, Now: later})
	if err != nil {
		t.Fatal(err)
	}
	delete(wantKept, wt["fresh"])
	check("cleanup later", res, map[string]string{wt["fresh"]: "no commits since it was made"}, wantKept)

	// One path: the unmerged worktree is reported, not removed.
	one, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Path: wt["unmerged"]})
	if err != nil {
		t.Fatal(err)
	}
	if len(one.Removed) != 0 || len(one.Skipped) != 1 || one.Skipped[0].Reason != "1 commit not in origin/main" {
		t.Errorf("cleanup of the unmerged path = %+v", one)
	}
	if _, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Path: filepath.Join(root, "nope")}); err == nil {
		t.Errorf("cleanup of an unknown path succeeded")
	}
	for _, it := range res.Skipped {
		if it.Uncommitted != (it.Worktree.Path == wt["dirty"]) {
			t.Errorf("%s marked uncommitted = %v (only the dirty, otherwise removable one is)", it.Worktree.Path, it.Uncommitted)
		}
	}

	// Removing the dirty worktree without force: git refuses and the error names the
	// work, with its status read again.
	var ue *UncommittedError
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: wt["dirty"]}); !errors.As(err, &ue) ||
		len(ue.Worktrees) != 1 || ue.Worktrees[0].Path != wt["dirty"] || ue.Worktrees[0].Status.Untracked != 1 {
		t.Fatalf("remove dirty without force: %v", err)
	}

	// Force removes it, deleting the scratch file; a dirty held worktree still stays.
	writeFile(t, filepath.Join(wt["held"], "scratch.txt"), "wip\n")
	forced, err := Cleanup(ctx, h.store, CleanupOptions{ProjectID: r.ID, Hold: hold, Force: true})
	if err != nil {
		t.Fatal(err)
	}
	delete(wantKept, wt["dirty"])
	check("forced cleanup", forced, map[string]string{wt["dirty"]: "branch is in origin/main"}, wantKept)
	if len(forced.Removed) != 1 || !forced.Removed[0].Uncommitted {
		t.Errorf("forced removal = %+v, want the dirty one marked uncommitted", forced.Removed)
	}
	if _, err := os.Stat(wt["dirty"]); !os.IsNotExist(err) {
		t.Errorf("dirty worktree still on disk: %v", err)
	}
	if _, err := os.Stat(wt["held"]); err != nil {
		t.Errorf("held worktree removed: %v", err)
	}
}

// TestMadeWorktreeRecords: the record of a worktree the store made survives a restart;
// once git no longer lists the worktree (removed by hand) the record goes, so a worktree
// added by hand at the same path later is not managed.
func TestMadeWorktreeRecords(t *testing.T) {
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/rec"})
	if err != nil {
		t.Fatal(err)
	}
	h.close()

	h = startHarness(t, dbPath, Options{})
	defer h.close()
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	got, ok := h.store.Snapshot().Worktree(r.ID, w.Path)
	if !ok || !got.Managed || got.CreatedHead != w.CreatedHead || !got.CreatedAt.Equal(w.CreatedAt.Truncate(time.Millisecond)) {
		t.Fatalf("after a restart: %+v (ok %v), want managed, made at %v on %s", got, ok, w.CreatedAt, w.CreatedHead)
	}

	git(t, f.project, "worktree", "remove", w.Path)
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if h.made(w.Path) {
		t.Fatalf("the record of %s outlived the worktree", w.Path)
	}
	git(t, f.project, "worktree", "add", "-q", w.Path, "cf/rec")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if got, ok := h.store.Snapshot().Worktree(r.ID, w.Path); !ok || got.Managed {
		t.Errorf("a worktree added by hand where one was made: %+v (ok %v), want listed and not managed", got, ok)
	}
	var n int
	if err := h.db.QueryRowContext(ctx, `SELECT count(*) FROM project_worktrees WHERE path = ?`, w.Path).Scan(&n); err != nil || n != 0 {
		t.Errorf("project_worktrees rows for %s: %d, %v; want 0", w.Path, n, err)
	}
}

// made reports whether the store has a record of the worktree at path.
func (h *harness) made(path string) bool {
	h.store.mu.RLock()
	defer h.store.mu.RUnlock()
	_, ok := h.store.made[path]
	return ok
}

func reasons(items []CleanupItem) map[string]string {
	out := make(map[string]string, len(items))
	for _, it := range items {
		out[it.Worktree.Path] = it.Reason
	}
	return out
}
