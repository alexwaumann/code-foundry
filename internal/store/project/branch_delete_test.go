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
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "checked"}); err != nil {
		t.Fatal(err)
	}

	// In order: each step sees the ones before.
	steps := []struct {
		name    string
		o       DeleteBranchOptions
		want    DeleteBranchResult
		wantErr error
	}{
		{name: "merged", o: DeleteBranchOptions{Branch: "merged"}, want: DeleteBranchResult{Local: true}},
		{name: "unmerged without force", o: DeleteBranchOptions{Branch: "unmerged"}, wantErr: ErrFailedPrecondition},
		{name: "unmerged with force", o: DeleteBranchOptions{Branch: "unmerged", Force: true}, want: DeleteBranchResult{Local: true}},
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
		if !errors.Is(err, s.wantErr) || got != s.want {
			t.Fatalf("%s: DeleteBranch = %+v, %v; want %+v, %v", s.name, got, err, s.want, s.wantErr)
		}
	}
	for _, b := range []string{"merged", "unmerged", "pushed"} {
		if out := git(t, f.project, "branch", "--list", b); out != "" {
			t.Errorf("branch %s still here: %q", b, out)
		}
	}
	heads := strings.Fields(git(t, f.project, "ls-remote", "--heads", "origin"))
	if !slices.Contains(heads, "refs/heads/main") || slices.Contains(heads, "refs/heads/pushed") || slices.Contains(heads, "refs/heads/remote-only") {
		t.Errorf("origin heads = %q", heads)
	}
	if _, err := h.store.DeleteBranch(ctx, DeleteBranchOptions{ProjectID: "nope", Branch: "x"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown project: %v", err)
	}
}
