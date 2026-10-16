package repo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestReadOperation(t *testing.T) {
	tests := []struct {
		name  string
		files map[string]string // relative path -> contents; a trailing "/" makes a dir
		want  operationInfo
	}{
		{"nothing in progress", nil, operationInfo{}},
		{"unrelated files only", map[string]string{"HEAD": "ref: refs/heads/main\n", "ORIG_HEAD": "abc\n", "MERGE_MSG": "x\n"}, operationInfo{}},
		{"rebase merge backend", map[string]string{
			"rebase-merge/msgnum": "3\n", "rebase-merge/end": "6\n",
			"rebase-merge/onto": "0123abc\n", "rebase-merge/head-name": "refs/heads/feature\n",
		}, operationInfo{Op: OpRebase, Step: 3, Total: 6}},
		{"rebase merge backend before the first pick", map[string]string{"rebase-merge/": ""}, operationInfo{Op: OpRebase}},
		{"rebase merge backend with garbage counters", map[string]string{
			"rebase-merge/msgnum": "x", "rebase-merge/end": "-2",
		}, operationInfo{Op: OpRebase}},
		{"rebase apply backend", map[string]string{
			"rebase-apply/next": "2\n", "rebase-apply/last": "4\n", "rebase-apply/rebasing": "",
		}, operationInfo{Op: OpRebase, Step: 2, Total: 4}},
		{"am", map[string]string{
			"rebase-apply/next": "1\n", "rebase-apply/last": "5\n", "rebase-apply/applying": "",
		}, operationInfo{Op: OpAm, Step: 1, Total: 5}},
		{"rebase wins over a merge step", map[string]string{
			"rebase-merge/msgnum": "2", "rebase-merge/end": "2", "MERGE_HEAD": "abc\n",
		}, operationInfo{Op: OpRebase, Step: 2, Total: 2}},
		{"a rebase-merge file is not a rebase", map[string]string{"rebase-merge": "stray"}, operationInfo{}},
		{"merge", map[string]string{"MERGE_HEAD": "abc\n"}, operationInfo{Op: OpMerge}},
		{"cherry-pick", map[string]string{"CHERRY_PICK_HEAD": "abc\n"}, operationInfo{Op: OpCherryPick}},
		{"revert", map[string]string{"REVERT_HEAD": "abc\n"}, operationInfo{Op: OpRevert}},
		{"bisect", map[string]string{"BISECT_LOG": "git bisect start\n"}, operationInfo{Op: OpBisect}},
		{"merge wins over bisect", map[string]string{"MERGE_HEAD": "abc\n", "BISECT_LOG": "x"}, operationInfo{Op: OpMerge}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for rel, body := range tt.files {
				p := filepath.Join(dir, rel)
				if rel[len(rel)-1] == '/' {
					mustMkdir(t, p)
					continue
				}
				mustMkdir(t, filepath.Dir(p))
				if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := readOperation(dir); got != tt.want {
				t.Errorf("readOperation = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestReadOperationNoAdminDir(t *testing.T) {
	if got := readOperation(""); got != (operationInfo{}) {
		t.Errorf(`readOperation("") = %+v, want zero`, got)
	}
	if got := readOperation(filepath.Join(t.TempDir(), "missing")); got != (operationInfo{}) {
		t.Errorf("readOperation(missing) = %+v, want zero", got)
	}
}

func TestWorktreeAdminDir(t *testing.T) {
	main := t.TempDir()
	mustMkdir(t, filepath.Join(main, ".git"))
	linked := t.TempDir()
	admin := filepath.Join(main, ".git", "worktrees", "linked")
	if err := os.WriteFile(filepath.Join(linked, ".git"), []byte("gitdir: "+admin+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, path, want string
	}{
		{"main worktree", main, filepath.Join(main, ".git")},
		{"linked worktree", linked, admin},
		{"no .git", t.TempDir(), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := worktreeAdminDir(tt.path); got != tt.want {
				t.Errorf("worktreeAdminDir = %q, want %q", got, tt.want)
			}
		})
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestOperationStateThroughWatcher runs real conflicting operations with the poll
// disabled, so each change is seen through the admin dir watches alone.
func TestOperationStateThroughWatcher(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt")})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}

	// feat: two commits, the first touching README. main: a conflicting README change.
	writeFile(t, filepath.Join(w.Path, "README.md"), "feat\n")
	git(t, w.Path, "commit", "-q", "-am", "feat 1")
	writeFile(t, filepath.Join(w.Path, "f.txt"), "f\n")
	git(t, w.Path, "add", "f.txt")
	git(t, w.Path, "commit", "-q", "-m", "feat 2")
	writeFile(t, filepath.Join(f.repo, "README.md"), "main\n")
	git(t, f.repo, "commit", "-q", "-am", "main change")

	// Linked worktree: rebase stops on the first of two picks.
	gitFails(t, w.Path, "rebase", "main")
	h.waitFor("rebase in progress", worktreeUpdated(w.Path, func(w Worktree) bool {
		s := w.Status
		return s.Operation == OpRebase && s.OperationStep == 1 && s.OperationTotal == 2 && s.Conflicted == 1
	}))
	git(t, w.Path, "rebase", "--abort")
	h.waitFor("rebase cleared", worktreeUpdated(w.Path, func(w Worktree) bool {
		return w.Status.Operation == "" && w.Status.OperationStep == 0 && w.Branch == "feat"
	}))

	// Main worktree: a conflicting merge.
	gitFails(t, f.repo, "merge", "feat")
	h.waitFor("merge in progress", worktreeUpdated(f.repo, func(w Worktree) bool {
		return w.Status.Operation == OpMerge && w.Status.OperationTotal == 0 && w.Status.Conflicted == 1
	}))
	git(t, f.repo, "merge", "--abort")
	h.waitFor("merge cleared", worktreeUpdated(f.repo, func(w Worktree) bool {
		return w.Status.Operation == "" && w.Status.Conflicted == 0
	}))
}

// gitFails runs a git command that is expected to stop with a non-zero exit (a
// conflict).
func gitFails(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("git %v succeeded, want a conflict:\n%s", args, out)
	}
}
