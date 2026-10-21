package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A worktree whose directory was deleted by hand can be made again at the same path,
// and its branch deleted: git's stale entry for it is dropped first (fuzz finding git 3).
func TestWorktreeDeletedByHand(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	gone := func(branch string) Worktree {
		t.Helper()
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: branch})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(w.Path); err != nil {
			t.Fatal(err)
		}
		return w
	}
	w := gone("fix-bug")
	again, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "fix-bug"})
	if err != nil || again.Path != w.Path {
		t.Fatalf("recreate = %+v, %v; want it at %s", again, err, w.Path)
	}
	// The other stale entry is left alone until something targets it.
	other := gone("other")
	stale := gone("stale")
	if _, err := h.store.DeleteBranch(ctx, DeleteBranchOptions{ProjectID: r.ID, Branch: "other"}); err != nil {
		t.Fatalf("delete the branch of a hand-deleted worktree: %v", err)
	}
	list := git(t, f.project, "worktree", "list", "--porcelain")
	if strings.Contains(list, other.Path) || !strings.Contains(list, stale.Path) {
		t.Errorf("worktree list after:\n%s", list)
	}
}

// Two projects with the same folder name get different worktree directories; the
// one registered first keeps the plain one. A path that is taken anyway fails before
// git makes the branch (fuzz finding git 4).
func TestWorktreePathsOfSameNamedProjects(t *testing.T) {
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	var ps []Project
	for _, parent := range []string{"work", "oss"} {
		dir := filepath.Join(base, parent, "app")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		git(t, dir, "init", "-q", "-b", "main")
		git(t, dir, "commit", "-q", "--allow-empty", "-m", "init")
		r, err := h.store.Register(ctx, dir)
		if err != nil {
			t.Fatal(err)
		}
		ps = append(ps, r)
		time.Sleep(2 * time.Millisecond) // registration times are in milliseconds
	}
	root := h.store.wtRoot
	want := []string{
		filepath.Join(root, "_local", "app", "fix-bug"),
		filepath.Join(root, "_local", "app-"+ps[1].ID[:8], "fix-bug"),
	}
	for i, r := range ps {
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "fix-bug"})
		if err != nil {
			t.Fatalf("%s: %v", r.Path, err)
		}
		if got, _ := filepath.EvalSymlinks(want[i]); w.Path != got {
			t.Errorf("%s: worktree at %s, want %s", r.Path, w.Path, want[i])
		}
	}

	// Something already at the path: refused, and no branch left behind.
	taken := filepath.Join(root, "_local", "app", "taken")
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err = h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: ps[0].ID, Branch: "taken"})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("taken path: %v", err)
	}
	if out := git(t, ps[0].Path, "branch", "--list", "taken"); out != "" {
		t.Errorf("branch made for a taken path: %q", out)
	}
}
