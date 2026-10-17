package newproject

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
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// fakeProjects is an in-memory Projects: Register adds a git project at the path, Refresh
// applies onRefresh (what the reconcile would discover).
type fakeProjects struct {
	mu           sync.Mutex
	projects     map[string]project.Project
	registered   []string
	refreshed    []string
	unregistered []string
	regErr       error
	unregErr     error
	onRefresh    func(*project.Project)
}

func newFakeProjects(rs ...project.Project) *fakeProjects {
	f := &fakeProjects{projects: map[string]project.Project{}}
	for _, r := range rs {
		f.projects[r.ID] = r
	}
	return f
}

func (f *fakeProjects) Snapshot() *project.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &project.Snapshot{}
	for _, r := range f.projects {
		s.Projects = append(s.Projects, r)
	}
	return s
}

func (f *fakeProjects) Register(_ context.Context, path string) (project.Project, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.registered = append(f.registered, path)
	if f.regErr != nil {
		return project.Project{}, f.regErr
	}
	r := project.Project{ID: "id-" + filepath.Base(path), Path: path, Name: filepath.Base(path), Git: true, DefaultBranch: "main"}
	f.projects[r.ID] = r
	return r, nil
}

func (f *fakeProjects) Refresh(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refreshed = append(f.refreshed, id)
	r, ok := f.projects[id]
	if !ok {
		return fmt.Errorf("%w: %s", project.ErrNotFound, id)
	}
	if f.onRefresh != nil {
		f.onRefresh(&r)
		f.projects[id] = r
	}
	return nil
}

func (f *fakeProjects) Unregister(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.unregistered = append(f.unregistered, id)
	if f.unregErr != nil {
		return f.unregErr
	}
	if _, ok := f.projects[id]; !ok {
		return fmt.Errorf("%w: %s", project.ErrNotFound, id)
	}
	delete(f.projects, id)
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
		return nil, &project.GitError{Dir: dir, Args: args, ExitCode: 128, Stderr: "fatal: " + g.fail + " failed"}
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
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m chore: initial commit"}},
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
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m chore: initial commit"}},
		{name: "register fails: the folder stays", project: "unreg", regErr: errors.New("boom"), errText: "could not add it as a project: boom",
			wantDir: true, register: true,
			wantGit: []string{"config --get init.defaultBranch", "init --quiet -b trunk", "commit --quiet --allow-empty -m chore: initial commit"}},
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
			projects := newFakeProjects()
			projects.regErr = tt.regErr
			g := &fakeGit{fail: tt.gitFail}
			s, err := New(Options{Root: root, AllowedRoot: resolve(t, allowed), Projects: projects, Git: g})
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
			if got := len(projects.registered) > 0; got != tt.register {
				t.Errorf("registered = %t, want %t", got, tt.register)
			}
			if err == nil {
				if r.Path != dest || !r.Git {
					t.Errorf("project = %+v", r)
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
	s, err := New(Options{Root: root, AllowedRoot: resolve(t, home), Projects: newFakeProjects()})
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
	if strings.TrimSpace(string(out)) != "chore: initial commit" {
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
	local := project.Project{ID: "r1", Name: "demo", Path: "/home/me/projects/demo", Git: true}
	plain := project.Project{ID: "r2", Name: "notes", Path: "/home/me/notes"}
	withOrigin := project.Project{ID: "r3", Name: "cf", Path: "/home/me/cf", Git: true, Remotes: []string{"origin"}, GitHubSlug: "me/cf"}
	upstreamOnly := project.Project{ID: "r4", Name: "fork", Path: "/home/me/fork", Git: true, Remotes: []string{"upstream"}}
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
		{name: "public to the user", opts: PublishOptions{ProjectID: "r1", Owner: "me", Visibility: Public},
			wantArgs: []string{"gh", "repo", "create", "me/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--public"}, refreshed: true},
		{name: "internal to an org under another name", opts: PublishOptions{ProjectID: "r1", Owner: "octo-org", Name: "demo-app", Visibility: "INTERNAL"},
			wantArgs: []string{"gh", "repo", "create", "octo-org/demo-app", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--internal"}, refreshed: true},
		{name: "a remote other than origin is fine", opts: PublishOptions{ProjectID: "r4", Owner: "me", Visibility: Private},
			wantArgs: []string{"gh", "repo", "create", "me/fork", "--source", "/home/me/fork", "--remote", "origin", "--push", "--private"}, refreshed: true},
		{name: "gh refuses: its words verbatim, refreshed anyway", opts: PublishOptions{ProjectID: "r1", Owner: "octo-org", Visibility: Private},
			ghErr: &clone.ExitError{ExitCode: 1, Tail: []string{ghTail}}, err: ErrFailed, errExact: ghTail,
			wantArgs: []string{"gh", "repo", "create", "octo-org/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--private"}, refreshed: true},
		{name: "gh missing", opts: PublishOptions{ProjectID: "r1", Owner: "me", Visibility: Public},
			ghErr: &clone.ExitError{ExitCode: -1, Err: exec.ErrNotFound}, err: ErrFailed,
			wantArgs: []string{"gh", "repo", "create", "me/demo", "--source", "/home/me/projects/demo", "--remote", "origin", "--push", "--public"}, refreshed: true},
		{name: "bad visibility", opts: PublishOptions{ProjectID: "r1", Owner: "me", Visibility: "secret"}, err: ErrInvalidArgument},
		{name: "no owner", opts: PublishOptions{ProjectID: "r1", Visibility: Public}, err: ErrInvalidArgument},
		{name: "bad name", opts: PublishOptions{ProjectID: "r1", Owner: "me", Name: "a b", Visibility: Public}, err: ErrInvalidArgument},
		{name: "unknown project", opts: PublishOptions{ProjectID: "nope", Owner: "me", Visibility: Public}, err: ErrNotFound},
		{name: "not git", opts: PublishOptions{ProjectID: "r2", Owner: "me", Visibility: Public}, err: ErrFailedPrecondition},
		{name: "already has origin", opts: PublishOptions{ProjectID: "r3", Owner: "me", Visibility: Public}, err: ErrFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projects := newFakeProjects(local, plain, withOrigin, upstreamOnly)
			projects.onRefresh = func(r *project.Project) {
				if tt.ghErr == nil {
					r.Remotes = append(r.Remotes, "origin")
					slices.Sort(r.Remotes)
					r.GitHubSlug = strings.ToLower(tt.opts.Owner + "/" + r.Name)
				}
			}
			f := &fakeGh{err: tt.ghErr}
			s, err := New(Options{Root: "/home/me/.code-foundry/projects", Projects: projects, Runner: f, Gh: "gh"})
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
				t.Errorf("returned project has no origin: %+v", r)
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
			if (len(projects.refreshed) > 0) != tt.refreshed {
				t.Errorf("refreshed = %v, want %t", projects.refreshed, tt.refreshed)
			}
		})
	}
}

func TestPublishBusyAndTimeout(t *testing.T) {
	local := project.Project{ID: "r1", Name: "demo", Path: "/home/me/demo", Git: true}
	projects := newFakeProjects(local)
	f := &fakeGh{block: true, ran: make(chan struct{}, 1)}
	s, err := New(Options{Root: "/home/me/p", Projects: projects, Runner: f, PublishTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.Publish(context.Background(), PublishOptions{ProjectID: "r1", Owner: "me", Visibility: Public})
		done <- err
	}()
	<-f.ran
	if _, err := s.Publish(context.Background(), PublishOptions{ProjectID: "r1", Owner: "me", Visibility: Public}); !errors.Is(err, ErrFailedPrecondition) {
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
	if _, err := s.Publish(ctx, PublishOptions{ProjectID: "r1", Owner: "me", Visibility: Public}); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want Canceled", err)
	}
}

func TestDelete(t *testing.T) {
	root := filepath.Join(t.TempDir(), "projects")
	mk := func(t *testing.T, rel string) string {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Join(p, ".git"), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	tests := []struct {
		name         string
		id           string
		projects     func(t *testing.T) *fakeProjects
		unregErr     error
		err          error
		errText      string
		wantDir      bool // the folder still exists afterwards
		unregistered []string
	}{
		{name: "deletes a created project", id: "p", unregistered: []string{"p"},
			projects: func(t *testing.T) *fakeProjects {
				return newFakeProjects(project.Project{ID: "p", Name: "demo", Path: mk(t, "demo"), Git: true})
			}},
		{name: "unknown project", id: "nope", err: ErrNotFound, projects: func(*testing.T) *fakeProjects { return newFakeProjects() }},
		{name: "outside the projects directory", id: "o", err: ErrFailedPrecondition, wantDir: true,
			projects: func(t *testing.T) *fakeProjects {
				p := filepath.Join(t.TempDir(), "elsewhere")
				if err := os.MkdirAll(p, 0o755); err != nil {
					t.Fatal(err)
				}
				return newFakeProjects(project.Project{ID: "o", Name: "elsewhere", Path: p})
			}},
		{name: "nested under the projects directory", id: "n", err: ErrFailedPrecondition, wantDir: true,
			projects: func(t *testing.T) *fakeProjects {
				return newFakeProjects(project.Project{ID: "n", Name: "deep", Path: mk(t, "a/deep")})
			}},
		{name: "the projects directory itself", id: "r", err: ErrFailedPrecondition, wantDir: true,
			projects: func(t *testing.T) *fakeProjects {
				mk(t, "x")
				return newFakeProjects(project.Project{ID: "r", Name: "projects", Path: root})
			}},
		{name: "unregister fails: the folder stays", id: "u", unregErr: errors.New("boom"), errText: "unregister demo: boom", wantDir: true,
			unregistered: []string{"u"},
			projects: func(t *testing.T) *fakeProjects {
				return newFakeProjects(project.Project{ID: "u", Name: "demo", Path: mk(t, "demo"), Git: true})
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.RemoveAll(root); err != nil {
				t.Fatal(err)
			}
			projects := tt.projects(t)
			projects.unregErr = tt.unregErr
			s, err := New(Options{Root: root, Projects: projects})
			if err != nil {
				t.Fatal(err)
			}
			var path string
			if r, ok := projects.Snapshot().Project(tt.id); ok {
				path = r.Path
			}
			err = s.Delete(context.Background(), tt.id)
			switch {
			case tt.err != nil && !errors.Is(err, tt.err):
				t.Fatalf("err = %v, want %v", err, tt.err)
			case tt.errText != "" && (err == nil || !strings.Contains(err.Error(), tt.errText)):
				t.Fatalf("err = %v, want %q", err, tt.errText)
			case tt.err == nil && tt.errText == "" && err != nil:
				t.Fatalf("err = %v", err)
			}
			if path != "" {
				_, statErr := os.Lstat(path)
				if exists := statErr == nil; exists != tt.wantDir {
					t.Errorf("folder exists = %t, want %t", exists, tt.wantDir)
				}
			}
			if fmt.Sprint(projects.unregistered) != fmt.Sprint(tt.unregistered) {
				t.Errorf("unregistered = %v, want %v", projects.unregistered, tt.unregistered)
			}
		})
	}
}

func TestDeleteWhilePublishing(t *testing.T) {
	root := filepath.Join(t.TempDir(), "projects")
	p := filepath.Join(root, "demo")
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	projects := newFakeProjects(project.Project{ID: "p", Name: "demo", Path: p, Git: true})
	s, err := New(Options{Root: root, Projects: projects})
	if err != nil {
		t.Fatal(err)
	}
	if !s.claim("p") {
		t.Fatal("claim")
	}
	if err := s.Delete(context.Background(), "p"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("err = %v, want ErrFailedPrecondition", err)
	}
	if _, err := os.Lstat(p); err != nil {
		t.Error("folder removed while publishing")
	}
}
