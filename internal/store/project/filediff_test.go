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

// side is what a test expects of one FileVersion.
type side struct {
	present, truncated, binary bool
	contents                   string // compared when present and not truncated
	size                       int    // len(contents) when truncated
}

func checkSide(t *testing.T, which string, got FileVersion, want side) {
	t.Helper()
	if got.Present != want.present || got.Truncated != want.truncated || got.Binary != want.binary {
		t.Errorf("%s: present/truncated/binary = %t/%t/%t, want %t/%t/%t", which,
			got.Present, got.Truncated, got.Binary, want.present, want.truncated, want.binary)
	}
	switch {
	case want.truncated && len(got.Contents) != want.size:
		t.Errorf("%s: len(contents) = %d, want %d", which, len(got.Contents), want.size)
	case !want.truncated && string(got.Contents) != want.contents:
		t.Errorf("%s: contents = %q, want %q", which, got.Contents, want.contents)
	}
}

func TestWorktreeFileDiff(t *testing.T) {
	f := newFixture(t)
	big := strings.Repeat("0123456789abcdef", FileDiffMax/16+4)
	writeFile(t, filepath.Join(f.project, "keep.txt"), "keep\n")
	writeFile(t, filepath.Join(f.project, "old-name.txt"), "renamed body\n")
	writeFile(t, filepath.Join(f.project, "gone.txt"), "gone\n")
	writeFile(t, filepath.Join(f.project, "big.txt"), big)
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "base files")
	git(t, f.project, "push", "-q")
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/diff"})
	if err != nil {
		t.Fatal(err)
	}
	p := wt.Path
	// Committed on the branch: an edit, a rename, a binary file, a bigger big file.
	writeFile(t, filepath.Join(p, "README.md"), "hello\nbranch\n")
	git(t, p, "mv", "old-name.txt", "new-name.txt")
	writeFile(t, filepath.Join(p, "logo.bin"), "\x89PNG\x00\x01")
	writeFile(t, filepath.Join(p, "big.txt"), big+"more\n")
	git(t, p, "add", ".")
	git(t, p, "commit", "-q", "-m", "branch work")
	// Uncommitted: README edited again, gone.txt deleted, an untracked file.
	writeFile(t, filepath.Join(p, "README.md"), "hello\nbranch\ndirty\n")
	mustRemove(t, filepath.Join(p, "gone.txt"))
	writeFile(t, filepath.Join(p, "new.txt"), "untracked\n")

	head := git(t, p, "rev-parse", "HEAD")
	base := git(t, f.project, "rev-parse", "origin/main")
	present := func(s string) side { return side{present: true, contents: s} }
	tests := []struct {
		name, file, oldPath string
		scope               DiffScope
		old, new            side
		status              string
	}{
		{name: "working dirty", file: "README.md", scope: DiffWorking,
			old: present("hello\n"), new: present("hello\nbranch\ndirty\n"), status: "M"},
		{name: "branch dirty", file: "README.md", scope: DiffBranch,
			old: present("hello\n"), new: present("hello\nbranch\n"), status: "M"},
		{name: "unchanged", file: "keep.txt", scope: DiffWorking,
			old: present("keep\n"), new: present("keep\n"), status: ""},
		{name: "untracked", file: "new.txt", scope: DiffWorking,
			new: present("untracked\n"), status: "A"},
		{name: "untracked on branch", file: "new.txt", scope: DiffBranch, status: ""},
		{name: "renamed", file: "new-name.txt", oldPath: "old-name.txt", scope: DiffBranch,
			old: present("renamed body\n"), new: present("renamed body\n"), status: "R"},
		{name: "deleted", file: "gone.txt", scope: DiffWorking,
			old: present("gone\n"), status: "D"},
		{name: "deleted only on disk", file: "gone.txt", scope: DiffBranch,
			old: present("gone\n"), new: present("gone\n"), status: ""},
		{name: "binary", file: "logo.bin", scope: DiffBranch,
			new: side{present: true, binary: true, contents: "\x89PNG\x00\x01"}, status: "A"},
		{name: "truncated", file: "big.txt", scope: DiffWorking,
			old:    side{present: true, truncated: true, size: FileDiffMax},
			new:    side{present: true, truncated: true, size: FileDiffMax},
			status: "M"},
		{name: "directory", file: "sub", scope: DiffWorking, status: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: r.ID, Path: p, File: tt.file, OldPath: tt.oldPath, Scope: tt.scope})
			if err != nil {
				t.Fatal(err)
			}
			if d.BaseRef != "origin/main" || d.MergeBase != base || d.Head != head || d.Error != "" {
				t.Errorf("base/merge base/head/error = %q/%q/%q/%q, want origin/main/%s/%s/\"\"", d.BaseRef, d.MergeBase, d.Head, d.Error, base, head)
			}
			checkSide(t, "old", d.Old, tt.old)
			checkSide(t, "new", d.New, tt.new)
			if d.Status != tt.status {
				t.Errorf("status = %q, want %q", d.Status, tt.status)
			}
		})
	}

	for _, bad := range []string{"", "../escape.txt", "/etc/passwd", "sub/../../x"} {
		_, err := h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: r.ID, Path: p, File: bad})
		if !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("file %q: err = %v, want ErrInvalidArgument", bad, err)
		}
	}
	_, err = h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: r.ID, Path: filepath.Join(f.base, "nope"), File: "README.md"})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown worktree: err = %v, want ErrNotFound", err)
	}
}

// TestWorktreeFileDiffNoBase: a repository without a remote, on its default branch,
// has no base. WORKING compares with HEAD, as the detail's file list does; BRANCH says
// why it cannot compare. An unborn branch compares with the empty tree.
func TestWorktreeFileDiffNoBase(t *testing.T) {
	isolateGit(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(dir, "solo")
	git(t, dir, "init", "-q", "-b", "main", repo)
	writeFile(t, filepath.Join(repo, "a.txt"), "one\n")
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "init")
	writeFile(t, filepath.Join(repo, "a.txt"), "one\ntwo\n")
	unborn := filepath.Join(dir, "fresh")
	git(t, dir, "init", "-q", "-b", "main", unborn)
	writeFile(t, filepath.Join(unborn, "b.txt"), "b\n")

	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	ru, err := h.store.Register(ctx, unborn)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, projectID, path, file string
		scope                       DiffScope
		old, new                    side
		status, err                 string
	}{
		{name: "working against HEAD", projectID: r.ID, path: repo, file: "a.txt", scope: DiffWorking,
			old: side{present: true, contents: "one\n"}, new: side{present: true, contents: "one\ntwo\n"}, status: "M"},
		{name: "branch without base", projectID: r.ID, path: repo, file: "a.txt", scope: DiffBranch,
			err: "the worktree has no base branch to compare with"},
		{name: "unborn working", projectID: ru.ID, path: unborn, file: "b.txt", scope: DiffWorking,
			new: side{present: true, contents: "b\n"}, status: "A"},
		{name: "unborn branch", projectID: ru.ID, path: unborn, file: "b.txt", scope: DiffBranch,
			err: "the branch has no commits yet"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := h.store.WorktreeFileDiff(ctx, FileDiffRequest{ProjectID: tt.projectID, Path: tt.path, File: tt.file, Scope: tt.scope})
			if err != nil {
				t.Fatal(err)
			}
			if d.BaseRef != "" || d.MergeBase != "" || d.Error != tt.err {
				t.Errorf("base/merge base/error = %q/%q/%q, want \"\"/\"\"/%q", d.BaseRef, d.MergeBase, d.Error, tt.err)
			}
			checkSide(t, "old", d.Old, tt.old)
			checkSide(t, "new", d.New, tt.new)
			if d.Status != tt.status {
				t.Errorf("status = %q, want %q", d.Status, tt.status)
			}
		})
	}
}

// TestReadWorktreeFileSymlinks: a symlink reads as its target, as git stores it, and a
// path through a symlinked directory leaving the worktree is not read.
func TestReadWorktreeFileSymlinks(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	wt, out := filepath.Join(dir, "wt"), filepath.Join(dir, "out")
	for _, d := range []string{wt, out} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(out, "secret"), "no\n")
	if err := os.Symlink("../out/secret", filepath.Join(wt, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(wt, "dirlink")); err != nil {
		t.Fatal(err)
	}
	v, err := readWorktreeFile(wt, "link")
	if err != nil || !v.Present || string(v.Contents) != "../out/secret" {
		t.Errorf("link = %+v, %v; want its target", v, err)
	}
	v, err = readWorktreeFile(wt, "dirlink/secret")
	if err != nil || v.Present {
		t.Errorf("dirlink/secret = %+v, %v; want not present", v, err)
	}
}
