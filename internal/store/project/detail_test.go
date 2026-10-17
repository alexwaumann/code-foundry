package project

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParseNameStatusZ(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []nameStatus
	}{
		{"empty", "", nil},
		{"simple", "M\x00a.go\x00A\x00dir/b.go\x00D\x00c\x00",
			[]nameStatus{{status: "M", path: "a.go"}, {status: "A", path: "dir/b.go"}, {status: "D", path: "c"}}},
		{"rename and copy", "R087\x00old.go\x00new.go\x00C100\x00x\x00y\x00T\x00link\x00",
			[]nameStatus{{status: "R", oldPath: "old.go", path: "new.go"}, {status: "C", oldPath: "x", path: "y"}, {status: "T", path: "link"}}},
		{"unmerged", "U\x00conflict.txt\x00", []nameStatus{{status: "U", path: "conflict.txt"}}},
		{"spaces and tabs in paths", "M\x00a b\tc.txt\x00", []nameStatus{{status: "M", path: "a b\tc.txt"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseNameStatusZ([]byte(tt.in)); !slices.Equal(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseNumstatZ(t *testing.T) {
	got := parseNumstatZ([]byte("3\t1\ta.go\x00-\t-\timg.png\x0010\t0\t\x00old.go\x00new.go\x000\t5\tgone\x00"))
	want := map[string]numstat{
		"a.go":    {added: 3, deleted: 1},
		"img.png": {binary: true},
		"new.go":  {added: 10},
		"gone":    {deleted: 5},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %+v, want %+v", k, got[k], v)
		}
	}
}

func TestParseLog(t *testing.T) {
	in := "abc123\x1fabc\x1fAda\x1fada@x.org\x1f1700000000\x1ffeat: x | y\x1e\n" +
		"def456\x1fdef\x1fBob\x1fbob@x.org\x1f1700000100\x1fsubject with \x1f inside\x1e\n"
	got := parseLog([]byte(in))
	if len(got) != 2 {
		t.Fatalf("got %d entries", len(got))
	}
	want0 := LogEntry{SHA: "abc123", ShortSHA: "abc", AuthorName: "Ada", AuthorEmail: "ada@x.org",
		AuthoredAt: time.Unix(1700000000, 0), Subject: "feat: x | y"}
	if got[0] != want0 {
		t.Errorf("entry 0 = %+v", got[0])
	}
	if got[1].Subject != "subject with \x1f inside" {
		t.Errorf("entry 1 subject = %q", got[1].Subject)
	}
}

func TestMergeFiles(t *testing.T) {
	committed := []nameStatus{{status: "A", path: "new.go"}, {status: "M", path: "both.go"}, {status: "R", oldPath: "a", path: "b"}}
	uncommitted := []nameStatus{{status: "M", path: "both.go"}, {status: "D", path: "wt-deleted.go"}}
	counts := map[string]numstat{"new.go": {added: 5}, "both.go": {added: 2, deleted: 1}, "b": {}, "wt-deleted.go": {deleted: 9}}
	// wt-deleted.go is also untracked (`git rm --cached`): the change wins.
	got, trunc := mergeFiles(committed, uncommitted, counts, []string{"notes.txt", "scratch/deep/f", "wt-deleted.go"})
	want := []FileChange{
		{Path: "b", OldPath: "a", Status: "R"},
		{Path: "both.go", Status: "M", Added: 2, Deleted: 1, Uncommitted: true},
		{Path: "new.go", Status: "A", Added: 5},
		{Path: "notes.txt", Status: "?", Uncommitted: true},
		{Path: "scratch/deep/f", Status: "?", Uncommitted: true},
		{Path: "wt-deleted.go", Status: "D", Deleted: 9, Uncommitted: true},
	}
	if trunc || !slices.Equal(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}

	// A conflicted path committed on the branch: one entry, U, with its counts.
	conflicted := []nameStatus{{status: "U", path: "both.go"}, {status: "D", path: "wt-deleted.go"}, {status: "U", path: "gone.go"}}
	got, _ = mergeFiles(committed, conflicted, counts, nil)
	want = []FileChange{
		{Path: "b", OldPath: "a", Status: "R"},
		{Path: "both.go", Status: "U", Added: 2, Deleted: 1, Uncommitted: true},
		{Path: "gone.go", Status: "U", Uncommitted: true},
		{Path: "new.go", Status: "A", Added: 5},
		{Path: "wt-deleted.go", Status: "D", Deleted: 9, Uncommitted: true},
	}
	if !slices.Equal(got, want) {
		t.Errorf("conflicts: got %+v\nwant %+v", got, want)
	}

	many := make([]string, DetailFilesMax+5)
	for i := range many {
		many[i] = strings.Repeat("x", 1+i%7) + string(rune('a'+i%26)) + "/" + time.Duration(i).String()
	}
	if got, trunc := mergeFiles(nil, nil, nil, many); !trunc || len(got) != DetailFilesMax {
		t.Errorf("cap: len=%d trunc=%v", len(got), trunc)
	}
}

func TestCountLines(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		content    string
		lines      int
		wantBinary bool
	}{
		{"", 0, false},
		{"one\ntwo\n", 2, false},
		{"one\ntwo", 2, false},
		{"bin\x00ary\n", 0, true},
	}
	for i, tt := range tests {
		p := filepath.Join(dir, string(rune('a'+i)))
		writeFile(t, p, tt.content)
		if n, bin := countLines(p); n != tt.lines || bin != tt.wantBinary {
			t.Errorf("%q: lines=%d binary=%v", tt.content, n, bin)
		}
	}
	if n, bin := countLines(filepath.Join(dir, "missing")); n != 0 || bin {
		t.Error("missing file counted")
	}
}

// TestWorktreeDetail runs the real git against a feature worktree: commits on the
// branch, a rename, an uncommitted edit, a staged add, and untracked files and dirs.
func TestWorktreeDetail(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/x"})
	if err != nil {
		t.Fatal(err)
	}
	p := wt.Path
	writeFile(t, filepath.Join(p, "feature.go"), "package x\n\nfunc F() {}\n")
	git(t, p, "add", "feature.go")
	git(t, p, "commit", "-q", "-m", "feat: add F")
	git(t, p, "mv", "sub/x.txt", "sub/y.txt")
	git(t, p, "commit", "-q", "-m", "chore: rename x")
	writeFile(t, filepath.Join(p, "README.md"), "hello\nworld\n") // uncommitted edit
	writeFile(t, filepath.Join(p, "staged.txt"), "s\n")
	git(t, p, "add", "staged.txt")
	writeFile(t, filepath.Join(p, "notes.md"), "a\nb\nc")
	if err := os.MkdirAll(filepath.Join(p, "scratch", "deep"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(p, "scratch", "deep", "f"), "x\n")
	writeFile(t, filepath.Join(p, "scratch", "g"), "1\n2")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}

	d, err := h.store.WorktreeDetail(ctx, r.ID, p)
	if err != nil {
		t.Fatal(err)
	}
	if d.BaseRef != "origin/main" || d.MergeBase == "" || d.Head == "" || d.ComputedAt.IsZero() || d.Error != "" {
		t.Fatalf("detail header = %+v", d)
	}
	want := []FileChange{
		{Path: "README.md", Status: "M", Added: 1, Uncommitted: true},
		{Path: "feature.go", Status: "A", Added: 3},
		{Path: "notes.md", Status: "?", Added: 3, Uncommitted: true},
		{Path: "scratch/deep/f", Status: "?", Added: 1, Uncommitted: true},
		{Path: "scratch/g", Status: "?", Added: 2, Uncommitted: true},
		{Path: "staged.txt", Status: "A", Added: 1, Uncommitted: true},
		{Path: "sub/y.txt", OldPath: "sub/x.txt", Status: "R"},
	}
	if !slices.Equal(d.Files, want) {
		t.Errorf("files:\n got %+v\nwant %+v", d.Files, want)
	}
	if d.LogTotal != 2 || len(d.Log) != 2 || d.Log[0].Subject != "chore: rename x" || d.Log[1].Subject != "feat: add F" ||
		d.Log[0].AuthorName != "Test" || d.Log[0].ShortSHA == "" || d.Log[0].AuthoredAt.IsZero() {
		t.Errorf("log = %d %+v", d.LogTotal, d.Log)
	}

	// Main worktree, clean and level with origin/main: nothing changed.
	m, err := h.store.WorktreeDetail(ctx, r.ID, f.project)
	if err != nil {
		t.Fatal(err)
	}
	if m.BaseRef != "origin/main" || len(m.Files) != 0 || len(m.Log) != 0 || m.LogTotal != 0 {
		t.Errorf("main detail = %+v", m)
	}

	// Watched: the next status refresh recomputes and announces the change.
	for len(h.sub.C()) > 0 {
		<-h.sub.C()
	}
	writeFile(t, filepath.Join(p, "later.txt"), "1\n")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h.waitFor("detail update", func(ev Event) bool {
		u, ok := ev.(WorktreeDetailUpdated)
		return ok && u.Path == p && !u.ComputedAt.IsZero()
	})
	d2, _ := h.store.WorktreeDetail(ctx, r.ID, p)
	if !slices.ContainsFunc(d2.Files, func(f FileChange) bool { return f.Path == "later.txt" && f.Status == "?" }) {
		t.Errorf("recomputed files lack later.txt: %+v", d2.Files)
	}

	if _, err := h.store.WorktreeDetail(ctx, r.ID, "/nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown worktree err = %v", err)
	}
}

// TestWorktreeDetailConflicts stops a real rebase on a conflict: the conflicted file is
// U (status reports it as a `u` entry), a cleanly applied file of the same pick keeps
// its own status, and after --abort the file is back to M.
func TestWorktreeDetailConflicts(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat"})
	if err != nil {
		t.Fatal(err)
	}
	p := wt.Path
	// feat 1 edits README and adds g.txt; main changes README the other way.
	writeFile(t, filepath.Join(p, "README.md"), "feat\n")
	writeFile(t, filepath.Join(p, "g.txt"), "g\n")
	git(t, p, "add", ".")
	git(t, p, "commit", "-q", "-m", "feat 1")
	writeFile(t, filepath.Join(f.project, "README.md"), "main\n")
	git(t, f.project, "commit", "-q", "-am", "main change")

	gitFails(t, p, "rebase", "main")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if w, _ := h.store.Snapshot().Worktree(r.ID, p); w.Status.Conflicted != 1 {
		t.Fatalf("status = %+v, want one conflict", w.Status)
	}
	d, err := h.store.WorktreeDetail(ctx, r.ID, p)
	if err != nil {
		t.Fatal(err)
	}
	statuses := func(d WorktreeDetail) map[string]string {
		m := map[string]string{}
		for _, f := range d.Files {
			m[f.Path] = f.Status
		}
		return m
	}
	readme := slices.IndexFunc(d.Files, func(f FileChange) bool { return f.Path == "README.md" })
	if got := statuses(d); len(d.Files) != 2 || readme < 0 || got["README.md"] != "U" || got["g.txt"] != "A" {
		t.Fatalf("files during the rebase = %+v", d.Files)
	}
	if rf := d.Files[readme]; !rf.Uncommitted || rf.Added == 0 {
		t.Errorf("conflicted README lost its counts: %+v", rf)
	}

	for len(h.sub.C()) > 0 {
		<-h.sub.C()
	}
	git(t, p, "rebase", "--abort")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	h.waitFor("detail after the abort", func(ev Event) bool {
		u, ok := ev.(WorktreeDetailUpdated)
		if !ok || u.Path != p {
			return false
		}
		d, _ = h.store.WorktreeDetail(ctx, r.ID, p)
		return statuses(d)["README.md"] == "M"
	})
	if got := statuses(d); got["g.txt"] != "A" || slices.Contains(slices.Collect(maps.Values(got)), "U") {
		t.Errorf("files after the abort = %+v", d.Files)
	}
}

// A worktree nobody asked about is not recomputed by status refreshes.
func TestWorktreeDetailOnlyWhenWatched(t *testing.T) {
	f := newFixture(t)
	runner := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: runner})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := h.store.Refresh(ctx, r.ID); err != nil {
			t.Fatal(err)
		}
	}
	if n := runner.count("merge-base"); n != 0 {
		t.Errorf("merge-base ran %d times without a request", n)
	}
	if _, err := h.store.WorktreeDetail(ctx, r.ID, f.project); err != nil {
		t.Fatal(err)
	}
	before := runner.count("merge-base")
	if _, err := h.store.WorktreeDetail(ctx, r.ID, f.project); err != nil {
		t.Fatal(err)
	}
	if n := runner.count("merge-base"); n != before {
		t.Errorf("a second call within the watch recomputed (%d -> %d)", before, n)
	}
}

// An unborn branch (no commits) has no base; its files are what is staged and untracked.
func TestWorktreeDetailUnborn(t *testing.T) {
	isolateGit(t)
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	git(t, dir, "init", "-q", "-b", "main", "fresh")
	projectDir := filepath.Join(dir, "fresh")
	writeFile(t, filepath.Join(projectDir, "a.txt"), "1\n2\n")
	git(t, projectDir, "add", "a.txt")
	writeFile(t, filepath.Join(projectDir, "b.txt"), "x\n")
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, projectDir)
	if err != nil {
		t.Fatal(err)
	}
	d, err := h.store.WorktreeDetail(ctx, r.ID, projectDir)
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{
		{Path: "a.txt", Status: "A", Added: 2, Uncommitted: true},
		{Path: "b.txt", Status: "?", Added: 1, Uncommitted: true},
	}
	if d.BaseRef != "" || d.Error != "" || !slices.Equal(d.Files, want) {
		t.Errorf("unborn detail = %+v", d)
	}
}

// A clean worktree takes the tree-to-tree path: committed files keep their counts.
func TestWorktreeDetailCleanUsesTreeDiff(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/clean"})
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(wt.Path, "a.txt"), "1\n2\n3\n")
	git(t, wt.Path, "add", "a.txt")
	git(t, wt.Path, "commit", "-q", "-m", "add a")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	d, err := h.store.WorktreeDetail(ctx, r.ID, wt.Path)
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{{Path: "a.txt", Status: "A", Added: 3}}
	if !slices.Equal(d.Files, want) || d.LogTotal != 1 {
		t.Errorf("clean detail = %+v", d)
	}
}

func TestHeadToWorktree(t *testing.T) {
	e := func(xy, path, orig string) statusEntry {
		return statusEntry{Path: path, OrigPath: orig, X: xy[0], Y: xy[1]}
	}
	tests := []struct {
		xy   string
		orig string
		want nameStatus // zero: not listed
	}{
		{xy: "M.", want: nameStatus{status: "M", path: "p"}},
		{xy: ".M", want: nameStatus{status: "M", path: "p"}},
		{xy: "MM", want: nameStatus{status: "M", path: "p"}},
		{xy: "A.", want: nameStatus{status: "A", path: "p"}},
		{xy: "AM", want: nameStatus{status: "A", path: "p"}},
		{xy: "AT", want: nameStatus{status: "A", path: "p"}},
		{xy: ".A", want: nameStatus{status: "A", path: "p"}}, // intent to add
		{xy: "AD"},              // in neither HEAD nor the working tree
		{xy: "CD", orig: "src"}, // the copy is gone, its source untouched
		{xy: "D.", want: nameStatus{status: "D", path: "p"}},
		{xy: ".D", want: nameStatus{status: "D", path: "p"}},
		{xy: "MD", want: nameStatus{status: "D", path: "p"}},
		{xy: "TD", want: nameStatus{status: "D", path: "p"}},
		{xy: "RD", orig: "old", want: nameStatus{status: "D", path: "old"}},
		{xy: "R.", orig: "old", want: nameStatus{status: "R", path: "p", oldPath: "old"}},
		{xy: "RM", orig: "old", want: nameStatus{status: "R", path: "p", oldPath: "old"}},
		{xy: "RT", orig: "old", want: nameStatus{status: "R", path: "p", oldPath: "old"}},
		{xy: "C.", orig: "src", want: nameStatus{status: "C", path: "p", oldPath: "src"}},
		{xy: "CM", orig: "src", want: nameStatus{status: "C", path: "p", oldPath: "src"}},
		{xy: "T.", want: nameStatus{status: "T", path: "p"}},
		{xy: ".T", want: nameStatus{status: "T", path: "p"}},
		{xy: "MT", want: nameStatus{status: "T", path: "p"}},
		{xy: "TM", want: nameStatus{status: "T", path: "p"}},
	}
	for _, tt := range tests {
		t.Run(tt.xy, func(t *testing.T) {
			got, ok := headToWorktree(e(tt.xy, "p", tt.orig))
			if ok != (tt.want != nameStatus{}) || got != tt.want {
				t.Errorf("%s = %+v, %v; want %+v", tt.xy, got, ok, tt.want)
			}
		})
	}
}

func TestUncommittedFiles(t *testing.T) {
	changes, untracked := uncommittedFiles([]statusEntry{
		{Path: "a", X: 'M', Y: 'M'},
		{Path: "new", X: 'A', Y: 'D'},
		{Path: "c", X: 'U', Y: 'U', Unmerged: true},
		{Path: "d", X: 'D', Y: 'U', Unmerged: true},
		{Path: "i", X: 'D', Y: '.'},
		{Path: "i", X: '?', Y: '?', Untracked: true}, // `git rm --cached i`
		{Path: "dir/one", X: '?', Y: '?', Untracked: true},
	})
	wantChanges := []nameStatus{{status: "M", path: "a"}, {status: "U", path: "c"}, {status: "U", path: "d"}, {status: "D", path: "i"}}
	if !slices.Equal(changes, wantChanges) || !slices.Equal(untracked, []string{"i", "dir/one"}) {
		t.Errorf("changes %+v, untracked %q", changes, untracked)
	}
	if c, u := uncommittedFiles(nil); c != nil || u != nil {
		t.Errorf("no entries: %v %v", c, u)
	}
}

// countUntracked reads a file again only when its size or mtime changed, and keeps
// only the paths listed now.
func TestCountUntrackedMemo(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "a"), "1\n2\n")
	writeFile(t, filepath.Join(dir, "b"), "1\n")
	writeFile(t, filepath.Join(dir, "bin"), "x\x00y")
	files := func(paths ...string) []FileChange {
		fs := []FileChange{{Path: "tracked", Status: "M", Added: 7}}
		for _, p := range paths {
			fs = append(fs, FileChange{Path: p, Status: "?", Uncommitted: true})
		}
		return fs
	}
	added := func(fs []FileChange) map[string]int {
		m := map[string]int{}
		for _, f := range fs {
			m[f.Path] = f.Added
		}
		return m
	}

	fs := files("a", "b", "bin", "gone")
	memo, reads := countUntracked(dir, fs, nil)
	if reads != 3 || len(memo) != 3 || !maps.Equal(added(fs), map[string]int{"tracked": 7, "a": 2, "b": 1, "bin": 0, "gone": 0}) || !fs[3].Binary {
		t.Fatalf("first: reads %d, memo %v, files %+v", reads, memo, fs)
	}

	fs = files("a", "b", "bin")
	if memo, reads = countUntracked(dir, fs, memo); reads != 0 || !maps.Equal(added(fs), map[string]int{"tracked": 7, "a": 2, "b": 1, "bin": 0}) || !fs[3].Binary {
		t.Fatalf("unchanged: reads %d, files %+v", reads, fs)
	}

	writeFile(t, filepath.Join(dir, "b"), "1\n2\n3") // size changes
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "a"), later, later); err != nil { // mtime only
		t.Fatal(err)
	}
	fs = files("a", "b")
	if memo, reads = countUntracked(dir, fs, memo); reads != 2 || len(memo) != 2 || !maps.Equal(added(fs), map[string]int{"tracked": 7, "a": 2, "b": 3}) {
		t.Fatalf("changed: reads %d, memo %v, files %+v", reads, memo, fs)
	}
	if _, kept := memo["bin"]; kept {
		t.Error("memo kept a path no longer untracked")
	}

	if memo, reads = countUntracked(dir, files(), memo); memo != nil || reads != 0 {
		t.Errorf("none untracked: memo %v, reads %d", memo, reads)
	}
}

// TestWorktreeDetailFromStatus runs the real git on the XY combinations the detail
// derives from status: a staged rename plus an edit (RM), an added then edited file
// (AM), an added then deleted one (AD, not listed), a staged edit then delete (MD), a
// worktree delete ( D), a staged delete (D ), and an untracked directory listed file by
// file, with a binary, an empty, and an unterminated file. The user's config would
// hide untracked files and renames; status's flags override it.
func TestWorktreeDetailFromStatus(t *testing.T) {
	f := newFixture(t)
	// Distinct contents, so rename detection pairs nothing by accident.
	body := func(name string) string { return name + "\none\ntwo\nthree\nfour\nfive\n" }
	for _, n := range []string{"ren.txt", "md.txt", "wd.txt", "sd.txt"} {
		writeFile(t, filepath.Join(f.project, n), body(n))
	}
	git(t, f.project, "add", ".")
	git(t, f.project, "commit", "-q", "-m", "files")
	git(t, f.project, "push", "-q")
	git(t, f.project, "config", "status.showUntrackedFiles", "no")
	git(t, f.project, "config", "status.renames", "false")
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "feat/xy"})
	if err != nil {
		t.Fatal(err)
	}
	p := wt.Path
	git(t, p, "mv", "ren.txt", "renamed.txt") // RM
	writeFile(t, filepath.Join(p, "renamed.txt"), body("ren.txt")+"seven\n")
	writeFile(t, filepath.Join(p, "am.txt"), "a\n") // AM
	git(t, p, "add", "am.txt")
	writeFile(t, filepath.Join(p, "am.txt"), "a\nb\n")
	writeFile(t, filepath.Join(p, "ad.txt"), "gone\n") // AD
	git(t, p, "add", "ad.txt")
	mustRemove(t, filepath.Join(p, "ad.txt"))
	writeFile(t, filepath.Join(p, "md.txt"), body("md.txt")+"x\n") // MD
	git(t, p, "add", "md.txt")
	mustRemove(t, filepath.Join(p, "md.txt"))
	mustRemove(t, filepath.Join(p, "wd.txt")) // .D
	git(t, p, "rm", "-q", "sd.txt")           // D.
	if err := os.MkdirAll(filepath.Join(p, "ud", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(p, "ud", "bin"), "a\x00b\n")
	writeFile(t, filepath.Join(p, "ud", "sub", "empty"), "")
	writeFile(t, filepath.Join(p, "ud", "tail"), "1\n2\n3")
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	w, _ := h.store.Snapshot().Worktree(r.ID, p)
	if w.Status.Untracked != 3 {
		t.Errorf("untracked = %d, want 3 (files, not the directory)", w.Status.Untracked)
	}
	d, err := h.store.WorktreeDetail(ctx, r.ID, p)
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{
		{Path: "am.txt", Status: "A", Added: 2, Uncommitted: true},
		{Path: "md.txt", Status: "D", Deleted: 6, Uncommitted: true},
		{Path: "renamed.txt", OldPath: "ren.txt", Status: "R", Added: 1, Uncommitted: true},
		{Path: "sd.txt", Status: "D", Deleted: 6, Uncommitted: true},
		{Path: "ud/bin", Status: "?", Binary: true, Uncommitted: true},
		{Path: "ud/sub/empty", Status: "?", Uncommitted: true},
		{Path: "ud/tail", Status: "?", Added: 3, Uncommitted: true},
		{Path: "wd.txt", Status: "D", Deleted: 6, Uncommitted: true},
	}
	if !slices.Equal(d.Files, want) {
		t.Errorf("files:\n got %+v\nwant %+v", d.Files, want)
	}
}

func mustRemove(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}
