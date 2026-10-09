package repo

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
			"refs/heads/main \n" +
				"refs/heads/alex/feat \n" +
				"refs/remotes/upstream/main \n" +
				"refs/remotes/origin/HEAD refs/remotes/origin/main\n" +
				"refs/remotes/origin/main \n" +
				"refs/remotes/origin/feature/HEAD \n",
			Refs{
				Local:  []string{"alex/feat", "main"},
				Remote: []string{"origin/feature/HEAD", "origin/main", "upstream/main"},
			},
		},
		{"crlf and unknown namespaces", "refs/heads/x \r\nrefs/tags/v1 \n", Refs{Local: []string{"x"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseRefs([]byte(tt.in))
			if !slices.Equal(got.Local, tt.want.Local) || !slices.Equal(got.Remote, tt.want.Remote) {
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
				git(t, f.repo, "branch", "alex/x")
				git(t, f.other, "checkout", "-q", "-b", "feat")
				git(t, f.other, "push", "-q", "origin", "feat")
				git(t, f.repo, "fetch", "-q")
				// A second remote is listed too.
				git(t, f.repo, "remote", "add", "upstream", f.origin)
				git(t, f.repo, "fetch", "-q", "upstream")
			},
			wantLocal:   []string{"alex/x", "main"},
			wantRemote:  []string{"origin/feat", "origin/main", "upstream/feat", "upstream/main"},
			wantDefault: "origin/main",
		},
		{
			name: "no origin: default is the local branch",
			setup: func(t *testing.T, f fixture) {
				git(t, f.repo, "remote", "remove", "origin")
				git(t, f.repo, "branch", "wip")
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
			r, err := h.store.Register(ctx, f.repo)
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

	t.Run("unknown repo", func(t *testing.T) {
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
		// setup runs before Register and returns the options (RepoID is filled in)
		// and the sha the new worktree must be at.
		setup     func(t *testing.T, f fixture) (CreateWorktreeOptions, string)
		wantFetch int    // `git fetch` runs by CreateWorktree
		wantWarn  string // substring of the warning log; empty means no warning
	}{
		{
			name: "default base is fetched",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				return CreateWorktreeOptions{Branch: "cf/fix-bug", Fetch: true}, pushCommit(t, f.other, "a")
			},
			wantFetch: 1,
		},
		{
			name: "without Fetch the stale base is used",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				stale := git(t, f.repo, "rev-parse", "origin/main")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{Branch: "cf/fix-bug"}, stale
			},
		},
		{
			name: "explicit remote base never fetched before",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.other, "checkout", "-q", "-b", "dev")
				sha := pushCommit(t, f.other, "d")
				return CreateWorktreeOptions{Branch: "cf/on-dev", BaseRef: "origin/dev", Fetch: true}, sha
			},
			wantFetch: 1,
		},
		{
			name: "local base is not fetched",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				head := git(t, f.repo, "rev-parse", "HEAD")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{Branch: "cf/local", BaseRef: "main", Fetch: true}, head
			},
		},
		{
			name: "remote branch checkout (DWIM) fetches that branch",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.other, "checkout", "-q", "-b", "shared")
				pushCommit(t, f.other, "s1")
				git(t, f.repo, "fetch", "-q")
				sha := pushCommit(t, f.other, "s2")
				return CreateWorktreeOptions{Branch: "shared", Fetch: true}, sha
			},
			wantFetch: 1,
		},
		{
			name: "unreachable remote: warning, stale base, worktree still created",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				stale := git(t, f.repo, "rev-parse", "origin/main")
				git(t, f.repo, "remote", "set-url", "origin", filepath.Join(f.base, "gone.git"))
				return CreateWorktreeOptions{Branch: "cf/offline", Fetch: true}, stale
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
			r, err := h.store.Register(ctx, f.repo)
			if err != nil {
				t.Fatal(err)
			}
			opts.RepoID = r.ID
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

// The session store resolves the worktree from the snapshot as soon as
// CreateWorktree returns, so it must already be there, at the documented path for a
// branch with a "/".
func TestCreateWorktreeIsInSnapshotOnReturn(t *testing.T) {
	f := newFixture(t)
	root := filepath.Join(f.base, "wt")
	h := startHarness(t, "", Options{WorktreeRoot: root})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	w, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "cf/add-login-page", Fetch: true})
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
