package repo

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newPlainDir creates a directory outside any git repository.
func newPlainDir(t *testing.T) string {
	t.Helper()
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(base, "notes")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "todo.md"), "- things\n")
	return dir
}

// gitRuns counts every git invocation.
func (c *countingRunner) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, v := range c.n {
		n += v
	}
	return n
}

func TestProbeGit(t *testing.T) {
	base := t.TempDir()
	plain := filepath.Join(base, "plain")
	withGit := filepath.Join(base, "repo")
	gitFile := filepath.Join(base, "linked")
	file := filepath.Join(base, "file")
	for _, d := range []string{plain, filepath.Join(withGit, ".git"), gitFile} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(gitFile, ".git"), "gitdir: /elsewhere\n")
	writeFile(t, file, "x")
	tests := []struct {
		name    string
		dir     string
		want    bool
		wantErr bool
	}{
		{"plain directory", plain, false, false},
		{".git directory", withGit, true, false},
		{".git file", gitFile, true, false},
		{"missing", filepath.Join(base, "missing"), false, true},
		{"a file", file, false, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := probeGit(tt.dir)
			if got != tt.want || (err != nil) != tt.wantErr {
				t.Fatalf("probeGit = %v, %v; want %v, err %v", got, err, tt.want, tt.wantErr)
			}
		})
	}
}

func TestIsNotARepository(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"not a repository", &GitError{ExitCode: 128, Stderr: "fatal: not a git repository (or any of the parent directories): .git\n"}, true},
		{"other fatal", &GitError{ExitCode: 128, Stderr: "fatal: detected dubious ownership in repository"}, false},
		{"git missing", &GitError{ExitCode: -1, Err: errors.New("exec: \"git\": executable file not found")}, false},
		{"not a GitError", errors.New("not a git repository"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isNotARepository(tt.err); got != tt.want {
				t.Fatalf("isNotARepository = %v, want %v", got, tt.want)
			}
		})
	}
}

// A directory outside any repository registers as a project without git: one
// synthetic main checkout, and no git command after the registration's rev-parse.
func TestRegisterPlainDirectory(t *testing.T) {
	dir := newPlainDir(t)
	cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
	h := startHarness(t, "", Options{Runner: cr})
	ctx := context.Background()

	link := filepath.Join(filepath.Dir(dir), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	r, err := h.store.Register(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	want := Worktree{RepoID: r.ID, Path: dir, IsMain: true}
	if r.Git || r.Path != dir || r.Name != "notes" || r.ID != repoID(dir) || r.DefaultBranch != "" ||
		r.GitHubSlug != "" || len(r.Remotes) != 0 || r.Error != "" || len(r.Worktrees) != 1 || r.Worktrees[0] != want {
		t.Fatalf("repo = %+v", r)
	}
	if n := cr.count("rev-parse"); n != 1 || cr.total() != 1 {
		t.Fatalf("git runs = %v, want only the registration's rev-parse", cr.n)
	}
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if cr.total() != 1 {
		t.Fatalf("refresh ran git: %v", cr.n)
	}
	got, _ := h.store.Snapshot().Repo(r.ID)
	if got.Git || len(got.Worktrees) != 1 || got.Worktrees[0] != want {
		t.Fatalf("after refresh = %+v", got)
	}
	// Idempotent, from the real path too.
	again, err := h.store.Register(ctx, dir)
	if err != nil || again.ID != r.ID {
		t.Fatalf("re-register = %+v, %v", again, err)
	}
}

func TestPlainProjectRefusesGitOperations(t *testing.T) {
	dir := newPlainDir(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		call func() error
	}{
		{"CreateWorktree", func() error {
			_, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "cf/x", Fetch: true})
			return err
		}},
		{"RemoveWorktree", func() error {
			return h.store.RemoveWorktree(ctx, RemoveWorktreeOptions{RepoID: r.ID, Path: dir})
		}},
		{"ListRefs", func() error { _, err := h.store.ListRefs(ctx, r.ID); return err }},
		{"WorktreeDetail", func() error { _, err := h.store.WorktreeDetail(ctx, r.ID, dir); return err }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			if !errors.Is(err, ErrFailedPrecondition) || !errors.Is(err, ErrNotGit) {
				t.Fatalf("err = %v, want ErrFailedPrecondition wrapping ErrNotGit", err)
			}
		})
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf(".git appeared: %v", err)
	}
}

func TestInitGit(t *testing.T) {
	tests := []struct {
		name string
		// config is the global git config's [init] section ("" for none).
		config     string
		wantBranch string
	}{
		{"init.defaultBranch unset", "", "main"},
		{"init.defaultBranch set", "[init]\n\tdefaultBranch = trunk\n", "trunk"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := newPlainDir(t)
			cfg := filepath.Join(t.TempDir(), "gitconfig")
			writeFile(t, cfg, "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n"+tt.config)
			t.Setenv("GIT_CONFIG_GLOBAL", cfg)
			h := startHarness(t, "", Options{})
			ctx := context.Background()
			r, err := h.store.Register(ctx, dir)
			if err != nil {
				t.Fatal(err)
			}
			got, err := h.store.InitGit(ctx, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !got.Git || got.ID != r.ID || got.DefaultBranch != tt.wantBranch || len(got.Worktrees) != 1 {
				t.Fatalf("repo = %+v", got)
			}
			w := got.Worktrees[0]
			if !w.IsMain || w.Branch != tt.wantBranch || len(w.Head) != 40 || w.Status.RefreshedAt.IsZero() {
				t.Fatalf("main worktree = %+v", w)
			}
			// The untracked file is left alone; the commit is empty.
			if w.Status.Untracked != 1 || w.Status.Staged != 0 {
				t.Fatalf("status = %+v", w.Status)
			}
			if subj := git(t, dir, "log", "--format=%s"); subj != "Initial commit" {
				t.Fatalf("log = %q", subj)
			}
			// The watcher is live now: a commit is seen without a refresh.
			git(t, dir, "add", ".")
			git(t, dir, "commit", "-q", "-m", "todo")
			h.waitFor("commit seen", worktreeUpdated(dir, func(x Worktree) bool { return x.Head != w.Head && !x.Status.Dirty }))

			if _, err := h.store.InitGit(ctx, r.ID); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "already a git repository") {
				t.Fatalf("second InitGit err = %v", err)
			}
			// New worktrees branch from the main checkout's branch (no origin).
			wt, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{RepoID: r.ID, Branch: "cf/next", Fetch: true})
			if err != nil {
				t.Fatal(err)
			}
			if want := git(t, dir, "rev-parse", "HEAD"); wt.Head != want {
				t.Fatalf("new worktree at %s, want %s", wt.Head, want)
			}
		})
	}
}

func TestInitGitErrors(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.InitGit(ctx, r.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("InitGit(git repo) err = %v", err)
	}
	if _, err := h.store.InitGit(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("InitGit(unknown) err = %v", err)
	}
}

// `git init` outside the app is noticed by the poll loop: the project becomes a git
// project with its branch in the same event.
func TestExternalGitInitIsDetected(t *testing.T) {
	dir := newPlainDir(t)
	h := startHarness(t, "", Options{PollInterval: 100 * time.Millisecond})
	r, err := h.store.Register(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q", "-b", "main")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "first")
	h.waitFor("git project", func(ev Event) bool {
		u, ok := ev.(RepoUpdated)
		return ok && u.Repo.ID == r.ID && u.Repo.Git && u.Repo.DefaultBranch == "main" &&
			len(u.Repo.Worktrees) == 1 && u.Repo.Worktrees[0].Branch == "main"
	})
	h.waitFor("status", worktreeUpdated(dir, func(w Worktree) bool { return w.Status.Untracked == 1 }))
}

// Git is known from disk when the daemon starts, before the first reconcile, so a
// git project never shows as one without git.
func TestGitIsKnownOnLoad(t *testing.T) {
	plain := newPlainDir(t)
	f := newFixture(t)
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	for _, p := range []string{plain, f.repo} {
		if _, err := h.store.Register(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	h.close()
	// A runner that never answers: the snapshot comes from load alone.
	h2 := startHarness(t, dbPath, Options{Runner: blockedRunner{}})
	got := map[string]bool{}
	for _, r := range h2.store.Snapshot().Repos {
		got[r.Path] = r.Git
	}
	if got[plain] || !got[f.repo] || len(got) != 2 {
		t.Fatalf("git by path on load = %v", got)
	}
}

// blockedRunner waits for cancellation.
type blockedRunner struct{}

func (blockedRunner) Run(ctx context.Context, _ string, _ ...string) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestDefaultBranch(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T) string
		want  string
	}{
		{
			name: "no origin: the main checkout's branch",
			setup: func(t *testing.T) string {
				dir := newLocalRepo(t)
				git(t, dir, "checkout", "-q", "-b", "develop")
				return dir
			},
			want: "develop",
		},
		{
			name: "no origin, other remotes: still HEAD",
			setup: func(t *testing.T) string {
				dir := newLocalRepo(t)
				git(t, dir, "remote", "add", "upstream", "https://github.com/acme/momentum.git")
				git(t, dir, "checkout", "-q", "-b", "develop")
				return dir
			},
			want: "develop",
		},
		{
			name: "no origin, unborn branch",
			setup: func(t *testing.T) string {
				dir := newPlainDir(t)
				git(t, dir, "init", "-q", "-b", "trunk")
				return dir
			},
			want: "trunk",
		},
		{
			name: "origin: origin/HEAD, whatever is checked out",
			setup: func(t *testing.T) string {
				f := newFixture(t)
				git(t, f.repo, "checkout", "-q", "-b", "develop")
				return f.repo
			},
			want: "main",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := tt.setup(t)
			h := startHarness(t, "", Options{})
			r, err := h.store.Register(context.Background(), dir)
			if err != nil {
				t.Fatal(err)
			}
			if r.DefaultBranch != tt.want || !r.Git {
				t.Fatalf("default branch = %q (git %v), want %q", r.DefaultBranch, r.Git, tt.want)
			}
		})
	}
}

func TestSnapshotOwner(t *testing.T) {
	s := &Snapshot{Repos: []Repo{
		{ID: "a", Path: "/a", Worktrees: []Worktree{{RepoID: "a", Path: "/a", IsMain: true}, {RepoID: "a", Path: "/wt/a-x"}}},
		{ID: "b", Path: "/b", Worktrees: []Worktree{{RepoID: "b", Path: "/b", IsMain: true}}},
	}}
	tests := []struct {
		name         string
		repoID, path string
		want         string
	}{
		{"worktree wins", "b", "/wt/a-x", "a"},
		{"main worktree", "", "/b", "b"},
		{"unknown path falls back to id", "b", "/elsewhere", "b"},
		{"id only", "a", "", "a"},
		{"nothing", "", "", ""},
		{"unknown", "z", "/z", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, ok := s.Owner(tt.repoID, tt.path)
			if r.ID != tt.want || ok != (tt.want != "") {
				t.Fatalf("Owner = %q, %v; want %q", r.ID, ok, tt.want)
			}
		})
	}
	if _, ok := (*Snapshot)(nil).Owner("a", "/a"); ok {
		t.Fatal("nil snapshot found a repo")
	}
}
