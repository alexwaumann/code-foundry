package project

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
)

var (
	sourceWorking = DiffSource{Kind: SourceWorkingTree}
	sourceStaged  = DiffSource{Kind: SourceStaged}
)

func sourceRef(ref string) DiffSource { return DiffSource{Kind: SourceRef, Ref: ref} }

// row is a CompareChange as a test writes it.
func row(c CompareChange) string {
	s := fmt.Sprintf("%s %s", c.Status, c.Path)
	if c.OldPath != "" {
		s += " <- " + c.OldPath
	}
	s += fmt.Sprintf(" +%d -%d", c.Added, c.Deleted)
	if c.Binary {
		s += " binary"
	}
	if c.Submodule {
		s += " submodule"
	}
	return s
}

func rows(list []CompareChange) []string {
	out := make([]string, len(list))
	for i, c := range list {
		out[i] = row(c)
	}
	return out
}

func ctx20(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// compareFixture is a project with a worktree on feat/x: committed on the branch, a
// modified file, a rename, a binary and a removal; staged, one edit; unstaged, another;
// and one untracked file.
type compareFixture struct {
	h        *harness
	id, path string
	fixture
}

func newCompareFixture(t *testing.T) compareFixture {
	t.Helper()
	return newCompareFixtureWith(t, Options{})
}

func newCompareFixtureWith(t *testing.T, opts Options) compareFixture {
	t.Helper()
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "keep.txt"), "one\ntwo\nthree\n")
	writeFile(t, filepath.Join(f.project, "old-name.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n")
	writeFile(t, filepath.Join(f.project, "gone.txt"), "gone\n")
	writeFile(t, filepath.Join(f.project, "stage.txt"), "s\n")
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "base files")
	git(t, f.project, "push", "-q")
	h := startHarness(t, "", opts)
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/x"})
	if err != nil {
		t.Fatal(err)
	}
	p := wt.Path
	writeFile(t, filepath.Join(p, "keep.txt"), "one\nTWO\nthree\n")
	git(t, p, "mv", "old-name.txt", "new-name.txt")
	git(t, p, "rm", "-q", "gone.txt")
	writeFile(t, filepath.Join(p, "logo.bin"), "\x89PNG\x00\x01")
	git(t, p, "add", ".")
	git(t, p, "commit", "-q", "-m", "branch work")
	writeFile(t, filepath.Join(p, "stage.txt"), "staged\n")
	git(t, p, "add", "stage.txt")
	writeFile(t, filepath.Join(p, "stage.txt"), "staged\nand unstaged\n")
	writeFile(t, filepath.Join(p, "new.txt"), "n1\nn2\n")
	return compareFixture{h: h, id: r.ID, path: p, fixture: f}
}

func (f compareFixture) compare(t *testing.T, base, head DiffSource, paths ...string) WorktreeCompare {
	t.Helper()
	c, err := f.h.store.CompareWorktree(ctx20(t), CompareRequest{ProjectID: f.id, Path: f.path, Base: base, Head: head, Paths: paths})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (f compareFixture) sides(t *testing.T, base, head DiffSource, file, oldPath string) CompareSides {
	t.Helper()
	c, err := f.h.store.CompareFile(ctx20(t), CompareFileRequest{ProjectID: f.id, Path: f.path, Base: base, Head: head, File: file, OldPath: oldPath})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCompareWorktreeSources(t *testing.T) {
	f := newCompareFixture(t)
	mergeBase := DiffSource{Kind: SourceMergeBase}
	committed := []string{"D gone.txt +0 -1", "M keep.txt +1 -1", "A logo.bin +0 -0 binary", "R new-name.txt <- old-name.txt +0 -0"}
	tests := []struct {
		name       string
		base, head DiffSource
		want       []string
	}{
		{"merge base to working tree", mergeBase, sourceWorking, append(slices.Clone(committed[:3]), []string{"R new-name.txt <- old-name.txt +0 -0", "? new.txt +2 -0", "M stage.txt +2 -1"}...)},
		{"merge base to staged", mergeBase, sourceStaged, append(slices.Clone(committed), "M stage.txt +1 -1")},
		{"ref to ref", sourceRef("origin/main"), sourceRef("HEAD"), committed},
		{"ref to ref, the other way", sourceRef("HEAD"), sourceRef("origin/main"), []string{
			"A gone.txt +1 -0", "M keep.txt +1 -1", "D logo.bin +0 -0 binary", "R old-name.txt <- new-name.txt +0 -0",
		}},
		{"staged to working tree", sourceStaged, sourceWorking, []string{"? new.txt +2 -0", "M stage.txt +1 -0"}},
		{"working tree to staged", sourceWorking, sourceStaged, []string{"D new.txt +0 -2", "M stage.txt +0 -1"}},
		{"ref to staged", sourceRef("HEAD"), sourceStaged, []string{"M stage.txt +1 -1"}},
		{"staged to ref", sourceStaged, sourceRef("HEAD"), []string{"M stage.txt +1 -1"}},
		{"working tree to ref", sourceWorking, sourceRef("HEAD"), []string{"D new.txt +0 -2", "M stage.txt +1 -2"}},
		{"a sha and a revision", sourceRef("HEAD~1"), sourceRef("HEAD"), committed},
		{"a side against itself: working tree", sourceWorking, sourceWorking, []string{}},
		{"a side against itself: staged", sourceStaged, sourceStaged, []string{}},
		{"a side against itself: ref", sourceRef("HEAD"), sourceRef("HEAD"), []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := f.compare(t, tt.base, tt.head)
			if c.Error != "" {
				t.Fatalf("Error = %q", c.Error)
			}
			if got := rows(c.Files); !slices.Equal(got, tt.want) {
				t.Errorf("files =\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(tt.want, "\n  "))
			}
		})
	}
}

// TestCompareWorktreeDefaultMatchesDetail: unset sources list what the Changes list did.
func TestCompareWorktreeDefaultMatchesDetail(t *testing.T) {
	f := newCompareFixture(t)
	ctx := ctx20(t)
	if err := f.h.store.Refresh(ctx, f.id); err != nil {
		t.Fatal(err)
	}
	d, err := f.h.store.WorktreeDetail(ctx, f.id, f.path)
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Head: sourceWorking})
	if err != nil {
		t.Fatal(err)
	}
	var want, got []string
	for _, x := range d.Files {
		want = append(want, x.Path)
	}
	for _, x := range c.Files {
		got = append(got, x.Path)
	}
	if !slices.Equal(got, want) {
		t.Errorf("compare lists %v, detail %v", got, want)
	}
	if c.BaseRef != d.BaseRef || c.MergeBase != d.MergeBase || c.Base.Label != d.BaseRef || c.Base.SHA != d.MergeBase {
		t.Errorf("base = %+v %q %q, detail %q %q", c.Base, c.BaseRef, c.MergeBase, d.BaseRef, d.MergeBase)
	}
	if c.Head.Label != "Working tree" || c.Head.SHA != "" {
		t.Errorf("head = %+v", c.Head)
	}
	if c.TotalFiles != len(c.Files) || c.TotalAdded != 5 || c.TotalDeleted != 3 {
		t.Errorf("totals = %d +%d -%d", c.TotalFiles, c.TotalAdded, c.TotalDeleted)
	}
}

func TestCompareWorktreePaths(t *testing.T) {
	f := newCompareFixture(t)
	if err := os.MkdirAll(filepath.Join(f.path, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.path, "dir", "in.txt"), "x\n")
	writeFile(t, filepath.Join(f.path, "dirt.txt"), "x\n")
	tests := []struct {
		name  string
		paths []string
		want  []string
	}{
		{"one file", []string{"keep.txt"}, []string{"keep.txt"}},
		{"two files", []string{"keep.txt", "gone.txt"}, []string{"gone.txt", "keep.txt"}},
		{"a directory, not its prefix", []string{"dir"}, []string{"dir/in.txt"}},
		{"a directory written with a slash", []string{"dir/"}, []string{"dir/in.txt"}},
		{"a rename by its new path", []string{"new-name.txt"}, []string{"new-name.txt"}},
		{"a rename by its old path", []string{"old-name.txt"}, []string{"new-name.txt"}},
		{"nothing there", []string{"absent.txt"}, []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := f.compare(t, DiffSource{}, sourceWorking, tt.paths...)
			got := []string{}
			for _, x := range c.Files {
				got = append(got, x.Path)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("paths = %v, want %v", got, tt.want)
			}
			if c.TotalFiles != len(tt.want) {
				t.Errorf("TotalFiles = %d, want %d", c.TotalFiles, len(tt.want))
			}
		})
	}
	if c := f.compare(t, DiffSource{}, sourceWorking, "new-name.txt"); len(c.Files) != 1 || c.Files[0].OldPath != "old-name.txt" {
		t.Errorf("a rename asked for by path lost its source: %+v", c.Files)
	}
}

func TestCompareFileSides(t *testing.T) {
	f := newCompareFixture(t)
	mergeBase := DiffSource{}
	tests := []struct {
		name          string
		base, head    DiffSource
		file, oldPath string
		status        string
		old, new      side
	}{
		{"modified, base to disk", mergeBase, sourceWorking, "keep.txt", "", "M",
			side{present: true, contents: "one\ntwo\nthree\n"}, side{present: true, contents: "one\nTWO\nthree\n"}},
		{"renamed", mergeBase, sourceWorking, "new-name.txt", "old-name.txt", "R",
			side{present: true, contents: "a\nb\nc\nd\ne\nf\ng\nh\n"}, side{present: true, contents: "a\nb\nc\nd\ne\nf\ng\nh\n"}},
		{"deleted", mergeBase, sourceWorking, "gone.txt", "", "D", side{present: true, contents: "gone\n"}, side{}},
		{"untracked", mergeBase, sourceWorking, "new.txt", "", "A", side{}, side{present: true, contents: "n1\nn2\n"}},
		{"binary", mergeBase, sourceWorking, "logo.bin", "", "A", side{}, side{present: true, binary: true, contents: "\x89PNG\x00\x01"}},
		{"index to disk", sourceStaged, sourceWorking, "stage.txt", "", "M",
			side{present: true, contents: "staged\n"}, side{present: true, contents: "staged\nand unstaged\n"}},
		{"ref to index", sourceRef("HEAD"), sourceStaged, "stage.txt", "", "M",
			side{present: true, contents: "s\n"}, side{present: true, contents: "staged\n"}},
		{"disk to ref, reversed", sourceWorking, sourceRef("HEAD"), "stage.txt", "", "M",
			side{present: true, contents: "staged\nand unstaged\n"}, side{present: true, contents: "s\n"}},
		{"the same both sides", sourceRef("HEAD"), sourceRef("HEAD"), "keep.txt", "", "",
			side{present: true, contents: "one\nTWO\nthree\n"}, side{present: true, contents: "one\nTWO\nthree\n"}},
		{"on neither side", sourceRef("HEAD"), sourceWorking, "absent.txt", "", "", side{}, side{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := f.sides(t, tt.base, tt.head, tt.file, tt.oldPath)
			if d.Status != tt.status || d.Error != "" {
				t.Errorf("status %q error %q, want %q", d.Status, d.Error, tt.status)
			}
			checkSide(t, "old", d.Old, tt.old)
			checkSide(t, "new", d.New, tt.new)
		})
	}
}

// TestCompareHugeFiles: a file past the cap is listed with its counts and read cut short,
// on the disk side and the git side alike; past blobReadMax git's side has no contents.
func TestCompareHugeFiles(t *testing.T) {
	f := newCompareFixture(t)
	big := strings.Repeat("0123456789abcde\n", FileDiffMax/16+4)
	huge := strings.Repeat("0123456789abcde\n", blobReadMax/16+4)
	writeFile(t, filepath.Join(f.path, "big.txt"), big)
	writeFile(t, filepath.Join(f.path, "huge.txt"), huge)
	git(t, f.path, "add", "big.txt", "huge.txt")
	git(t, f.path, "commit", "-q", "-m", "big")
	writeFile(t, filepath.Join(f.path, "big.txt"), big+"more\n")

	c := f.compare(t, sourceRef("HEAD"), sourceWorking, "big.txt")
	if got := rows(c.Files); !slices.Equal(got, []string{"M big.txt +1 -0"}) {
		t.Errorf("files = %v", got)
	}
	d := f.sides(t, sourceRef("HEAD"), sourceWorking, "big.txt", "")
	checkSide(t, "old", d.Old, side{present: true, truncated: true, size: FileDiffMax})
	checkSide(t, "new", d.New, side{present: true, truncated: true, size: FileDiffMax})
	if d.Status != "M" {
		t.Errorf("status = %q", d.Status)
	}
	d = f.sides(t, sourceRef("HEAD"), sourceRef("HEAD"), "huge.txt", "")
	checkSide(t, "huge", d.New, side{present: true, truncated: true, size: 0})
}

func TestWorktreeCompareFillCaps(t *testing.T) {
	list := []CompareChange{{Path: "c", Added: 1}, {Path: "a", Added: 2, Deleted: 5}, {Path: "b", Added: 3}}
	var w WorktreeCompare
	w.fill(list, nil, 2)
	if !w.Truncated || len(w.Files) != 2 || w.Files[0].Path != "a" || w.Files[1].Path != "b" {
		t.Errorf("listed %+v truncated %t", w.Files, w.Truncated)
	}
	if w.TotalFiles != 3 || w.TotalAdded != 6 || w.TotalDeleted != 5 {
		t.Errorf("totals %d +%d -%d count only what is listed", w.TotalFiles, w.TotalAdded, w.TotalDeleted)
	}
}

// TestCompareSubmodule: a submodule moved in the working tree is one row, its sides the
// commits; recorded in a commit, and not initialized, it still reads as the recorded one.
func TestCompareSubmodule(t *testing.T) {
	f := newCompareFixture(t)
	lib := filepath.Join(f.base, "lib")
	git(t, f.base, "init", "-q", "-b", "main", lib)
	writeFile(t, filepath.Join(lib, "lib.txt"), "v1\n")
	git(t, lib, "add", ".")
	git(t, lib, "commit", "-q", "-m", "one")
	first := strings.TrimSpace(git(t, lib, "rev-parse", "HEAD"))
	git(t, f.path, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", lib, "vendor/lib")
	git(t, f.path, "commit", "-q", "-m", "submodule")
	sub := filepath.Join(f.path, "vendor", "lib")
	writeFile(t, filepath.Join(sub, "lib.txt"), "v2\n")
	git(t, sub, "commit", "-q", "-am", "two")
	second := strings.TrimSpace(git(t, sub, "rev-parse", "HEAD"))

	c := f.compare(t, sourceRef("HEAD"), sourceWorking, "vendor/lib")
	if len(c.Files) != 1 || !c.Files[0].Submodule || c.Files[0].Status != "M" {
		t.Fatalf("files = %v", rows(c.Files))
	}
	d := f.sides(t, sourceRef("HEAD"), sourceWorking, "vendor/lib", "")
	if d.Status != "M" || !d.Old.Submodule || !d.New.Submodule {
		t.Errorf("sides = %+v", d)
	}
	if want := "Subproject commit " + first + "\n"; string(d.Old.Contents) != want {
		t.Errorf("old = %q, want %q", d.Old.Contents, want)
	}
	if want := "Subproject commit " + second + "\n"; string(d.New.Contents) != want {
		t.Errorf("new = %q, want %q", d.New.Contents, want)
	}
	// A directory with no .git must not answer with the worktree's own HEAD.
	if err := os.RemoveAll(sub); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	d = f.sides(t, sourceRef("HEAD"), sourceWorking, "vendor/lib", "")
	if want := "Subproject commit " + first + "\n"; string(d.New.Contents) != want || d.Status != "" {
		t.Errorf("not initialized: new = %q status %q, want %q", d.New.Contents, d.Status, want)
	}
}

// TestCompareDeletedRef: a ref a tab remembers can go; that is an answer, not a failure,
// and it says which.
func TestCompareDeletedRef(t *testing.T) {
	f := newCompareFixture(t)
	git(t, f.path, "branch", "soon-gone", "HEAD")
	if c := f.compare(t, sourceRef("soon-gone"), sourceRef("HEAD")); c.Error != "" {
		t.Fatalf("before: %q", c.Error)
	}
	git(t, f.path, "branch", "-D", "soon-gone")
	for _, tt := range []struct {
		name       string
		base, head DiffSource
		want       string
	}{
		{"base", sourceRef("soon-gone"), sourceWorking, "soon-gone does not name a commit"},
		{"head", sourceStaged, sourceRef("soon-gone"), "soon-gone does not name a commit"},
		{"past the reflog", sourceRef("HEAD@{9999}"), sourceWorking, "HEAD@{9999} does not name a commit"},
		{"not a commit", sourceRef("HEAD^{tree}"), sourceWorking, "does not name a commit"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := f.compare(t, tt.base, tt.head)
			if !strings.Contains(c.Error, tt.want) || len(c.Files) != 0 {
				t.Errorf("Error = %q files %v, want %q and no files", c.Error, c.Files, tt.want)
			}
			if c.Base.Label == "" || c.Head.Label == "" {
				t.Errorf("labels = %+v %+v: a caller still shows both sides", c.Base, c.Head)
			}
			if d := f.sides(t, tt.base, tt.head, "keep.txt", ""); !strings.Contains(d.Error, tt.want) || d.Old.Present || d.New.Present {
				t.Errorf("sides = %+v", d)
			}
		})
	}
}

// TestCompareMidRebase: a stopped rebase has a detached HEAD and unmerged paths. Those
// list once, as U, on every side that reads the index, and each side still reads.
func TestCompareMidRebase(t *testing.T) {
	f := newCompareFixture(t)
	git(t, f.path, "checkout", "-q", "--", "stage.txt")
	git(t, f.path, "reset", "-q", "--hard", "HEAD")
	if err := os.Remove(filepath.Join(f.path, "new.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(f.project, "keep.txt"), "one\nMAIN\nthree\n")
	git(t, f.project, "commit", "-q", "-am", "main moves")
	rebase := exec.Command("git", "rebase", "main")
	rebase.Dir = f.path
	if err := rebase.Run(); err == nil {
		t.Fatal("rebase should have stopped on a conflict")
	}

	for _, tt := range []struct {
		name       string
		base, head DiffSource
	}{
		{"commit to disk", sourceRef("HEAD"), sourceWorking},
		{"commit to index", sourceRef("HEAD"), sourceStaged},
		{"index to disk", sourceStaged, sourceWorking},
		{"merge base to disk", DiffSource{}, sourceWorking},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c := f.compare(t, tt.base, tt.head)
			if c.Error != "" {
				t.Fatalf("Error = %q", c.Error)
			}
			var hits []CompareChange
			for _, x := range c.Files {
				if x.Path == "keep.txt" {
					hits = append(hits, x)
				}
			}
			if len(hits) != 1 || hits[0].Status != "U" {
				t.Fatalf("keep.txt = %v in %v", rows(hits), rows(c.Files))
			}
		})
	}
	d := f.sides(t, sourceStaged, sourceWorking, "keep.txt", "")
	checkSide(t, "ours", d.Old, side{present: true, contents: "one\nMAIN\nthree\n"})
	if !strings.Contains(string(d.New.Contents), "<<<<<<<") {
		t.Errorf("disk side = %q, want the conflict markers", d.New.Contents)
	}
	// Refs mean what they did: no index is involved, so nothing is unmerged.
	c := f.compare(t, sourceRef("main"), sourceRef("feat/x"), "keep.txt")
	if got := rows(c.Files); !slices.Equal(got, []string{"M keep.txt +1 -1"}) {
		t.Errorf("refs = %v", got)
	}
}

// TestCompareNoBaseAndUnborn: without a base the merge base side is HEAD, and on an
// unborn branch the empty tree, where HEAD as a ref names nothing.
func TestCompareNoBaseAndUnborn(t *testing.T) {
	isolateGit(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "solo")
	git(t, dir, "init", "-q", "-b", "main", p)
	writeFile(t, filepath.Join(p, "a.txt"), "a\n")
	h := startHarness(t, "", Options{})
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	c, err := h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: p, Head: sourceWorking})
	if err != nil {
		t.Fatal(err)
	}
	if got := rows(c.Files); !slices.Equal(got, []string{"? a.txt +1 -0"}) || c.Base.SHA != emptyTree || c.Base.Label != "HEAD" {
		t.Errorf("unborn: %v base %+v", got, c.Base)
	}
	c, err = h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: p, Base: sourceRef("HEAD"), Head: sourceWorking})
	if err != nil || !strings.Contains(c.Error, "HEAD does not name a commit") {
		t.Errorf("HEAD on unborn: %q, %v", c.Error, err)
	}
	git(t, p, "add", ".")
	git(t, p, "commit", "-q", "-m", "one")
	writeFile(t, filepath.Join(p, "a.txt"), "a\nb\n")
	c, err = h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: p, Head: sourceWorking})
	if err != nil {
		t.Fatal(err)
	}
	if got := rows(c.Files); !slices.Equal(got, []string{"M a.txt +1 -0"}) || c.BaseRef != "" || c.MergeBase != "" || c.Base.Label != "HEAD" {
		t.Errorf("no base: %v %+v %q %q", got, c.Base, c.BaseRef, c.MergeBase)
	}
}

// TestCompareSeveralCheckouts: a thread can own a checkout in each of several projects.
// Each is its own call, and a project cannot reach another's worktree.
func TestCompareSeveralCheckouts(t *testing.T) {
	f := newCompareFixture(t)
	ctx := ctx20(t)
	second := filepath.Join(f.base, "second")
	git(t, f.base, "init", "-q", "-b", "main", second)
	writeFile(t, filepath.Join(second, "b.txt"), "b\n")
	git(t, second, "add", ".")
	git(t, second, "commit", "-q", "-m", "one")
	writeFile(t, filepath.Join(second, "b.txt"), "B\n")
	r, err := f.h.store.Register(ctx, second)
	if err != nil {
		t.Fatal(err)
	}
	c, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: second, Head: sourceWorking})
	if err != nil {
		t.Fatal(err)
	}
	if got := rows(c.Files); !slices.Equal(got, []string{"M b.txt +1 -1"}) {
		t.Errorf("second project = %v", got)
	}
	if first := f.compare(t, DiffSource{}, sourceWorking); slices.ContainsFunc(first.Files, func(x CompareChange) bool { return x.Path == "b.txt" }) {
		t.Errorf("first project lists the second's file: %v", rows(first.Files))
	}
	for _, tt := range []struct{ name, id, path string }{
		{"another project's worktree", f.id, second},
		{"the other way", r.ID, f.path},
		{"unknown project", "nope", second},
		{"not a worktree", f.id, f.base},
		{"inside a worktree", f.id, filepath.Join(f.path, "sub")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: tt.id, Path: tt.path}); !errors.Is(err, ErrNotFound) {
				t.Errorf("CompareWorktree err = %v, want ErrNotFound", err)
			}
			if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{ProjectID: tt.id, Path: tt.path, File: "a"}); !errors.Is(err, ErrNotFound) {
				t.Errorf("CompareFile err = %v, want ErrNotFound", err)
			}
		})
	}
}

// TestCompareRefusals is the boundary: nothing here may become an option, a range or a
// path out of the checkout, and each refusal comes before git runs.
func TestCompareRefusals(t *testing.T) {
	f := newCompareFixture(t)
	ctx := ctx20(t)
	canary := filepath.Join(f.base, "canary")
	refs := []struct{ name, ref string }{
		{"empty", ""},
		{"a short option", "-p"},
		{"a long option", "--all"},
		{"writes a file", "--output=" + canary},
		{"moves the repository", "--git-dir=/tmp"},
		{"ends options", "--end-of-options"},
		{"an exclusion", "^HEAD"},
		{"an exclusion of a sha", "^0123456789012345678901234567890123456789"},
		{"a range", "main..HEAD"},
		{"a symmetric range", "main...HEAD"},
		{"a path in a tree", "HEAD:README.md"},
		{"a search", ":/fix"},
		{"an index stage", ":0:README.md"},
		{"a glob", "refs/heads/*"},
		{"a question mark", "ma?n"},
		{"a bracket", "ma[i]n"},
		{"a backslash", `ma\in`},
		{"a space", "main HEAD"},
		{"a newline", "main\n--all"},
		{"a tab", "main\tHEAD"},
		{"a NUL", "main\x00--all"},
		{"too long", strings.Repeat("a", refMax+1)},
	}
	for _, tt := range refs {
		t.Run("ref/"+tt.name, func(t *testing.T) {
			for _, sides := range [][2]DiffSource{{sourceRef(tt.ref), sourceWorking}, {sourceWorking, sourceRef(tt.ref)}} {
				if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Base: sides[0], Head: sides[1]}); !errors.Is(err, ErrInvalidArgument) {
					t.Errorf("CompareWorktree(%v) err = %v, want ErrInvalidArgument", sides, err)
				}
				if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{ProjectID: f.id, Path: f.path, Base: sides[0], Head: sides[1], File: "keep.txt"}); !errors.Is(err, ErrInvalidArgument) {
					t.Errorf("CompareFile(%v) err = %v, want ErrInvalidArgument", sides, err)
				}
			}
		})
	}
	if _, err := os.Stat(canary); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a ref wrote %s: %v", canary, err)
	}
	if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Base: DiffSource{Kind: SourceStaged, Ref: "main"}}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a ref on a source that takes none: err = %v", err)
	}

	paths := []struct{ name, path string }{
		{"empty", ""},
		{"up and out", "../other/README.md"},
		{"up after down", "a/../../x"},
		{"absolute", "/etc/passwd"},
		{"into .git", ".git/config"},
		{"into .git in another case", ".GIT/config"},
		{".git itself", ".git"},
		{"a nested .git", "vendor/.git/config"},
		{"a NUL", "a\x00b"},
		{"too long", strings.Repeat("a/", comparePathMax)},
	}
	for _, tt := range paths {
		t.Run("path/"+tt.name, func(t *testing.T) {
			if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Paths: []string{tt.path}}); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("Paths: err = %v, want ErrInvalidArgument", err)
			}
			if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{ProjectID: f.id, Path: f.path, File: tt.path}); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("File: err = %v, want ErrInvalidArgument", err)
			}
			if tt.path != "" { // empty OldPath means File
				if _, err := f.h.store.CompareFile(ctx, CompareFileRequest{ProjectID: f.id, Path: f.path, File: "keep.txt", OldPath: tt.path}); !errors.Is(err, ErrInvalidArgument) {
					t.Errorf("OldPath: err = %v, want ErrInvalidArgument", err)
				}
			}
		})
	}
	if _, err := f.h.store.CompareWorktree(ctx, CompareRequest{ProjectID: f.id, Path: f.path, Paths: make([]string, comparePathsMax+1)}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("too many paths: err = %v", err)
	}
}

// TestCompareRefStaysARef: what passes checkRef is a question for rev-parse; these are
// the forms a caller may really send.
func TestCompareRefStaysARef(t *testing.T) {
	f := newCompareFixture(t)
	git(t, f.path, "tag", "v1.2")
	sha := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD"))
	for _, ref := range []string{"HEAD", "HEAD~1", "HEAD^", "HEAD@{0}", "@", "v1.2", "feat/x", "origin/main", "refs/heads/feat/x", sha, sha[:10]} {
		t.Run(ref, func(t *testing.T) {
			c := f.compare(t, sourceRef(ref), sourceRef("HEAD"))
			if c.Error != "" || c.Base.SHA == "" || c.Base.Label != ref {
				t.Errorf("%+v, error %q", c.Base, c.Error)
			}
		})
	}
}

// TestCompareNotGit: a project without git has nothing to compare.
func TestCompareNotGit(t *testing.T) {
	dir := newPlainDir(t)
	h := startHarness(t, "", Options{})
	ctx := ctx20(t)
	r, err := h.store.Register(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.CompareWorktree(ctx, CompareRequest{ProjectID: r.ID, Path: dir}); !errors.Is(err, ErrFailedPrecondition) || !errors.Is(err, ErrNotGit) {
		t.Errorf("err = %v, want ErrFailedPrecondition and ErrNotGit", err)
	}
}

// TestCompareSymlinksStayInside: on the disk side a link is what git stores, its target,
// never what it leads to; a path beyond a link that leaves is absent; a FIFO, which an
// open would hang on, is absent; and an untracked link is counted, not followed.
func TestCompareSymlinksStayInside(t *testing.T) {
	f := newCompareFixture(t)
	outside := filepath.Join(f.base, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret\nsecret\nsecret\n")
	for name, target := range map[string]string{"leak": filepath.Join(outside, "secret.txt"), "leakdir": outside} {
		if err := os.Symlink(target, filepath.Join(f.path, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(filepath.Join(f.path, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}

	d := f.sides(t, sourceRef("HEAD"), sourceWorking, "leak", "")
	if string(d.New.Contents) != filepath.Join(outside, "secret.txt") {
		t.Errorf("link reads %q, want its target", d.New.Contents)
	}
	if d = f.sides(t, sourceRef("HEAD"), sourceWorking, "leakdir/secret.txt", ""); d.New.Present {
		t.Errorf("read through a link that leaves: %q", d.New.Contents)
	}
	done := make(chan CompareSides, 1)
	go func() { done <- f.sides(t, sourceRef("HEAD"), sourceWorking, "pipe", "") }()
	select {
	case d = <-done:
		if d.New.Present {
			t.Errorf("a FIFO read as %+v", d.New)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("reading a FIFO blocked")
	}
	c := f.compare(t, DiffSource{}, sourceWorking, "leak")
	if got := rows(c.Files); !slices.Equal(got, []string{"? leak +1 -0"}) {
		t.Errorf("an untracked link's secret was counted: %v", got)
	}
}

func TestCountUntrackedBudget(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a.txt"), "1\n2\n3\n4\n")
	writeFile(t, filepath.Join(dir, "b.txt"), "1\n2\n")
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	for _, tt := range []struct {
		file  string
		limit int64
		lines int
		read  int64
	}{
		{"a.txt", 100, 4, 8},
		{"a.txt", 4, 2, 4},
		{"a.txt", 0, 0, 0},
		{"absent", 100, 0, 0},
	} {
		lines, _, read := countRootLines(root, tt.file, tt.limit)
		if lines != tt.lines || read != tt.read {
			t.Errorf("%s limit %d: %d lines read %d, want %d read %d", tt.file, tt.limit, lines, read, tt.lines, tt.read)
		}
	}
}

// The lines are git's own, captured from the cases they name.
func TestParseCompareZ(t *testing.T) {
	const z40 = "0000000000000000000000000000000000000000"
	const a40 = "af703352c64a2d88d4f62818fa68e6ae91241dfd"
	raw := func(oldMode, newMode, status string) string {
		return ":" + oldMode + " " + newMode + " " + a40 + " " + z40 + " " + status + "\x00"
	}
	tests := []struct {
		name string
		out  string
		want []string
	}{
		{"nothing", "", []string{}},
		{"modified", raw("100644", "100644", "M") + "f.txt\x004\t1\tf.txt\x00", []string{"M f.txt +4 -1"}},
		{"renamed", raw("100644", "100644", "R100") + "ren.txt\x00moved.txt\x000\t0\t\x00ren.txt\x00moved.txt\x00", []string{"R moved.txt <- ren.txt +0 -0"}},
		{"copied", raw("100644", "100644", "C75") + "a\x00b\x001\t2\t\x00a\x00b\x00", []string{"C b <- a +1 -2"}},
		{"binary", raw("100644", "100644", "M") + "bin.dat\x00-\t-\tbin.dat\x00", []string{"M bin.dat +0 -0 binary"}},
		{"submodule moved", raw("160000", "160000", "M") + "sub\x001\t1\tsub\x00", []string{"M sub +1 -1 submodule"}},
		{"submodule removed", raw("160000", "000000", "D") + "sub\x000\t1\tsub\x00", []string{"D sub +0 -1 submodule"}},
		{"unmerged, twice, as the index diffs list it", raw("000000", "100644", "U") + "f.txt\x00" + raw("100644", "100644", "M") + "f.txt\x000\t0\tf.txt\x004\t0\tf.txt\x00", []string{"U f.txt +4 -0"}},
		{"a path that looks like a record", raw("100644", "100644", "M") + ":100644 odd\x001\t0\t:100644 odd\x00", []string{"M :100644 odd +1 -0"}},
		{"a path with a tab", raw("100644", "100644", "M") + "a\tb\x001\t0\ta\tb\x00", []string{"M a\tb +1 -0"}},
		{"cut short after a raw header", raw("100644", "100644", "M"), []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := rows(parseCompareZ([]byte(tt.out))); !slices.Equal(got, tt.want) {
				t.Errorf("= %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParseUnmergedZ(t *testing.T) {
	out := "100644 a 1\tf.txt\x00100644 b 2\tf.txt\x00100644 c 3\tf.txt\x00100644 d 2\tg h.txt\x00"
	if got := parseUnmergedZ([]byte(out)); !slices.Equal(got, []string{"f.txt", "g h.txt"}) {
		t.Errorf("= %q", got)
	}
}
