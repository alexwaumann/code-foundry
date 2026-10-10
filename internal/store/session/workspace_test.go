package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func TestPickMember(t *testing.T) {
	w := workspace.Workspace{Name: "login", Members: []workspace.Member{
		{RepoID: "web", WorktreePath: "/wt/web"}, {RepoID: "api", WorktreePath: "/wt/api"},
	}}
	tests := []struct {
		name         string
		w            workspace.Workspace
		repoID, path string
		want         string // worktree path
		wantErr      error
	}{
		{name: "default is the first member", w: w, want: "/wt/web"},
		{name: "by repo", w: w, repoID: "api", want: "/wt/api"},
		{name: "by path", w: w, path: "/wt/api", want: "/wt/api"},
		{name: "path is cleaned", w: w, path: "/wt/api/", want: "/wt/api"},
		{name: "repo and path agree", w: w, repoID: "api", path: "/wt/api", want: "/wt/api"},
		{name: "repo and path disagree", w: w, repoID: "web", path: "/wt/api", wantErr: ErrInvalidArgument},
		{name: "repo not a member", w: w, repoID: "lib", wantErr: ErrFailedPrecondition},
		{name: "path not a member", w: w, path: "/wt/lib", wantErr: ErrFailedPrecondition},
		{name: "a subdirectory is not the member", w: w, path: "/wt/api/src", wantErr: ErrFailedPrecondition},
		{name: "no members", w: workspace.Workspace{Name: "empty"}, wantErr: ErrFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := pickMember(tt.w, tt.repoID, tt.path)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err == nil && got.WorktreePath != tt.want {
				t.Errorf("member = %+v, want %s", got, tt.want)
			}
		})
	}
}

// wsEnv is an env with a second repository (r2) and a workspace fake holding "login"
// (w-login) over r1's and r2's worktrees, both real directories.
type wsEnv struct {
	*env
	ws         *workspacetest.Fake
	wt2        string
	withSource func(*Options)
}

func newWSEnv(t *testing.T, mutate ...func(*Options)) *wsEnv {
	t.Helper()
	ws := workspacetest.New(nil)
	ws.WorktreeRoot = t.TempDir()
	we := &wsEnv{ws: ws, withSource: func(o *Options) { o.Workspaces = ws }}
	we.env = newEnv(t, append([]func(*Options){we.withSource}, mutate...)...)
	we.wt2 = filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(we.wt2, 0o755); err != nil {
		t.Fatal(err)
	}
	we.repos.Put(repo.Repo{ID: "r2", Path: we.wt2, Name: "api", Worktrees: []repo.Worktree{{RepoID: "r2", Path: we.wt2, IsMain: true}}})
	ws.Put(workspace.Workspace{ID: "w-login", Name: "login", Branch: "cf/login", Members: []workspace.Member{
		{RepoID: "r1", WorktreePath: we.wt}, {RepoID: "r2", WorktreePath: we.wt2},
	}})
	return we
}

func TestCreateInWorkspace(t *testing.T) {
	e := newWSEnv(t)
	tests := []struct {
		name     string
		o        CreateOptions
		wantRepo string
		wantPath func() string
		wantErr  error
	}{
		{name: "first member by default", o: CreateOptions{WorkspaceID: "w-login"}, wantRepo: "r1", wantPath: func() string { return e.wt }},
		{name: "by name and repo", o: CreateOptions{WorkspaceID: "login", RepoID: "r2"}, wantRepo: "r2", wantPath: func() string { return e.wt2 }},
		{name: "by member path", o: CreateOptions{WorkspaceID: "login", WorktreePath: e.wt2}, wantRepo: "r2", wantPath: func() string { return e.wt2 }},
		{name: "path that is not a member", o: CreateOptions{WorkspaceID: "login", WorktreePath: t.TempDir()}, wantErr: ErrFailedPrecondition},
		{name: "relative path", o: CreateOptions{WorkspaceID: "login", WorktreePath: "api"}, wantErr: ErrInvalidArgument},
		{name: "unknown workspace", o: CreateOptions{WorkspaceID: "nope"}, wantErr: ErrNotFound},
		{name: "not with a new worktree", o: CreateOptions{WorkspaceID: "login", NewWorktree: &NewWorktree{}}, wantErr: ErrInvalidArgument},
		{name: "not with a new workspace", o: CreateOptions{WorkspaceID: "login", NewWorkspace: &NewWorkspace{Repos: []string{"r1"}}}, wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := e.m.Create(e.ctx(), tt.o)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if s.WorkspaceID != "w-login" || s.RepoID != tt.wantRepo || s.WorktreePath != tt.wantPath() {
				t.Errorf("session = %+v", s)
			}
			if spec, _ := e.terms.Spec(s.TerminalID); spec.Cwd != tt.wantPath() {
				t.Errorf("cwd = %s, want %s", spec.Cwd, tt.wantPath())
			}
		})
	}
}

func TestWorkspaceThreadNeedsTheWorkspaceStore(t *testing.T) {
	e := newEnv(t)
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorkspaceID: "login"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Create = %v, want failed precondition", err)
	}
	if _, err := e.m.Create(e.ctx(), CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1"}}}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Create new workspace = %v, want failed precondition", err)
	}
}

func TestWorkspaceOwnerSurvivesRestartAndFork(t *testing.T) {
	e := newWSEnv(t)
	s := e.connected(CreateOptions{WorkspaceID: "login", RepoID: "r2", Name: "driver"})
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscriptIn(e.wt2, cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })

	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.WorkspaceID != "w-login" || f.RepoID != "r2" || f.WorktreePath != e.wt2 {
		t.Errorf("fork = %+v", f)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open(e.withSource)
	for _, id := range []string{s.ID, f.ID} {
		got, err := e.m.Get(e.ctx(), id)
		if err != nil || got.WorkspaceID != "w-login" || got.RepoID != "r2" || got.WorktreePath != e.wt2 {
			t.Errorf("after restart %s = %+v (%v)", id, got, err)
		}
	}
}

// writeTranscriptIn is writeTranscript for a worktree other than e.wt.
func (e *env) writeTranscriptIn(wt, cid string, lines ...string) {
	e.t.Helper()
	saved := e.wt
	e.wt = wt
	defer func() { e.wt = saved }()
	e.writeTranscript(cid, lines...)
}

func TestCreateNewWorkspace(t *testing.T) {
	tests := []struct {
		name       string
		o          CreateOptions
		taken      []string // refs RefExists reports, in any repo
		existing   string   // a workspace with this name exists already
		wantCall   string   // the workspace store's Create call
		wantBranch string
		wantRepo   string
		wantName   string // session name
		wantErr    error
	}{
		{name: "slug names branch, workspace and thread; first repo is the cwd",
			o:        CreateOptions{InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "api"}}},
			wantCall: "Create named-fix r1,r2", wantBranch: "cf/named-fix", wantRepo: "r1", wantName: "named-fix"},
		{name: "repo picks the cwd member",
			o:        CreateOptions{RepoID: "r2", InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}, BaseRef: "origin/dev"}},
			wantCall: "Create named-fix r1,r2", wantBranch: "cf/named-fix", wantRepo: "r2", wantName: "named-fix"},
		{name: "a branch taken in any member gets a suffix",
			o:     CreateOptions{InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}}},
			taken: []string{"refs/remotes/origin/cf/named-fix"}, wantCall: "Create named-fix-2 r1,r2", wantBranch: "cf/named-fix-2",
			wantRepo: "r1", wantName: "named-fix"},
		{name: "a taken workspace name gets a suffix",
			o:        CreateOptions{InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}}},
			existing: "named-fix", wantCall: "Create named-fix-2 r1,r2", wantBranch: "cf/named-fix-2", wantRepo: "r1", wantName: "named-fix"},
		{name: "explicit thread name, explicit workspace name",
			o:        CreateOptions{Name: "Driver One", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}, Name: "Login work"}},
			wantCall: "Create Login work r1,r2", wantBranch: "cf/driver-one", wantRepo: "r1", wantName: "Driver One"},
		{name: "unknown repository", o: CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1", "nope"}}}, wantErr: ErrNotFound},
		{name: "repository twice", o: CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1", "repo"}}}, wantErr: ErrInvalidArgument},
		{name: "cwd repo not listed", o: CreateOptions{RepoID: "r2", NewWorkspace: &NewWorkspace{Repos: []string{"r1"}}}, wantErr: ErrInvalidArgument},
		{name: "no repositories", o: CreateOptions{NewWorkspace: &NewWorkspace{}}, wantErr: ErrInvalidArgument},
		{name: "bad base", o: CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1"}, BaseRef: "-x"}}, wantErr: ErrInvalidArgument},
		{name: "not with a new worktree", o: CreateOptions{NewWorktree: &NewWorktree{}, NewWorkspace: &NewWorkspace{Repos: []string{"r1"}}}, wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newWSEnv(t, func(o *Options) {
				o.RefExists = func(_ context.Context, _, ref string) bool { return slices.Contains(tt.taken, ref) }
			})
			e.namer = func(string) (string, error) { return "named-fix", nil }
			if tt.existing != "" {
				e.ws.Put(workspace.Workspace{ID: "w-old", Name: tt.existing, Branch: "cf/other"})
			}
			s, err := e.m.Create(e.ctx(), tt.o)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			calls := slices.DeleteFunc(e.ws.Calls(), func(c string) bool { return strings.HasPrefix(c, "Members") })
			if err != nil {
				if len(calls) != 0 {
					t.Errorf("workspace calls after a failure = %q", calls)
				}
				return
			}
			if len(calls) != 1 || calls[0] != tt.wantCall {
				t.Fatalf("workspace calls = %q, want %q", calls, tt.wantCall)
			}
			w, ok := e.ws.Snapshot().Workspace(s.WorkspaceID)
			if !ok || w.Branch != tt.wantBranch {
				t.Fatalf("workspace %s = %+v, want branch %s", s.WorkspaceID, w, tt.wantBranch)
			}
			mem, _ := w.Member(tt.wantRepo)
			if s.RepoID != tt.wantRepo || s.WorktreePath != mem.WorktreePath || !s.CreatedWorktree || s.Name != tt.wantName {
				t.Errorf("session = %+v, want cwd %s in %s", s, mem.WorktreePath, tt.wantRepo)
			}
			if base := tt.o.NewWorkspace.BaseRef; base != "" && s.BaseRef != base {
				t.Errorf("base = %q, want %q", s.BaseRef, base)
			}
		})
	}
}
