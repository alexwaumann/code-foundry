package session

import (
	"cmp"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
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
		wantBase   string // session base ref; default: the request's
		wantErr    error
	}{
		{name: "slug names branch, workspace and thread; first repo is the cwd",
			o:        CreateOptions{InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "api"}}},
			wantCall: "Create named-fix r1,r2", wantBranch: "cf/named-fix", wantRepo: "r1", wantName: "named-fix"},
		{name: "repo picks the cwd member, by name too",
			o:        CreateOptions{RepoID: "api", InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"repo", "api"}}},
			wantCall: "Create named-fix r1,r2", wantBranch: "cf/named-fix", wantRepo: "r2", wantName: "named-fix"},
		{name: "repo picks the cwd member",
			o:        CreateOptions{RepoID: "r2", InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2"}, BaseRef: "origin/dev"}},
			wantCall: "Create named-fix r1,r2", wantBranch: "cf/named-fix", wantRepo: "r2", wantName: "named-fix"},
		{name: "a member's own base; the cwd member's base is the thread's",
			o:        CreateOptions{RepoID: "r2", InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "api: origin/feat"}, BaseRef: "origin/dev"}},
			wantCall: "Create named-fix r1,r2:origin/feat", wantBranch: "cf/named-fix", wantRepo: "r2", wantName: "named-fix", wantBase: "origin/feat"},
		{name: "a member's own base; another member is the cwd",
			o:        CreateOptions{InitialPrompt: "fix login", NewWorkspace: &NewWorkspace{Repos: []string{"r1", "r2:origin/feat"}}},
			wantCall: "Create named-fix r1,r2:origin/feat", wantBranch: "cf/named-fix", wantRepo: "r1", wantName: "named-fix"},
		{name: "a bad member base", o: CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1:-x"}}}, wantErr: ErrInvalidArgument},
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
			if base := cmp.Or(tt.wantBase, tt.o.NewWorkspace.BaseRef); base != "" && s.BaseRef != base {
				t.Errorf("base = %q, want %q", s.BaseRef, base)
			}
		})
	}
}

func TestWorkspaceLaunch(t *testing.T) {
	snap := &workspace.Snapshot{Workspaces: []workspace.Workspace{{ID: "w-1", Name: "login", Members: []workspace.Member{
		{RepoID: "web", WorktreePath: "/wt/web"}, {RepoID: "api", WorktreePath: "/wt/api"}, {RepoID: "lib", WorktreePath: "/wt/lib"},
	}}}}
	line := "This thread belongs to workspace login. Run `code-foundry workspace members` for the current worktrees."
	exists := func(p string) bool { return p != "/wt/lib" }
	tests := []struct {
		name        string
		snap        *workspace.Snapshot
		id, cwd     string
		wantOK      bool
		wantDirs    []string
		wantMissing []string
	}{
		{name: "every other member, in order", snap: snap, id: "w-1", cwd: "/wt/api", wantOK: true,
			wantDirs: []string{"/wt/web"}, wantMissing: []string{"/wt/lib"}},
		{name: "cwd compared cleaned", snap: snap, id: "w-1", cwd: "/wt/web/", wantOK: true,
			wantDirs: []string{"/wt/api"}, wantMissing: []string{"/wt/lib"}},
		{name: "cwd no longer a member: every member", snap: snap, id: "w-1", cwd: "/elsewhere", wantOK: true,
			wantDirs: []string{"/wt/web", "/wt/api"}, wantMissing: []string{"/wt/lib"}},
		{name: "workspace gone", snap: snap, id: "w-2", cwd: "/wt/web"},
		{name: "no snapshot", id: "w-1", cwd: "/wt/web"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := workspaceLaunch(tt.snap, tt.id, tt.cwd, exists)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if !slices.Equal(got.addDirs, tt.wantDirs) || !slices.Equal(got.missing, tt.wantMissing) {
				t.Errorf("dirs = %q missing = %q, want %q and %q", got.addDirs, got.missing, tt.wantDirs, tt.wantMissing)
			}
			if !slices.Equal(got.env, []string{"CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1"}) || got.prompt != line {
				t.Errorf("env = %q prompt = %q", got.env, got.prompt)
			}
		})
	}
}

// addDirs returns every --add-dir value in argv.
func addDirs(argv []string) []string {
	var out []string
	for i, a := range argv {
		if a == "--add-dir" && i+1 < len(argv) {
			out = append(out, argv[i+1])
		}
	}
	return out
}

// A workspace thread's every spawn reads the current members: create, reconnect and
// fork. The attachments dir stays first; the daemon env is kept.
func TestWorkspaceThreadSpawn(t *testing.T) {
	att := filepath.Join(t.TempDir(), "attachments")
	base := []string{"CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:1", "CODE_FOUNDRY_TOKEN=t"}
	e := newWSEnv(t, func(o *Options) { o.AttachmentsDir, o.Env = att, base })
	line := "This thread belongs to workspace login. Run `code-foundry workspace members` for the current worktrees."
	wantEnv := append(slices.Clone(base), "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1")
	check := func(what string, s Session, wantDirs ...string) {
		t.Helper()
		spec, ok := e.terms.Spec(s.TerminalID)
		if !ok {
			t.Fatalf("%s: no terminal", what)
		}
		if got := addDirs(spec.Argv); !slices.Equal(got, append([]string{att}, wantDirs...)) {
			t.Errorf("%s: --add-dir = %q, want %q", what, got, append([]string{att}, wantDirs...))
		}
		if got := argOf(spec.Argv, "--append-system-prompt"); got != line {
			t.Errorf("%s: --append-system-prompt = %q", what, got)
		}
		if !slices.Equal(spec.Env, wantEnv) {
			t.Errorf("%s: env = %q, want %q", what, spec.Env, wantEnv)
		}
	}
	s := e.connected(CreateOptions{WorkspaceID: "login", InitialPrompt: "hi"})
	check("create", s, e.wt2)
	if spec, _ := e.terms.Spec(s.TerminalID); spec.Argv[len(spec.Argv)-2] != "--" {
		t.Errorf("the prompt is not last: %q", spec.Argv)
	}
	cid := argOf(mustSpec(t, e.env, s).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })

	// A repo added since: reconnect and fork see it. A member whose worktree is gone is
	// skipped (claude refuses a missing --add-dir).
	lib := filepath.Join(t.TempDir(), "lib")
	if err := os.MkdirAll(lib, 0o755); err != nil {
		t.Fatal(err)
	}
	w, _ := e.ws.Snapshot().Workspace("w-login")
	w.Members = append(slices.Clone(w.Members), workspace.Member{RepoID: "r3", WorktreePath: lib},
		workspace.Member{RepoID: "r4", WorktreePath: filepath.Join(lib, "gone")})
	e.ws.Put(w)
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	check("reconnect", r, e.wt2, lib)
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	check("fork", f, e.wt2, lib)

	// A project thread gets none of it.
	p := e.connected(CreateOptions{})
	spec, _ := e.terms.Spec(p.TerminalID)
	if got := addDirs(spec.Argv); !slices.Equal(got, []string{att}) || argOf(spec.Argv, "--append-system-prompt") != "" ||
		!slices.Equal(spec.Env, base) {
		t.Errorf("project thread argv = %q env = %q", spec.Argv, spec.Env)
	}
}

func mustSpec(t *testing.T, e *env, s Session) terminal.Spec {
	t.Helper()
	spec, ok := e.terms.Spec(s.TerminalID)
	if !ok {
		t.Fatalf("no terminal for %s", s.ID)
	}
	return spec
}
