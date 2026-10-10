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
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// fakeRepos is an in-memory Repos: Register adds a git project at the path, Refresh
// applies onRefresh (what the reconcile would discover).
type fakeRepos struct {
	mu         sync.Mutex
	repos      map[string]repo.Repo
	registered []string
	refreshed  []string
	regErr     error
	onRefresh  func(*repo.Repo)
}

func newFakeRepos(rs ...repo.Repo) *fakeRepos {
	f := &fakeRepos{repos: map[string]repo.Repo{}}
	for _, r := range rs {
		f.repos[r.ID] = r
	}
	return f
}

func (f *fakeRepos) Snapshot() *repo.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &repo.Snapshot{}
	for _, r := range f.repos {
		s.Repos = append(s.Repos, r)
	}
	return s
}

func (f *fakeRepos) Register(_ context.Context, path string) (repo.Repo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.registered = append(f.registered, path)
	if f.regErr != nil {
		return repo.Repo{}, f.regErr
	}
	r := repo.Repo{ID: "id-" + filepath.Base(path), Path: path, Name: filepath.Base(path), Git: true, DefaultBranch: "main"}
	f.repos[r.ID] = r
	return r, nil
}

func (f *fakeRepos) Refresh(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refreshed = append(f.refreshed, id)
	r, ok := f.repos[id]
	if !ok {
		return fmt.Errorf("%w: %s", repo.ErrNotFound, id)
	}
	if f.onRefresh != nil {
		f.onRefresh(&r)
		f.repos[id] = r
	}
	return nil
}

// fakeGit plays git: init creates .git; fail makes the named subcommand fail.
type fakeGit struct {
	mu    sync.Mutex
	calls []string
	fail  string
}

func (g *fakeGit) Run(_ context.Context, dir string, args ...string) ([]byte, error) {
	g.mu.Lock()
	g.calls = append(g.calls, strings.Join(args, " "))
	g.mu.Unlock()
	if len(args) > 0 && args[0] == g.fail {
		return nil, &repo.GitError{Dir: dir, Args: args, ExitCode: 128, Stderr: "fatal: " + g.fail + " failed"}
	}
	switch args[0] {
	case "config":
		return []byte("trunk\n"), nil
	case "init":
		return nil, os.Mkdir(filepath.Join(dir, ".git"), 0o755)
	}
	return nil, nil
}

func TestValidateName(t *testing.T) {
	tests := []struct {
		name string
		ok   bool
	}{
		{"my-project", true},
		{"My_Project.v2", true},
		{"a", true},
		{"x.", true},
		{strings.Repeat("a", MaxNameLength), true},
		{"", false},
		{".", false},
		{"..", false},
		{".hidden", false},
		{"a/b", false},
		{"/abs", false},
		{"has space", false},
		{"tab\tname", false},
		{"emoji-✨", false},
		{"semi;colon", false},
		{"back\\slash", false},
		{strings.Repeat("a", MaxNameLength+1), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateName(tt.name)
			if (err == nil) != tt.ok {
				t.Fatalf("ValidateName(%q) = %v, want ok %t", tt.name, err, tt.ok)
			}
			if err != nil && !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("err = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestCreate(t *testing.T) {
	tests := []struct {
		name     string
		project  string
		setup    func(t *testing.T, root string)
		gitFail  string
		regErr   error
		outside  bool
		err      error
		errText  string
		wantDir  bool // the folder exists afterwards
		wantGit  []string
		register bool
	}{
		{name: "creates, inits and registers", project: "demo", wantDir: true, register: true,
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m Initial commit"}},
		{name: "invalid name", project: "../x", err: ErrInvalidArgument},
		{name: "folder exists", project: "taken", err: ErrExists, wantDir: true, setup: func(t *testing.T, root string) {
			if err := os.MkdirAll(filepath.Join(root, "taken"), 0o755); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "a file of that name exists", project: "file", err: ErrExists, wantDir: true, setup: func(t *testing.T, root string) {
			if err := os.MkdirAll(root, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "file"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "git init fails: nothing left", project: "broken", gitFail: "init", err: ErrFailed, errText: "fatal: init failed",
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk"}},
		{name: "initial commit fails: nothing left", project: "nocommit", gitFail: "commit", err: ErrFailed, errText: "fatal: commit failed",
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m Initial commit"}},
		{name: "register fails: the folder stays", project: "unreg", regErr: errors.New("boom"), errText: "could not add it as a project: boom",
			wantDir: true, register: true,
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m Initial commit"}},
		{name: "projects dir outside the allowed root", project: "out", outside: true, err: ErrOutsideRoot},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			root := filepath.Join(home, ".code-foundry", "projects")
			if tt.setup != nil {
				tt.setup(t, root)
			}
			allowed := home
			if tt.outside {
				allowed = filepath.Join(home, "elsewhere")
			}
			repos := newFakeRepos()
			repos.regErr = tt.regErr
			g := &fakeGit{fail: tt.gitFail}
			s, err := New(Options{Root: root, AllowedRoot: resolve(t, allowed), Repos: repos, Git: g})
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Create(context.Background(), tt.project)
			switch {
			case tt.err != nil && !errors.Is(err, tt.err):
				t.Fatalf("err = %v, want %v", err, tt.err)
			case tt.err == nil && tt.errText == "" && err != nil:
				t.Fatal(err)
			case tt.errText != "" && (err == nil || !strings.Contains(err.Error(), tt.errText)):
				t.Fatalf("err = %v, want it to contain %q", err, tt.errText)
			}
			dest := filepath.Join(root, tt.project)
			if _, statErr := os.Stat(dest); (statErr == nil) != tt.wantDir {
				t.Errorf("folder exists = %t, want %t", statErr == nil, tt.wantDir)
			}
			if fmt.Sprint(g.calls) != fmt.Sprint(tt.wantGit) {
				t.Errorf("git calls = %q, want %q", g.calls, tt.wantGit)
			}
			if got := len(repos.registered) > 0; got != tt.register {
				t.Errorf("registered = %t, want %t", got, tt.register)
			}
			if err == nil {
				if r.Path != dest || !r.Git {
					t.Errorf("repo = %+v", r)
				}
				fi, _ := os.Stat(dest)
				if fi.Mode().Perm() != 0o755 {
					t.Errorf("mode = %v, want 0755", fi.Mode().Perm())
				}
			}
		})
	}
}

func resolve(t *testing.T, p string) string {
	t.Helper()
	if err := os.MkdirAll(p, 0o700); err != nil {
		t.Fatal(err)
	}
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// TestCreateRealGit runs Create with git itself: the branch comes from
// init.defaultBranch and HEAD is one empty commit.
func TestCreateRealGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	content := "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = trunk\n[commit]\n\tgpgsign = false\n"
	if err := os.WriteFile(cfg, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	home := t.TempDir()
	root := filepath.Join(home, "projects")
	s, err := New(Options{Root: root, AllowedRoot: resolve(t, home), Repos: newFakeRepos()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(context.Background(), "real"); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("git", "-C", filepath.Join(root, "real"), "log", "--format=%s", "--branches").CombinedOutput()
	if err != nil {
		t.Fatalf("git log: %v\n%s", err, out)
	}
	if strings.TrimSpace(string(out)) != "Initial commit" {
		t.Errorf("log = %q", out)
	}
	head, _ := exec.Command("git", "-C", filepath.Join(root, "real"), "symbolic-ref", "--short", "HEAD").Output()
	if strings.TrimSpace(string(head)) != "trunk" {
		t.Errorf("HEAD = %q, want trunk", head)
	}
}

// fakeGh plays gh repo create.
type fakeGh struct {
	mu    sync.Mutex
	calls [][]string
	dirs  []string
	err   error
	block bool
	ran   chan struct{}
}

func (f *fakeGh) Run(ctx context.Context, dir, name string, args []string, _ func(clone.Progress)) error {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string{name}, args...))
	f.dirs = append(f.dirs, dir)
	f.mu.Unlock()
	if f.ran != nil {
		f.ran <- struct{}{}
	}
	if f.block {
		<-ctx.Done()
		return &clone.ExitError{ExitCode: -1, Err: ctx.Err()}
	}
	return f.err
}

func TestPublish(t *testing.T) {
	local := repo.Repo{ID: "r1", Name: "demo", Path: "/home/me/projects/demo", Git: true}
	plain := repo.Repo{ID: "r2", Name: "notes", Path: "/home/me/notes"}
	withOrigin := repo.Repo{ID: "r3", Name: "cf", Path: "/home/me/cf", Git: true, Remotes: []string{"origin"}, GitHubSlug: "me/cf"}
	upstreamOnly := repo.Repo{ID: "r4", Name: "fork", Path: "/home/me/fork", Git: true, Remotes: []string{"upstream"}}
	ghTail := "GraphQL: Visibility can't be private. Organization policy: only internal and public repositories (createRepository)"

	tests := []struct {
		name      string
		opts      PublishOptions
		ghErr     error
		err       error
		errExact  string // the whole message, for gh's verbatim errors
		wantArgs  []string
		refreshed bool
	}{
		{name: "public to the user", opts: PublishOptions{RepoID: "r1", Owner: "me", Visibility: Public},
			wantArgs: []string{"gh", "repo", "create", "me/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--public"}, refreshed: true},
		{name: "internal to an org under another name", opts: PublishOptions{RepoID: "r1", Owner: "octo-org", Name: "demo-app", Visibility: "INTERNAL"},
			wantArgs: []string{"gh", "repo", "create", "octo-org/demo-app", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--internal"}, refreshed: true},
		{name: "a remote other than origin is fine", opts: PublishOptions{RepoID: "r4", Owner: "me", Visibility: Private},
			wantArgs: []string{"gh", "repo", "create", "me/fork", "--source", "/home/me/fork", "--remote", "origin", "--push", "--private"}, refreshed: true},
		{name: "gh refuses: its words verbatim, refreshed anyway", opts: PublishOptions{RepoID: "r1", Owner: "octo-org", Visibility: Private},
			ghErr: &clone.ExitError{ExitCode: 1, Tail: []string{ghTail}}, err: ErrFailed, errExact: ghTail,
			wantArgs: []string{"gh", "repo", "create", "octo-org/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--private"}, refreshed: true},
		{name: "gh missing", opts: PublishOptions{RepoID: "r1", Owner: "me", Visibility: Public},
			ghErr: &clone.ExitError{ExitCode: -1, Err: exec.ErrNotFound}, err: ErrFailed,
			wantArgs: []string{"gh", "repo", "create", "me/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--public"}, refreshed: true},
		{name: "bad visibility", opts: PublishOptions{RepoID: "r1", Owner: "me", Visibility: "secret"}, err: ErrInvalidArgument},
		{name: "no owner", opts: PublishOptions{RepoID: "r1", Visibility: Public}, err: ErrInvalidArgument},
		{name: "bad name", opts: PublishOptions{RepoID: "r1", Owner: "me", Name: "a b", Visibility: Public}, err: ErrInvalidArgument},
		{name: "unknown project", opts: PublishOptions{RepoID: "nope", Owner: "me", Visibility: Public}, err: ErrNotFound},
		{name: "not git", opts: PublishOptions{RepoID: "r2", Owner: "me", Visibility: Public}, err: ErrFailedPrecondition},
		{name: "already has origin", opts: PublishOptions{RepoID: "r3", Owner: "me", Visibility: Public}, err: ErrFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repos := newFakeRepos(local, plain, withOrigin, upstreamOnly)
			repos.onRefresh = func(r *repo.Repo) {
				if tt.ghErr == nil {
					r.Remotes = append(r.Remotes, "origin")
					slices.Sort(r.Remotes)
					r.GitHubSlug = strings.ToLower(tt.opts.Owner + "/" + r.Name)
				}
			}
			f := &fakeGh{err: tt.ghErr}
			s, err := New(Options{Root: "/home/me/.code-foundry/projects", Repos: repos, Runner: f, Gh: "gh"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := s.Publish(context.Background(), tt.opts)
			if tt.err != nil {
				if !errors.Is(err, tt.err) {
					t.Fatalf("err = %v, want %v", err, tt.err)
				}
				if tt.errExact != "" && err.Error() != tt.errExact {
					t.Errorf("message = %q, want gh's %q", err.Error(), tt.errExact)
				}
			} else if err != nil {
				t.Fatal(err)
			} else if !slices.Contains(r.Remotes, "origin") {
				t.Errorf("returned repo has no origin: %+v", r)
			}
			var got []string
			if len(f.calls) > 0 {
				got = f.calls[0]
				if f.dirs[0] != got[5] {
					t.Errorf("ran in %s, want the project path", f.dirs[0])
				}
			}
			if fmt.Sprint(got) != fmt.Sprint(tt.wantArgs) {
				t.Errorf("gh args = %q, want %q", got, tt.wantArgs)
			}
			if (len(repos.refreshed) > 0) != tt.refreshed {
				t.Errorf("refreshed = %v, want %t", repos.refreshed, tt.refreshed)
			}
		})
	}
}

func TestPublishBusyAndTimeout(t *testing.T) {
	local := repo.Repo{ID: "r1", Name: "demo", Path: "/home/me/demo", Git: true}
	repos := newFakeRepos(local)
	f := &fakeGh{block: true, ran: make(chan struct{}, 1)}
	s, err := New(Options{Root: "/home/me/p", Repos: repos, Runner: f, PublishTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.Publish(context.Background(), PublishOptions{RepoID: "r1", Owner: "me", Visibility: Public})
		done <- err
	}()
	<-f.ran
	if _, err := s.Publish(context.Background(), PublishOptions{RepoID: "r1", Owner: "me", Visibility: Public}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("second publish: err = %v, want ErrFailedPrecondition (busy)", err)
	}
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want DeadlineExceeded", err)
	}

	// Cancelled by the caller.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-f.ran
		cancel()
	}()
	if _, err := s.Publish(ctx, PublishOptions{RepoID: "r1", Owner: "me", Visibility: Public}); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want Canceled", err)
	}
}
