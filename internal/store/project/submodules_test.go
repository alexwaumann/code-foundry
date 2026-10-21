package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A worktree with an initialized submodule is removed when nothing in it would be
// lost; a modified submodule is uncommitted work, and a submodule commit its remote
// lacks keeps git's refusal (fuzz finding git 8).
func TestRemoveWorktreeWithSubmodules(t *testing.T) {
	f := newFixture(t)
	subOrigin := filepath.Join(f.base, "lib.git")
	git(t, f.base, "init", "-q", "--bare", "-b", "main", subOrigin)
	seed := filepath.Join(f.base, "lib-seed")
	git(t, f.base, "clone", "-q", subOrigin, seed)
	writeFile(t, filepath.Join(seed, "lib.txt"), "lib\n")
	git(t, seed, "add", ".")
	git(t, seed, "commit", "-q", "-m", "lib")
	git(t, seed, "push", "-q", "origin", "main")
	git(t, f.project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", subOrigin, "lib")
	git(t, f.project, "commit", "-q", "-m", "add lib")
	git(t, f.project, "push", "-q", "origin", "main")

	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	mk := func(branch string, change func(dir string)) Worktree {
		t.Helper()
		w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: branch})
		if err != nil {
			t.Fatal(err)
		}
		git(t, w.Path, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init")
		if change != nil {
			change(w.Path)
		}
		return w
	}
	tests := []struct {
		name        string
		change      func(dir string)
		uncommitted bool
		wantRemoved bool
	}{
		{name: "clean", wantRemoved: true},
		{name: "modified", uncommitted: true, change: func(dir string) {
			writeFile(t, filepath.Join(dir, "lib", "lib.txt"), "changed\n")
		}},
		{name: "unpushed", change: func(dir string) {
			lib := filepath.Join(dir, "lib")
			writeFile(t, filepath.Join(lib, "lib.txt"), "changed\n")
			git(t, lib, "commit", "-q", "-am", "only here")
			git(t, dir, "commit", "-q", "-am", "bump lib")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := mk("sub-"+tt.name, tt.change)
			err := h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{ProjectID: r.ID, Path: w.Path})
			var ue *UncommittedError
			switch {
			case tt.wantRemoved && err != nil:
				t.Fatalf("RemoveWorktree = %v", err)
			case tt.uncommitted && !errors.As(err, &ue):
				t.Fatalf("RemoveWorktree = %v; want uncommitted work", err)
			case !tt.wantRemoved && !tt.uncommitted && (!errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "submodules")):
				t.Fatalf("RemoveWorktree = %v; want git's refusal", err)
			}
			if _, err := os.Stat(w.Path); (err == nil) == tt.wantRemoved {
				t.Errorf("worktree on disk = %v; want removed %v", err == nil, tt.wantRemoved)
			}
		})
	}
}
