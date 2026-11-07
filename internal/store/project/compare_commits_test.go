package project

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

func (f compareFixture) commits(t *testing.T, base, head DiffSource) CompareLog {
	t.Helper()
	l, err := f.h.store.CompareCommits(ctx20(t), CompareCommitsRequest{ProjectID: f.id, Path: f.path, Base: base, Head: head})
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func (f compareFixture) body(t *testing.T, sha string) CompareCommitMessage {
	t.Helper()
	m, err := f.h.store.CompareCommitBody(ctx20(t), CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: sha})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func subjects(l CompareLog) []string {
	out := make([]string, len(l.Commits))
	for i, c := range l.Commits {
		out[i] = c.Subject
	}
	return out
}

// commit makes a commit in the fixture's worktree with this message.
func (f compareFixture) commit(t *testing.T, name, message string) {
	t.Helper()
	writeFile(t, filepath.Join(f.path, name), message+"\n")
	git(t, f.path, "add", name)
	git(t, f.path, "commit", "-q", "-m", message)
}

// The list is the branch between the two sides, whatever kind they are, and follows them.
func TestCompareCommitsFollowsTheSides(t *testing.T) {
	f := newCompareFixture(t)
	f.commit(t, "second.txt", "second")
	f.commit(t, "third.txt", "third")
	mergeBase := DiffSource{Kind: SourceMergeBase}
	branch := []string{"third", "second", "branch work"}
	tests := []struct {
		name       string
		base, head DiffSource
		want       []string
	}{
		{"merge base to working tree", mergeBase, sourceWorking, branch},
		{"merge base to staged", mergeBase, sourceStaged, branch},
		{"a ref to a ref", sourceRef("origin/main"), sourceRef("feat/x"), branch},
		{"part of the branch", sourceRef("HEAD~2"), sourceRef("HEAD~1"), []string{"second"}},
		{"the working tree as base is HEAD", sourceWorking, sourceRef("HEAD"), []string{}},
		{"swapped: nothing the head has and the base does not", sourceRef("HEAD"), sourceRef("origin/main"), []string{}},
		{"a side against itself", sourceRef("HEAD"), sourceRef("HEAD"), []string{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			l := f.commits(t, tt.base, tt.head)
			if got := subjects(l); l.Error != "" || !slices.Equal(got, tt.want) {
				t.Errorf("subjects = %q, error %q; want %q", got, l.Error, tt.want)
			}
			if l.Total != len(tt.want) {
				t.Errorf("total = %d, want %d", l.Total, len(tt.want))
			}
		})
	}
}

// Each row has what a click needs: a merge's first parent, a root's none, and the message.
func TestCompareCommitsFields(t *testing.T) {
	f := newCompareFixture(t)
	git(t, f.path, "add", ".")
	git(t, f.path, "commit", "-q", "-m", "the rest")
	parent := git(t, f.path, "rev-parse", "HEAD")
	git(t, f.path, "checkout", "-q", "-b", "side", "HEAD~1")
	f.commit(t, "side.txt", "on the side")
	git(t, f.path, "checkout", "-q", "feat/x")
	git(t, f.path, "merge", "-q", "--no-ff", "--no-edit", "-m", "merge side\n\nBoth halves.\n\nSecond paragraph.", "side")

	l := f.commits(t, sourceRef("HEAD~1"), sourceRef("HEAD"))
	merge := l.Commits[0]
	if merge.Subject != "merge side" {
		t.Errorf("subject = %q", merge.Subject)
	}
	if m := f.body(t, merge.SHA); m.Body != "Both halves.\n\nSecond paragraph." || m.Error != "" {
		t.Errorf("message = %+v", m)
	}
	if merge.Parent != parent {
		t.Errorf("parent = %q, want the first, %q", merge.Parent, parent)
	}
	if len(merge.SHA) != 40 || !strings.HasPrefix(merge.SHA, merge.ShortSHA) || merge.ShortSHA == "" || merge.AuthoredAt.IsZero() {
		t.Errorf("commit = %+v", merge)
	}

	all := f.commits(t, sourceRef(emptyTree), sourceRef("HEAD"))
	root := all.Commits[len(all.Commits)-1]
	if root.Parent != "" || len(all.Commits) < 3 {
		t.Errorf("root = %+v of %d", root, len(all.Commits))
	}
}

// The commit a root is compared against: nothing. Every file is added, and its old side absent.
func TestCompareEmptyTree(t *testing.T) {
	f := newCompareFixture(t)
	root := git(t, f.path, "rev-list", "--max-parents=0", "HEAD")
	c := f.compare(t, sourceRef(emptyTree), sourceRef(root))
	if c.Error != "" || c.Base.Label != "Empty tree" || c.Base.SHA != emptyTree || len(c.Files) == 0 {
		t.Fatalf("compare = %+v", c)
	}
	for _, file := range c.Files {
		if file.Status != "A" {
			t.Errorf("%s is %s, want added", file.Path, file.Status)
		}
	}
	s := f.sides(t, sourceRef(emptyTree), sourceRef(root), c.Files[0].Path, "")
	if s.Error != "" || s.Old.Present || !s.New.Present || s.Status != "A" {
		t.Errorf("sides = %+v", s)
	}
}

// What git writes is read with care: a row is only one if it starts with a sha, a date may be
// none, a message may be empty, and its bytes cannot break the response.
func TestParseCompareCommits(t *testing.T) {
	sha, parent := strings.Repeat("a", 40), strings.Repeat("b", 40)
	row := func(fields ...string) string { return strings.Join(fields, "\x00") + "\x00" }
	tests := []struct {
		name string
		out  string
		want []CompareCommit
	}{
		{name: "nothing", out: ""},
		{name: "a row", out: row(sha, "aaaa", parent+" "+strings.Repeat("c", 40), "1000", "  a subject\n"),
			want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, Subject: "a subject", AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a bad byte", out: row(sha, "aaaa", parent, "1000", "bad \xff byte"),
			want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, Subject: "bad \uFFFD byte", AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a root", out: row(sha, "aaaa", "", "1000", "root"), want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Subject: "root", AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a date that is no number", out: row(sha, "aaaa", parent, "soon", "s"), want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, Subject: "s"}}},
		{name: "no date", out: row(sha, "aaaa", parent, "", "s"), want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, Subject: "s"}}},
		{name: "an empty message", out: row(sha, "aaaa", parent, "1000", ""), want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a parent that is no sha", out: row(sha, "aaaa", "--output=x", "1000", "s"), want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Subject: "s", AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a row that is no row, and the next that is", out: row("junk", "x", "y", "z", "w") + row(sha, "aaaa", parent, "1000", "real"),
			want: []CompareCommit{{SHA: sha, ShortSHA: "aaaa", Parent: parent, Subject: "real", AuthoredAt: time.Unix(1000, 0)}}},
		{name: "a short sha is no sha", out: row("aaaa", "aaaa", parent, "1000", "s")},
		{name: "half a row", out: sha + "\x00aaaa\x00"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseCompareCommits([]byte(tt.out))
			if !slices.EqualFunc(got, tt.want, func(a, b CompareCommit) bool {
				return a.AuthoredAt.Equal(b.AuthoredAt) && a.SHA == b.SHA && a.ShortSHA == b.ShortSHA && a.Parent == b.Parent && a.Subject == b.Subject
			}) {
				t.Errorf("parsed %+v, want %+v", got, tt.want)
			}
		})
	}
}

// A message's text is cut on a character, stays within the cap and says it was cut.
func TestCommitText(t *testing.T) {
	tests := []struct {
		name, in string
		limit    int
		want     string
	}{
		{name: "fits", in: " abc\n", limit: 3, want: "abc"},
		{name: "cut", in: "abcdefgh", limit: 6, want: "abc…"},
		{name: "cut inside a character", in: "aééééé", limit: 7, want: "aé…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := commitText(tt.in, tt.limit); got != tt.want || len(got) > tt.limit || !utf8.ValidString(got) {
				t.Errorf("commitText = %q, want %q", got, tt.want)
			}
		})
	}
}

// fieldWriter holds at most max bytes of a field, wherever git's writes happen to fall.
func TestFieldWriter(t *testing.T) {
	tests := []struct {
		name   string
		writes []string
		max    int
		want   string
	}{
		{name: "under the cap", writes: []string{"ab\x00cd\x00"}, max: 5, want: "ab\x00cd\x00"},
		{name: "cut", writes: []string{"abcdef\x00gh\x00"}, max: 3, want: "abc\x00gh\x00"},
		{name: "cut across writes", writes: []string{"ab", "cd", "ef\x00g"}, max: 3, want: "abc\x00g"},
		{name: "a NUL alone in a write", writes: []string{"abcd", "\x00", "e"}, max: 2, want: "ab\x00e"},
		{name: "an empty field", writes: []string{"\x00\x00a"}, max: 2, want: "\x00\x00a"},
		{name: "no NUL at all", writes: []string{"abcdef"}, max: 2, want: "ab"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := &fieldWriter{max: tt.max}
			for _, p := range tt.writes {
				if n, err := w.Write([]byte(p)); n != len(p) || err != nil {
					t.Fatalf("Write(%q) = %d, %v", p, n, err)
				}
			}
			if got := w.buf.String(); got != tt.want {
				t.Errorf("kept %q, want %q", got, tt.want)
			}
		})
	}
}

// The list costs the daemon the same however long the messages are, on the list's read and
// the one commit's: nothing past a field's cap is kept, and the list carries no bodies. It used to
// hold the whole log and every copy of it, 1,268 MiB for 100 commits of 5 MiB.
func TestCompareCommitsHugeMessages(t *testing.T) {
	const size = 5 << 20
	f := newCompareFixture(t)
	tree := git(t, f.path, "rev-parse", "HEAD^{tree}")
	head := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD"))
	message := strings.Repeat("s", size) + "\n\n" + strings.Repeat("b", size) + "\n"
	const commits = 10
	for range commits {
		head = strings.TrimSpace(gitStdin(t, f.path, message, "commit-tree", tree, "-p", head))
	}
	git(t, f.path, "update-ref", "refs/heads/huge", head)

	alloc := func() uint64 {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return m.TotalAlloc
	}
	before := alloc()
	l := f.commits(t, sourceRef("origin/main"), sourceRef("huge"))
	m := f.body(t, head)
	used := alloc() - before
	if used > 8<<20 {
		t.Errorf("allocated %d MiB for %d commits of %d MiB", used>>20, commits, size>>20)
	}
	if len(l.Commits) < commits {
		t.Fatalf("listed %d", len(l.Commits))
	}
	if s := l.Commits[0].Subject; len(s) > commitSubjectMax || !strings.HasSuffix(s, "…") {
		t.Errorf("subject = %d bytes, ending %q", len(s), s[len(s)-5:])
	}
	if len(m.Body) > commitBodyMax || !strings.HasSuffix(m.Body, "…") {
		t.Errorf("body = %d bytes", len(m.Body))
	}
}

// A subject git would not cut, one that is not valid UTF-8, is cut all the same.
func TestCompareCommitsBadBytesAreCut(t *testing.T) {
	f := newCompareFixture(t)
	tree := git(t, f.path, "rev-parse", "HEAD^{tree}")
	head := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD"))
	head = strings.TrimSpace(gitStdin(t, f.path, "\xff"+strings.Repeat("s", 64<<10)+"\n", "commit-tree", tree, "-p", head))
	l := f.commits(t, sourceRef(head+"~1"), sourceRef(head))
	if len(l.Commits) != 1 || len(l.Commits[0].Subject) > commitSubjectMax || !utf8.ValidString(l.Commits[0].Subject) {
		t.Errorf("listed %d, subject %d bytes", len(l.Commits), len(l.Commits[0].Subject))
	}
}

// A checkout's config does not get to hang the read or change its bytes.
func TestCompareCommitsIgnoresHostileConfig(t *testing.T) {
	f := newCompareFixture(t)
	fifo := filepath.Join(f.base, "mailmap")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, f.path, "config", "mailmap.file", fifo)
	git(t, f.path, "config", "log.mailmap", "true")
	git(t, f.path, "config", "i18n.logOutputEncoding", "UTF-16")
	git(t, f.path, "commit", "-q", "--amend", "-m", "branch work\n\nThe reason.")
	sha := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD"))

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	l, err := f.h.store.CompareCommits(ctx, CompareCommitsRequest{ProjectID: f.id, Path: f.path, Base: sourceRef("origin/main"), Head: sourceRef("HEAD")})
	if err != nil {
		t.Fatal(err)
	}
	if got := subjects(l); !slices.Equal(got, []string{"branch work"}) {
		t.Errorf("subjects = %q", got)
	}
	m, err := f.h.store.CompareCommitBody(ctx, CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: sha})
	if err != nil {
		t.Fatal(err)
	}
	if m.Body != "The reason." {
		t.Errorf("body = %q", m.Body)
	}
}

// A shallow clone's last commit has no parent as a root has none; only the clone can tell.
func TestCompareCommitsShallow(t *testing.T) {
	f := newCompareFixture(t)
	if root := f.commits(t, sourceRef(emptyTree), sourceRef("HEAD")); root.Commits[len(root.Commits)-1].Shallow {
		t.Errorf("a real root reads as shallow: %+v", root.Commits[len(root.Commits)-1])
	}
	clone := filepath.Join(f.base, "shallow")
	git(t, f.base, "-c", "protocol.file.allow=always", "clone", "-q", "--depth=1", "file://"+f.project, clone)
	r, err := f.h.store.Register(ctx20(t), clone)
	if err != nil {
		t.Fatal(err)
	}
	p, err := filepath.EvalSymlinks(clone)
	if err != nil {
		t.Fatal(err)
	}
	l, err := f.h.store.CompareCommits(ctx20(t), CompareCommitsRequest{ProjectID: r.ID, Path: p, Base: sourceRef(emptyTree), Head: sourceRef("HEAD")})
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Commits) != 1 || !l.Commits[0].Shallow || l.Commits[0].Parent != "" {
		t.Errorf("commits = %+v", l.Commits)
	}
}

// One commit's message takes a full sha and nothing else, and a commit gone is an answer.
func TestCompareCommitBodyRefusals(t *testing.T) {
	f := newCompareFixture(t)
	head := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD"))
	blob := strings.TrimSpace(git(t, f.path, "rev-parse", "HEAD:keep.txt"))
	for _, sha := range []string{"", "HEAD", head[:12], "--output=x", head + "^", strings.ToUpper(head)} {
		_, err := f.h.store.CompareCommitBody(ctx20(t), CompareCommitRequest{ProjectID: f.id, Path: f.path, SHA: sha})
		if !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%q: %v", sha, err)
		}
	}
	for _, sha := range []string{strings.Repeat("0", 40), blob} {
		if m := f.body(t, sha); m.Error != commitGone || m.Body != "" {
			t.Errorf("%s: %+v", sha, m)
		}
	}
	if m := f.body(t, head); m.Error != "" || m.Body != "" {
		t.Errorf("a commit with no body: %+v", m)
	}
}

// A long branch is capped, and the total counts it all.
func TestCompareCommitsCap(t *testing.T) {
	f := newCompareFixture(t)
	tree := git(t, f.path, "rev-parse", "HEAD^{tree}")
	head := git(t, f.path, "rev-parse", "HEAD")
	for i := range CompareCommitsMax + 2 {
		head = git(t, f.path, "commit-tree", tree, "-p", head, "-m", "c"+strconv.Itoa(i))
	}
	git(t, f.path, "update-ref", "refs/heads/long", head)
	l := f.commits(t, sourceRef("origin/main"), sourceRef("long"))
	if len(l.Commits) != CompareCommitsMax || l.Total != CompareCommitsMax+3 {
		t.Errorf("listed %d of %d", len(l.Commits), l.Total)
	}
}

// Its refusals are CompareWorktree's, and a ref gone since is an answer.
func TestCompareCommitsRefusals(t *testing.T) {
	f := newCompareFixture(t)
	if _, err := f.h.store.CompareCommits(ctx20(t), CompareCommitsRequest{ProjectID: f.id, Path: f.path, Base: sourceRef("--output=x"), Head: sourceWorking}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("an option as a ref: %v", err)
	}
	if l := f.commits(t, sourceRef("gone"), sourceWorking); !strings.Contains(l.Error, "does not name a commit") {
		t.Errorf("a ref that names nothing: %+v", l)
	}
}
