package project

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// DeleteBranch deletes a branch whose worktree is gone, locally and (with Remote) on
// origin; -d unless Force; the default branch and a checked-out one are refused.
func TestDeleteBranch(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	git(t, f.project, "branch", "merged")
	git(t, f.project, "checkout", "-q", "-b", "unmerged")
	writeFile(t, filepath.Join(f.project, "u.txt"), "u\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "unmerged work")
	git(t, f.project, "checkout", "-q", "main")
	git(t, f.project, "branch", "pushed")
	git(t, f.project, "push", "-q", "origin", "pushed")
	git(t, f.other, "push", "-q", "origin", "main:remote-only")
	// Pushed, so `git branch -d` alone would pass it (merged into its own upstream).
	git(t, f.project, "checkout", "-q", "-b", "pushed-unmerged")
	writeFile(t, filepath.Join(f.project, "p.txt"), "p\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "pushed, never merged")
	git(t, f.project, "push", "-q", "-u", "origin", "pushed-unmerged")
	// Squash-merged into origin's main: its commits are not ancestors, its changes are in.
	git(t, f.project, "checkout", "-q", "-b", "squashed", "main")
	writeFile(t, filepath.Join(f.project, "s.txt"), "s\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "squashed work")
	git(t, f.project, "checkout", "-q", "main")
	git(t, f.other, "pull", "-q", "origin", "main")
	writeFile(t, filepath.Join(f.other, "s.txt"), "s\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "squash merge")
	git(t, f.other, "push", "-q", "origin", "main")
	// Only on origin, holding a commit nobody merged; the project never fetched it.
	git(t, f.other, "checkout", "-q", "-b", "colleague")
	writeFile(t, filepath.Join(f.other, "c.txt"), "c\n")
	git(t, f.other, "add", ".")
	git(t, f.other, "commit", "-q", "-m", "colleague's work")
	git(t, f.other, "push", "-q", "origin", "colleague")
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "checked"}); err != nil {
		t.Fatal(err)
	}

	// In order: each step sees the ones before.
	steps := []struct {
		name    string
		o       DeleteBranchOptions
		want    DeleteBranchResult
		wantErr error
		msg     string // in the error
	}{
		{name: "merged", o: DeleteBranchOptions{Branch: "merged"}, want: DeleteBranchResult{Local: true}},
		{name: "unmerged without force", o: DeleteBranchOptions{Branch: "unmerged"}, wantErr: ErrFailedPrecondition},
		{name: "unmerged with force", o: DeleteBranchOptions{Branch: "unmerged", Force: true}, want: DeleteBranchResult{Local: true}},
		{name: "pushed but unmerged", o: DeleteBranchOptions{Branch: "pushed-unmerged", Remote: true}, wantErr: ErrFailedPrecondition, msg: "branch pushed-unmerged has 1 commit not in origin/main; --force"},
		{name: "pushed but unmerged, local only", o: DeleteBranchOptions{Branch: "pushed-unmerged"}, wantErr: ErrFailedPrecondition},
		{name: "unmerged on origin only", o: DeleteBranchOptions{Branch: "colleague", Remote: true}, wantErr: ErrFailedPrecondition, msg: "origin's colleague has 1 commit not in origin/main"},
		{name: "squash-merged (origin's main fetched to see it)", o: DeleteBranchOptions{Branch: "squashed"}, want: DeleteBranchResult{Local: true}},
		{name: "local and origin", o: DeleteBranchOptions{Branch: "pushed", Remote: true}, want: DeleteBranchResult{Local: true, Remote: true}},
		{name: "origin only", o: DeleteBranchOptions{Branch: "remote-only", Remote: true}, want: DeleteBranchResult{Remote: true}},
		{name: "gone everywhere", o: DeleteBranchOptions{Branch: "pushed", Remote: true}, wantErr: ErrNotFound},
		{name: "checked out in a worktree", o: DeleteBranchOptions{Branch: "checked", Force: true}, wantErr: ErrFailedPrecondition},
		{name: "the default branch", o: DeleteBranchOptions{Branch: "main", Force: true}, wantErr: ErrInvalidArgument},
		{name: "an option for a name", o: DeleteBranchOptions{Branch: "-D"}, wantErr: ErrInvalidArgument},
		{name: "not a ref name", o: DeleteBranchOptions{Branch: "a..b"}, wantErr: ErrInvalidArgument},
		{name: "unknown", o: DeleteBranchOptions{Branch: "nope"}, wantErr: ErrNotFound},
	}
	for _, s := range steps {
		s.o.ProjectID = r.ID
		got, err := h.store.DeleteBranch(ctx, s.o)
		if !errors.Is(err, s.wantErr) || got != s.want || (s.msg != "" && !strings.Contains(err.Error(), s.msg)) {
			t.Fatalf("%s: DeleteBranch = %+v, %v; want %+v, %v (%q)", s.name, got, err, s.want, s.wantErr, s.msg)
		}
	}
	for _, b := range []string{"merged", "unmerged", "pushed", "squashed"} {
		if out := git(t, f.project, "branch", "--list", b); out != "" {
			t.Errorf("branch %s still here: %q", b, out)
		}
	}
	if out := git(t, f.project, "branch", "--list", "pushed-unmerged"); out == "" {
		t.Error("unmerged pushed branch deleted without force")
	}
	heads := strings.Fields(git(t, f.project, "ls-remote", "--heads", "origin"))
	if !slices.Contains(heads, "refs/heads/main") || slices.Contains(heads, "refs/heads/pushed") || slices.Contains(heads, "refs/heads/remote-only") ||
		!slices.Contains(heads, "refs/heads/pushed-unmerged") || !slices.Contains(heads, "refs/heads/colleague") {
		t.Errorf("origin heads = %q", heads)
	}
	// Force deletes unmerged work on both sides.
	got, err := h.store.DeleteBranch(ctx, DeleteBranchOptions{ProjectID: r.ID, Branch: "pushed-unmerged", Remote: true, Force: true})
	if err != nil || got != (DeleteBranchResult{Local: true, Remote: true}) {
		t.Errorf("forced delete = %+v, %v", got, err)
	}
	if _, err := h.store.DeleteBranch(ctx, DeleteBranchOptions{ProjectID: "nope", Branch: "x"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown project: %v", err)
	}
}

// RemoveWorktree's DeleteBranch deletes only a merged branch unless Force; an unmerged
// one is kept after the worktree is removed, and the error says so.
func TestRemoveWorktreeDeleteBranch(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	mk := func(branch string, commit bool) Worktree {
		t.Helper()
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: branch})
		if err != nil {
			t.Fatal(err)
		}
		if commit {
			writeFile(t, filepath.Join(w.Path, branch+".txt"), "work\n")
			git(t, w.Path, "add", ".")
			git(t, w.Path, "commit", "-q", "-m", "unpushed work")
		}
		return w
	}
	cases := []struct {
		branch        string
		commit, force bool
		wantErr       error
		kept          bool
	}{
		{branch: "no-commits"},
		{branch: "unmerged", commit: true, wantErr: ErrFailedPrecondition, kept: true},
		{branch: "unmerged-forced", commit: true, force: true},
	}
	for _, c := range cases {
		w := mk(c.branch, c.commit)
		err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path, DeleteBranch: true, Force: c.force})
		if !errors.Is(err, c.wantErr) {
			t.Fatalf("%s: RemoveWorktree = %v; want %v", c.branch, err, c.wantErr)
		}
		if c.kept && !strings.Contains(err.Error(), "kept branch "+c.branch+": it has 1 commit not in origin/main") {
			t.Errorf("%s: error %q does not say the branch was kept", c.branch, err)
		}
		if _, ok := h.store.Snapshot().Worktree(r.ID, w.Path); ok {
			t.Errorf("%s: worktree still listed", c.branch)
		}
		if got := git(t, f.project, "branch", "--list", c.branch) != ""; got != c.kept {
			t.Errorf("%s: branch kept = %v; want %v", c.branch, got, c.kept)
		}
	}

	// A held worktree is refused before git runs, unless Force.
	w := mk("held", false)
	hold := func(Worktree) string { return "a terminal is open in it" }
	err = h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path, Hold: hold})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "a terminal is open in it; --force removes it anyway") {
		t.Fatalf("held: RemoveWorktree = %v", err)
	}
	if _, ok := h.store.Snapshot().Worktree(r.ID, w.Path); !ok {
		t.Fatal("held worktree removed")
	}
	if err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path, Hold: hold, Force: true}); err != nil {
		t.Fatalf("held, forced: %v", err)
	}
}
