package repo

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestMergedCleanReason(t *testing.T) {
	at := time.Unix(1700000000, 0)
	merged := Worktree{Path: "/wt/a", Branch: "cf/a", Status: Status{BaseRef: "origin/main", RefreshedAt: at}}
	with := func(f func(*Worktree)) Worktree {
		w := merged
		f(&w)
		return w
	}
	tests := []struct {
		name string
		w    Worktree
		want string
	}{
		{"merged and clean", merged, ""},
		{"behind the base is fine", with(func(w *Worktree) { w.Status.BaseBehind = 7 }), ""},
		{"ahead of its upstream only", with(func(w *Worktree) { w.Status.Ahead = 2 }), ""},
		{"main worktree", with(func(w *Worktree) { w.IsMain = true }), "main worktree"},
		{"detached", with(func(w *Worktree) { w.Detached, w.Branch = true, "" }), "detached HEAD"},
		{"no branch", with(func(w *Worktree) { w.Branch = "" }), "detached HEAD"},
		{"status error", with(func(w *Worktree) { w.Status.Error = "boom" }), "git status failed: boom"},
		{"never refreshed", with(func(w *Worktree) { w.Status.RefreshedAt = time.Time{} }), "git status not read yet"},
		{"dirty", with(func(w *Worktree) { w.Status.Dirty = true }), "uncommitted changes"},
		{"staged", with(func(w *Worktree) { w.Status.Staged = 1 }), "uncommitted changes"},
		{"modified", with(func(w *Worktree) { w.Status.Modified = 1 }), "uncommitted changes"},
		{"untracked", with(func(w *Worktree) { w.Status.Untracked = 1 }), "uncommitted changes"},
		{"conflicted", with(func(w *Worktree) { w.Status.Conflicted = 1 }), "uncommitted changes"},
		{"no base ref", with(func(w *Worktree) { w.Status.BaseRef = "" }), "no remote default branch to compare with"},
		{"one commit ahead", with(func(w *Worktree) { w.Status.BaseAhead = 1 }), "1 commit not in origin/main"},
		{"commits ahead", with(func(w *Worktree) { w.Status.BaseAhead = 3 }), "3 commits not in origin/main"},
		{"main wins over dirty", with(func(w *Worktree) { w.IsMain, w.Status.Dirty = true, true }), "main worktree"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MergedCleanReason(tt.w); got != tt.want {
				t.Errorf("MergedCleanReason = %q, want %q", got, tt.want)
			}
			if got := tt.w.MergedClean(); got != (tt.want == "") {
				t.Errorf("MergedClean = %v, want %v", got, tt.want == "")
			}
		})
	}
}

// TestCleanupRealRepo: a worktree whose branch is merged into origin/main and clean is
// removed (its branch stays); a merged one with an untracked file, one with a commit not
// on origin/main, and one a hold names are kept with their reasons.
func TestCleanupRealRepo(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	defer h.close()
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	wt := func(name string) string { return filepath.Join(f.base, "wt-"+name) }
	for _, b := range []string{"merged", "dirty", "unmerged", "held"} {
		git(t, f.repo, "worktree", "add", "-q", "-b", "cf/"+b, wt(b), "main")
	}
	// merged, dirty and held: one commit each, merged into main and pushed.
	for _, b := range []string{"merged", "dirty", "held"} {
		writeFile(t, filepath.Join(wt(b), b+".txt"), b+"\n")
		git(t, wt(b), "add", ".")
		git(t, wt(b), "commit", "-q", "-m", b)
		git(t, f.repo, "merge", "-q", "--no-ff", "-m", "merge "+b, "cf/"+b)
	}
	git(t, f.repo, "push", "-q", "origin", "main")
	writeFile(t, filepath.Join(wt("dirty"), "scratch.txt"), "wip\n")
	writeFile(t, filepath.Join(wt("unmerged"), "u.txt"), "u\n")
	git(t, wt("unmerged"), "add", ".")
	git(t, wt("unmerged"), "commit", "-q", "-m", "not merged")

	hold := func(w Worktree) string {
		if w.Path == wt("held") {
			return "a live thread runs in it"
		}
		return ""
	}
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	dry, err := Cleanup(ctx, h.store, CleanupOptions{RepoID: r.ID, DryRun: true, Hold: hold})
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(dry.Removed); !slices.Equal(got, []string{wt("merged")}) {
		t.Fatalf("dry run would remove %v, want only %s", got, wt("merged"))
	}
	if _, err := os.Stat(wt("merged")); err != nil {
		t.Fatalf("dry run removed something: %v", err)
	}

	res, err := Cleanup(ctx, h.store, CleanupOptions{RepoID: r.ID, Hold: hold})
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(res.Removed); !slices.Equal(got, []string{wt("merged")}) {
		t.Fatalf("removed %v, want only %s", got, wt("merged"))
	}
	reasons := map[string]string{}
	for _, s := range res.Skipped {
		reasons[s.Worktree.Path] = s.Reason
	}
	want := map[string]string{
		wt("dirty"):    "uncommitted changes",
		wt("unmerged"): "1 commit not in origin/main",
		wt("held"):     "a live thread runs in it",
	}
	for p, reason := range want {
		if reasons[p] != reason {
			t.Errorf("skip reason for %s = %q, want %q", filepath.Base(p), reasons[p], reason)
		}
	}
	if len(res.Skipped) != len(want) {
		t.Errorf("skipped %v, want 3 (the main worktree is not listed)", res.Skipped)
	}
	if _, err := os.Stat(wt("merged")); !os.IsNotExist(err) {
		t.Errorf("merged worktree still on disk: %v", err)
	}
	for _, p := range []string{wt("dirty"), wt("unmerged"), wt("held")} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("%s was removed: %v", filepath.Base(p), err)
		}
	}
	if out := git(t, f.repo, "branch", "--list", "cf/merged"); !strings.Contains(out, "cf/merged") {
		t.Errorf("branch cf/merged was deleted")
	}
	if _, ok := h.store.Snapshot().Worktree(r.ID, wt("merged")); ok {
		t.Errorf("snapshot still lists the removed worktree")
	}

	// One path: the unmerged worktree is reported, not removed.
	one, err := Cleanup(ctx, h.store, CleanupOptions{RepoID: r.ID, Path: wt("unmerged")})
	if err != nil {
		t.Fatal(err)
	}
	if len(one.Removed) != 0 || len(one.Skipped) != 1 || one.Skipped[0].Reason != "1 commit not in origin/main" {
		t.Errorf("cleanup of the unmerged path = %+v", one)
	}
	if _, err := Cleanup(ctx, h.store, CleanupOptions{RepoID: r.ID, Path: wt("nope")}); err == nil {
		t.Errorf("cleanup of an unknown path succeeded")
	}
}

func paths(ws []Worktree) []string {
	out := make([]string, len(ws))
	for i, w := range ws {
		out[i] = w.Path
	}
	return out
}
