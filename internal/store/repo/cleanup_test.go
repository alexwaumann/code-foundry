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
	merged := Worktree{Path: "/wt/a", Branch: "cf/a", Managed: true, Status: Status{BaseRef: "origin/main", RefreshedAt: at}}
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
		{"not created by Code Foundry", with(func(w *Worktree) { w.Managed = false }), "not a Code Foundry worktree"},
		{"unmanaged wins over dirty", with(func(w *Worktree) { w.Managed, w.Status.Dirty = false, true }), "not a Code Foundry worktree"},
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

// TestCleanupRealRepo: a worktree under the store's WorktreeRoot whose branch is merged
// into origin/main and clean is removed (its branch stays); a merged one with an
// untracked file, one with a commit not on origin/main, one a hold names, and a merged
// clean one outside WorktreeRoot (made by another tool) are kept with their reasons.
func TestCleanupRealRepo(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	defer h.close()
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	// Worktrees go under the store's own worktree directory. Its configured path is not
	// symlink-resolved (a temp dir under /var, which is /private/var), the snapshot's
	// paths are: the store must still see them as inside it.
	if err := os.MkdirAll(h.store.wtRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(h.store.wtRoot)
	if err != nil {
		t.Fatal(err)
	}
	wt := func(name string) string { return filepath.Join(root, "proj", "wt-"+name) }
	outside := filepath.Join(f.base, "elsewhere")
	for _, b := range []string{"merged", "dirty", "unmerged", "held"} {
		git(t, f.repo, "worktree", "add", "-q", "-b", "cf/"+b, wt(b), "main")
	}
	git(t, f.repo, "worktree", "add", "-q", "-b", "cf/elsewhere", outside, "main")
	// merged, dirty, held and elsewhere: one commit each, merged into main and pushed.
	for b, dir := range map[string]string{"merged": wt("merged"), "dirty": wt("dirty"), "held": wt("held"), "elsewhere": outside} {
		writeFile(t, filepath.Join(dir, b+".txt"), b+"\n")
		git(t, dir, "add", ".")
		git(t, dir, "commit", "-q", "-m", b)
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
		outside:        "not a Code Foundry worktree",
	}
	for p, reason := range want {
		if reasons[p] != reason {
			t.Errorf("skip reason for %s = %q, want %q", filepath.Base(p), reasons[p], reason)
		}
	}
	if len(res.Skipped) != len(want) {
		t.Errorf("skipped %v, want 4 (the main worktree is not listed)", res.Skipped)
	}
	if _, err := os.Stat(wt("merged")); !os.IsNotExist(err) {
		t.Errorf("merged worktree still on disk: %v", err)
	}
	for _, p := range []string{wt("dirty"), wt("unmerged"), wt("held"), outside} {
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
