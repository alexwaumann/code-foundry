package project

import (
	"errors"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func (f compareFixture) commits(t *testing.T, base, head DiffSource) CompareLog {
	t.Helper()
	l, err := f.h.store.CompareCommits(ctx20(t), CompareCommitsRequest{ProjectID: f.id, Path: f.path, Base: base, Head: head})
	if err != nil {
		t.Fatal(err)
	}
	return l
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
	if merge.Subject != "merge side" || merge.Body != "Both halves.\n\nSecond paragraph." {
		t.Errorf("message = %q / %q", merge.Subject, merge.Body)
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

// A long branch is capped, the total counts it all, and a message's bytes cannot break the response.
func TestCompareCommitsCapAndText(t *testing.T) {
	var out strings.Builder
	for i := range 3 {
		out.WriteString(strings.Join([]string{strings.Repeat("a", 40), "aaaa", "p1 p2", strconv.Itoa(1000 + i), "bad \xff byte", "  body\n\n"}, "\x00") + "\x00")
	}
	got := parseCompareCommits([]byte(out.String()))
	if len(got) != 3 {
		t.Fatalf("parsed %d: %+v", len(got), got)
	}
	if got[0].Parent != "p1" || got[0].Subject != "bad � byte" || got[0].Body != "body" || got[1].AuthoredAt.Unix() != 1001 {
		t.Errorf("commit = %+v", got[0])
	}
	if n := len(commitText(strings.Repeat("é", commitTextMax))); n > commitTextMax {
		t.Errorf("text = %d bytes, over %d", n, commitTextMax)
	}

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
