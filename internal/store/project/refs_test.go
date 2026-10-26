package project

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestParseRefs(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want Refs
	}{
		{"empty", "", Refs{}},
		{
			"locals and remotes sorted, symbolic HEAD dropped",
			"refs/heads/main\t\t300\n" +
				"refs/heads/alex/feat\t\t100\n" +
				"refs/remotes/upstream/main\t\t900\n" +
				"refs/remotes/origin/HEAD\trefs/remotes/origin/main\t400\n" +
				"refs/remotes/origin/main\t\t400\n" +
				"refs/remotes/origin/feature/HEAD\t\t200\n",
			Refs{
				Local:  []string{"alex/feat", "main"},
				Remote: []string{"origin/feature/HEAD", "origin/main", "upstream/main"},
				// main's newer copy is origin's (400); upstream's branches are not the
				// project's; origin/HEAD is a symref.
				Branches: []string{"main", "feature/HEAD", "alex/feat"},
			},
		},
		{
			"branches: deduped by name, newest copy wins, ties by name",
			"refs/heads/b\t\t500\n" +
				"refs/remotes/origin/b\t\t100\n" +
				"refs/heads/a\t\t200\n" +
				"refs/remotes/origin/c\t\t200\n" +
				"refs/remotes/origin/d\t\t700\n",
			Refs{
				Local:    []string{"a", "b"},
				Remote:   []string{"origin/b", "origin/c", "origin/d"},
				Branches: []string{"d", "b", "a", "c"},
			},
		},
		{"crlf and unknown namespaces", "refs/heads/x\t\t1\r\nrefs/tags/v1\t\t2\n", Refs{Local: []string{"x"}, Branches: []string{"x"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseRefs([]byte(tt.in))
			if !slices.Equal(got.Local, tt.want.Local) || !slices.Equal(got.Remote, tt.want.Remote) ||
				!slices.Equal(got.Branches, tt.want.Branches) {
				t.Fatalf("parseRefs = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestSplitRemoteRef(t *testing.T) {
	remotes := []string{"origin", "up", "up/stream"}
	tests := []struct {
		ref, remote, branch string
	}{
		{"origin/main", "origin", "main"},
		{"origin/cf/fix-bug", "origin", "cf/fix-bug"},
		{"up/stream/dev", "up/stream", "dev"}, // longest remote wins
		{"up/dev", "up", "dev"},
		{"origin/HEAD", "", ""},
		{"origin/", "", ""},
		{"main", "", ""},
		{"other/main", "", ""},
		{"HEAD", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.ref, func(t *testing.T) {
			r, b := splitRemoteRef(remotes, tt.ref)
			if r != tt.remote || b != tt.branch {
				t.Fatalf("splitRemoteRef(%q) = %q, %q; want %q, %q", tt.ref, r, b, tt.remote, tt.branch)
			}
		})
	}
}

func TestListRefs(t *testing.T) {
	tests := []struct {
		name        string
		setup       func(t *testing.T, f fixture)
		wantLocal   []string
		wantRemote  []string
		wantDefault string
	}{
		{
			name: "local and remote-tracking refs, default on origin",
			setup: func(t *testing.T, f fixture) {
				git(t, f.project, "branch", "alex/x")
				git(t, f.other, "checkout", "-q", "-b", "feat")
				git(t, f.other, "push", "-q", "origin", "feat")
				git(t, f.project, "fetch", "-q")
				// A second remote is listed too.
				git(t, f.project, "remote", "add", "upstream", f.origin)
				git(t, f.project, "fetch", "-q", "upstream")
			},
			wantLocal:  []string{"alex/x", "main"},
			wantRemote: []string{"origin/feat", "origin/main", "upstream/feat", "upstream/main"},
			// The branch, not which copy: CreateWorktree decides that at creation.
			wantDefault: "main",
		},
		{
			name: "only origin has the default branch: origin's copy",
			setup: func(t *testing.T, f fixture) {
				git(t, f.project, "checkout", "-q", "-b", "wip")
				git(t, f.project, "branch", "-D", "main")
			},
			wantLocal:   []string{"wip"},
			wantRemote:  []string{"origin/main"},
			wantDefault: "origin/main",
		},
		{
			name: "no origin: default is the local branch",
			setup: func(t *testing.T, f fixture) {
				git(t, f.project, "remote", "remove", "origin")
				git(t, f.project, "branch", "wip")
			},
			wantLocal:   []string{"main", "wip"},
			wantDefault: "main",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			tt.setup(t, f)
			h := startHarness(t, "", Options{})
			ctx := context.Background()
			r, err := h.store.Register(ctx, f.project)
			if err != nil {
				t.Fatal(err)
			}
			got, err := h.store.ListRefs(ctx, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got.Local, tt.wantLocal) || !slices.Equal(got.Remote, tt.wantRemote) ||
				got.DefaultRef != tt.wantDefault {
				t.Fatalf("ListRefs = %+v, want local %v remote %v default %q",
					got, tt.wantLocal, tt.wantRemote, tt.wantDefault)
			}
		})
	}

	// Branches: local and origin's branches merged by name, the newest commit first.
	t.Run("branches by recency", func(t *testing.T) {
		f := newFixture(t)
		dated := func(date string) string {
			t.Setenv("GIT_COMMITTER_DATE", date)
			return git(t, f.project, "commit-tree", "-p", "main", "-m", date, "main^{tree}")
		}
		// both: origin's copy is newer than the local one; mine: the local one is.
		git(t, f.project, "push", "-q", "origin", dated("2032-01-01T00:00:00Z")+":refs/heads/both")
		git(t, f.project, "branch", "both", dated("2030-01-01T00:00:00Z"))
		git(t, f.project, "push", "-q", "origin", dated("2000-01-01T00:00:00Z")+":refs/heads/mine")
		git(t, f.project, "branch", "mine", dated("2033-01-01T00:00:00Z"))
		// feat only on origin, old only local.
		git(t, f.project, "push", "-q", "origin", dated("2031-01-01T00:00:00Z")+":refs/heads/feat")
		git(t, f.project, "branch", "old", dated("2001-01-01T00:00:00Z"))
		// Another remote's branches are not listed, however new.
		upstream := filepath.Join(f.base, "upstream.git")
		git(t, f.base, "init", "-q", "--bare", "-b", "main", upstream)
		git(t, f.project, "remote", "add", "upstream", upstream)
		git(t, f.project, "push", "-q", "upstream", dated("2035-01-01T00:00:00Z")+":refs/heads/up-only")
		git(t, f.project, "fetch", "-q", "origin")
		git(t, f.project, "fetch", "-q", "upstream")

		h := startHarness(t, "", Options{})
		ctx := context.Background()
		r, err := h.store.Register(ctx, f.project)
		if err != nil {
			t.Fatal(err)
		}
		got, err := h.store.ListRefs(ctx, r.ID)
		if err != nil {
			t.Fatal(err)
		}
		// main's commit is from the test run (between 2001 and 2030).
		want := []string{"mine", "both", "feat", "main", "old"}
		if !slices.Equal(got.Branches, want) {
			t.Errorf("Branches = %v, want %v", got.Branches, want)
		}
		if got.DefaultBranch != "main" || got.DefaultRef != "main" {
			t.Errorf("DefaultBranch = %q, DefaultRef = %q, want main, main", got.DefaultBranch, got.DefaultRef)
		}
		if !slices.Contains(got.Remote, "upstream/up-only") {
			t.Errorf("Remote = %v, want upstream/up-only listed", got.Remote)
		}
	})

	t.Run("unknown project", func(t *testing.T) {
		isolateGit(t)
		h := startHarness(t, "", Options{})
		if _, err := h.store.ListRefs(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

// syncBuffer is a bytes.Buffer safe for the store's concurrent loggers.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// pushCommit commits a new file on dir's current branch, pushes it to origin, and
// returns the new sha.
func pushCommit(t *testing.T, dir, name string) string {
	t.Helper()
	writeFile(t, filepath.Join(dir, name), name+"\n")
	git(t, dir, "add", name)
	git(t, dir, "commit", "-q", "-m", name)
	git(t, dir, "push", "-q", "origin", "HEAD")
	return git(t, dir, "rev-parse", "HEAD")
}

func TestCreateWorktreeFetch(t *testing.T) {
	tests := []struct {
		name string
		// setup runs before Register and returns the options (ProjectID is filled in)
		// and the sha the new worktree must be at.
		setup     func(t *testing.T, f fixture) (CreateWorktreeOptions, string)
		wantFetch int    // `git fetch` runs by CreateWorktree
		wantWarn  string // substring of the warning log; empty means no warning
	}{
		{
			name: "default base is fetched",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				return CreateWorktreeOptions{Branch: "cf/fix-bug", Fetch: true, BaseFromOrigin: true}, pushCommit(t, f.other, "a")
			},
			wantFetch: 1,
		},
		{
			name: "without Fetch the stale base is used",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				stale := git(t, f.project, "rev-parse", "origin/main")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{Branch: "cf/fix-bug", BaseFromOrigin: true}, stale
			},
		},
		{
			name: "explicit remote base never fetched before",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.other, "checkout", "-q", "-b", "dev")
				sha := pushCommit(t, f.other, "d")
				return CreateWorktreeOptions{Branch: "cf/on-dev", BaseRef: "origin/dev", Fetch: true, BaseFromOrigin: true}, sha
			},
			wantFetch: 1,
		},
		{
			name: "local base is not fetched without BaseFromOrigin",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				head := git(t, f.project, "rev-parse", "HEAD")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{Branch: "cf/local", BaseRef: "main", Fetch: true}, head
			},
		},
		{
			name: "remote branch checkout (DWIM) fetches that branch",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.other, "checkout", "-q", "-b", "shared")
				pushCommit(t, f.other, "s1")
				git(t, f.project, "fetch", "-q")
				sha := pushCommit(t, f.other, "s2")
				return CreateWorktreeOptions{Branch: "shared", Fetch: true}, sha
			},
			wantFetch: 1,
		},
		{
			name: "unreachable remote: warning, stale base, worktree still created",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				stale := git(t, f.project, "rev-parse", "origin/main")
				git(t, f.project, "remote", "set-url", "origin", filepath.Join(f.base, "gone.git"))
				return CreateWorktreeOptions{Branch: "cf/offline", Fetch: true, BaseFromOrigin: true}, stale
			},
			wantFetch: 1,
			wantWarn:  "fetch before worktree failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			opts, wantHead := tt.setup(t, f)
			logs := &syncBuffer{}
			cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
			h := startHarness(t, "", Options{
				Runner:       cr,
				WorktreeRoot: filepath.Join(f.base, "wt"),
				Log:          slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelWarn})),
			})
			ctx := context.Background()
			r, err := h.store.Register(ctx, f.project)
			if err != nil {
				t.Fatal(err)
			}
			opts.ProjectID = r.ID
			before := cr.count("fetch")
			w, err := h.store.CreateWorktree(ctx, opts)
			if err != nil {
				t.Fatal(err)
			}
			if got := cr.count("fetch") - before; got != tt.wantFetch {
				t.Errorf("fetches = %d, want %d", got, tt.wantFetch)
			}
			if w.Head != wantHead {
				t.Errorf("head = %s, want %s", w.Head, wantHead)
			}
			if w.Branch != opts.Branch {
				t.Errorf("branch = %q, want %q", w.Branch, opts.Branch)
			}
			log := logs.String()
			if tt.wantWarn == "" && strings.Contains(log, "level=WARN") {
				t.Errorf("unexpected warning: %s", log)
			}
			if tt.wantWarn != "" && !strings.Contains(log, tt.wantWarn) {
				t.Errorf("log = %q, want a warning containing %q", log, tt.wantWarn)
			}
		})
	}
}

// The thread store resolves the worktree from the snapshot as soon as
// CreateWorktree returns, so it must already be there, at the documented path for a
// branch with a "/".
func TestCreateWorktreeIsInSnapshotOnReturn(t *testing.T) {
	f := newFixture(t)
	root := filepath.Join(f.base, "wt")
	h := startHarness(t, "", Options{WorktreeRoot: root})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/add-login-page", Fetch: true})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "_local", "proj", "cf-add-login-page")
	if w.Path != want {
		t.Fatalf("path = %s, want %s", w.Path, want)
	}
	got, ok := h.store.Snapshot().Worktree(r.ID, want)
	if !ok {
		t.Fatalf("worktree %s missing from the snapshot right after CreateWorktree", want)
	}
	if got.Branch != "cf/add-login-page" || got.IsMain || got.Head == "" {
		t.Fatalf("snapshot worktree = %+v", got)
	}
}
