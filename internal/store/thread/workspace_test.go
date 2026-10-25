package thread

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

// wsEnv is an env with a second repository (r2, "api", its main checkout wt2) and a
// workspace fake holding "login" (w-login) over r1 and r2, default primary r1, with its
// managed dir on disk.
type wsEnv struct {
	*env
	ws  *workspacetest.Fake
	wt2 string
}

func newWSEnv(t *testing.T, mutate ...func(*Options)) *wsEnv {
	t.Helper()
	return newWSFixtureEnv(t, "text-table", mutate...)
}

// newWSFixtureEnv is newWSEnv whose fake replays the capture fixture.
func newWSFixtureEnv(t *testing.T, fixture string, mutate ...func(*Options)) *wsEnv {
	t.Helper()
	ws := workspacetest.New(nil)
	ws.Dir, ws.MakeDirs = t.TempDir(), true
	we := &wsEnv{ws: ws}
	we.env = newFixtureEnv(t, fixture, append([]func(*Options){func(o *Options) { o.Workspaces = ws }}, mutate...)...)
	we.wt2 = filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(we.wt2, 0o755); err != nil {
		t.Fatal(err)
	}
	we.projects.Put(project.Project{ID: "r2", Path: we.wt2, Name: "api", Git: true, Worktrees: []project.Worktree{{ProjectID: "r2", Path: we.wt2, IsMain: true}}})
	ws.Put(workspace.Workspace{ID: "w-login", Name: "login", Members: []string{"r1", "r2"}, DefaultPrimary: "r1"})
	if err := ws.EnsureDirs(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	return we
}

// managed is the login workspace's managed dir.
func (e *wsEnv) managed() string {
	w, _ := e.ws.Snapshot().Workspace("w-login")
	return w.ManagedDir
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A thread in a workspace: its members are the set, the default primary is the cwd, the
// managed dir and the other member are --add-dirs, the workspace's CLAUDE.md (else its
// AGENTS.md) follows ThreadPrompt under one heading, the v1 env flag and prompt line are
// gone; in the workspace's folder nothing is added.
func TestWorkspaceThreadSpawn(t *testing.T) {
	e := newWSEnv(t)
	writeFile(t, filepath.Join(e.managed(), "AGENTS.md"), "Agents: run make check.")

	s := e.createIn(CreateOptions{WorkspaceID: "login"})
	if s.WorkspaceID != "w-login" || s.ProjectID != "r1" || !slices.Equal(s.ProjectIDs, []string{"r1", "r2"}) || s.CreatedWorktree {
		t.Fatalf("created %+v", s)
	}
	spec := e.spec(s.ID)
	dirs := addDirs(spec.Argv)
	if i, j := slices.Index(dirs, e.managed()), slices.Index(dirs, e.wt2); i < 0 || j < 0 || i > j {
		t.Errorf("add-dirs %q: want the managed dir, then the api checkout", dirs)
	}
	sp := argOf(spec.Argv, "--append-system-prompt")
	if !strings.HasPrefix(sp, ThreadPrompt+"\n\nWorkspace login instructions\n\nAgents: run make check.") {
		t.Errorf("system prompt %q", sp)
	}
	if slices.ContainsFunc(spec.Env, func(kv string) bool { return strings.HasPrefix(kv, "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD") }) ||
		strings.Contains(sp, "belongs to workspace") {
		t.Errorf("v1 additions left: env %q prompt %q", spec.Env, sp)
	}

	// CLAUDE.md wins over AGENTS.md, read at the next spawn; a long one is cut.
	writeFile(t, filepath.Join(e.managed(), "CLAUDE.md"), strings.Repeat("x", MaxWorkspaceInstructions+100))
	next := e.createIn(CreateOptions{WorkspaceID: "login"})
	sp = argOf(e.spec(next.ID).Argv, "--append-system-prompt")
	if !strings.Contains(sp, "Workspace login instructions\n\nxxx") || strings.Contains(sp, "Agents:") ||
		strings.Count(sp, "x") > MaxWorkspaceInstructions+50 {
		t.Errorf("next prompt: %d bytes, want CLAUDE.md first and cut", len(sp))
	}

	// "workspace" as the project runs it in the managed dir: no add-dir for it, no block.
	in := e.createIn(CreateOptions{WorkspaceID: "login", ProjectID: workspace.PrimaryWorkspace})
	if in.ProjectID != "" || !samePath(in.WorktreePath, e.managed()) || len(in.ProjectIDs) != 2 {
		t.Fatalf("in the workspace %+v", in)
	}
	spec = e.spec(in.ID)
	if dirs := addDirs(spec.Argv); slices.Contains(dirs, e.managed()) || !slices.Contains(dirs, e.wt) || !slices.Contains(dirs, e.wt2) {
		t.Errorf("add-dirs %q: both members, not the cwd", dirs)
	}
	if sp := argOf(spec.Argv, "--append-system-prompt"); strings.Contains(sp, "Workspace login instructions") {
		t.Errorf("instructions appended in the workspace's own folder: %q", sp)
	}
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{Cwd: filepath.Join(e.managed(), "sub")})
	if err != nil || tc.Thread.ID != in.ID || tc.WorkspaceDir != e.managed() {
		t.Errorf("checkouts from the managed dir = %+v, %v", tc, err)
	}

	// --projects narrows a workspace's set; the default primary outside it gives way.
	narrow := e.createIn(CreateOptions{WorkspaceID: "login", ProjectIDs: []string{"r2"}})
	if narrow.ProjectID != "r2" || !slices.Equal(narrow.ProjectIDs, []string{"r2"}) || narrow.WorkspaceID != "w-login" {
		t.Errorf("narrowed %+v", narrow)
	}
}

// A rooted workspace defaults to its root as the cwd, where Claude loads the files
// itself; a thread elsewhere reads the root's CLAUDE.md through the managed dir's link.
func TestRootedWorkspaceThread(t *testing.T) {
	e := newWSEnv(t)
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "CLAUDE.md"), "Root rules.")
	managed := filepath.Join(e.ws.Dir, "w-root")
	writeFile(t, filepath.Join(managed, "CLAUDE.md"), "Root rules.") // the fake makes no links
	e.ws.Put(workspace.Workspace{ID: "w-root", Name: "shop", RootPath: root, Members: []string{"r1", "r2"}, DefaultPrimary: workspace.PrimaryWorkspace})

	s := e.createIn(CreateOptions{WorkspaceID: "shop"})
	if s.ProjectID != "" || !samePath(s.WorktreePath, root) {
		t.Fatalf("created %+v", s)
	}
	spec := e.spec(s.ID)
	if sp := argOf(spec.Argv, "--append-system-prompt"); strings.Contains(sp, "Root rules.") {
		t.Errorf("instructions appended at the root: %q", sp)
	}
	if slices.Contains(addDirs(spec.Argv), managed) {
		t.Errorf("managed dir passed at the root: %q", addDirs(spec.Argv))
	}
	elsewhere := e.createIn(CreateOptions{WorkspaceID: "shop", ProjectID: "api"})
	if sp := argOf(e.spec(elsewhere.ID).Argv, "--append-system-prompt"); !strings.Contains(sp, "Workspace shop instructions\n\nRoot rules.") {
		t.Errorf("instructions not appended in a member: %q", sp)
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

// createIn is Create without env.create's default worktree.
func (e *wsEnv) createIn(o CreateOptions) Thread {
	e.t.Helper()
	s, err := e.m.Create(e.ctx(), o)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// withSource is the option that gives a (re)opened store the workspace fake.
func (e *wsEnv) withSource(o *Options) { o.Workspaces = e.ws }

// writeTranscriptIn is writeTranscript for a worktree other than e.wt.
func (e *env) writeTranscriptIn(wt, cid string, lines ...string) {
	e.t.Helper()
	saved := e.wt
	e.wt = wt
	defer func() { e.wt = saved }()
	e.writeTranscript(cid, lines...)
}

// hasAll reports whether got holds every entry of want.
func hasAll(got, want []string) bool {
	return !slices.ContainsFunc(want, func(s string) bool { return !slices.Contains(got, s) })
}

func TestCutUTF8(t *testing.T) {
	for _, tt := range []struct {
		s    string
		n    int
		want string
	}{{"abc", 5, "abc"}, {"abc", 2, "ab"}, {"aé", 2, "a"}, {"éé", 3, "é"}} {
		if got := cutUTF8(tt.s, tt.n); got != tt.want {
			t.Errorf("cutUTF8(%q, %d) = %q, want %q", tt.s, tt.n, got, tt.want)
		}
	}
}
