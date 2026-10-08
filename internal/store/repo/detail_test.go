package repo

import (
	"context"
	"errors"
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
	got, trunc := mergeFiles(committed, uncommitted, counts, []string{"notes.txt", "scratch/"})
	want := []FileChange{
		{Path: "b", OldPath: "a", Status: "R"},
		{Path: "both.go", Status: "M", Added: 2, Deleted: 1, Uncommitted: true},
		{Path: "new.go", Status: "A", Added: 5},
		{Path: "notes.txt", Status: "?", Uncommitted: true},
		{Path: "scratch/", Status: "?", Uncommitted: true, IsDir: true},
		{Path: "wt-deleted.go", Status: "D", Deleted: 9, Uncommitted: true},
	}
	if trunc || !slices.Equal(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
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
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "feat/x"})
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
		{Path: "scratch/", Status: "?", Uncommitted: true, IsDir: true},
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
	m, err := h.store.WorktreeDetail(ctx, r.ID, f.repo)
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

// A worktree nobody asked about is not recomputed by status refreshes.
func TestWorktreeDetailOnlyWhenWatched(t *testing.T) {
	f := newFixture(t)
	runner := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: runner})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, f.repo)
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
	if _, err := h.store.WorktreeDetail(ctx, r.ID, f.repo); err != nil {
		t.Fatal(err)
	}
	before := runner.count("merge-base")
	if _, err := h.store.WorktreeDetail(ctx, r.ID, f.repo); err != nil {
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
	repoDir := filepath.Join(dir, "fresh")
	writeFile(t, filepath.Join(repoDir, "a.txt"), "1\n2\n")
	git(t, repoDir, "add", "a.txt")
	writeFile(t, filepath.Join(repoDir, "b.txt"), "x\n")
	h := startHarness(t, "", Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := h.store.Register(ctx, repoDir)
	if err != nil {
		t.Fatal(err)
	}
	d, err := h.store.WorktreeDetail(ctx, r.ID, repoDir)
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
