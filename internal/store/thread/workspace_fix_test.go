package thread

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Fuzz round fixes (docs/notes/workspaces-v2-fix-1-workspace.md).

// What a workspace adds to a spawn: inside the root only the managed dir (Claude loads
// the root's file as the cwd's parent's); a member outside it gets the root's own file;
// a blank file or a folder named CLAUDE.md add no block (AGENTS.md is read then).
func TestWorkspaceSpawnFixes(t *testing.T) {
	e := newWSEnv(t)
	root := filepath.Dir(e.wt) // holds r1's checkout, not r2's
	writeFile(t, filepath.Join(root, "CLAUDE.md"), "Parent rules.")
	writeFile(t, filepath.Join(e.ws.Dir, "w-in", "CLAUDE.md"), "Stray rules.") // a real file where a link goes
	e.ws.Put(workspace.Workspace{ID: "w-in", Name: "inroot", RootPath: root, Members: []string{"r1", "r2"}, DefaultPrimary: "r1"})

	inside := e.createIn(CreateOptions{WorkspaceID: "inroot", ProjectID: "r1"})
	spec := e.spec(inside.ID)
	managed := filepath.Join(e.ws.Dir, "w-in")
	if sp := argOf(spec.Argv, "--append-system-prompt"); strings.Contains(sp, "inroot instructions") {
		t.Errorf("block appended inside the root: %q", sp)
	}
	if !slices.Contains(addDirs(spec.Argv), managed) {
		t.Errorf("add-dirs %q: want the managed dir (skills) inside the root too", addDirs(spec.Argv))
	}
	outside := e.createIn(CreateOptions{WorkspaceID: "inroot", ProjectID: "r2"})
	if sp := argOf(e.spec(outside.ID).Argv, "--append-system-prompt"); !strings.Contains(sp, "Workspace inroot instructions\n\nParent rules.") {
		t.Errorf("a member outside the root: %q, want the root's own file", sp)
	}
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: outside.ID})
	if err != nil || !samePath(tc.WorkspaceDir, root) || tc.WorkspaceDirMissing ||
		!slices.Equal(tc.WorkspaceStrays, []string{filepath.Join(managed, "CLAUDE.md")}) {
		t.Errorf("checkouts = %+v, %v: want the root and the stray", tc, err)
	}

	for _, tt := range []struct {
		name  string
		setup func(dir string)
		want  string // "" for no block
	}{
		{"blank CLAUDE.md", func(dir string) { writeFile(t, filepath.Join(dir, "CLAUDE.md"), "  \n\n\t") }, ""},
		{"a folder named CLAUDE.md", func(dir string) {
			if err := os.Mkdir(filepath.Join(dir, "CLAUDE.md"), 0o755); err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(dir, "AGENTS.md"), "Agents file.")
		}, "Agents file."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.RemoveAll(e.managed()); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(e.managed(), 0o700); err != nil {
				t.Fatal(err)
			}
			tt.setup(e.managed())
			s := e.createIn(CreateOptions{WorkspaceID: "login"})
			sp := argOf(e.spec(s.ID).Argv, "--append-system-prompt")
			if got := strings.Contains(sp, "Workspace login instructions"); got != (tt.want != "") || !strings.Contains(sp, tt.want) {
				t.Errorf("prompt %q, want block %q", sp, tt.want)
			}
		})
	}
}

// A rooted workspace whose root moved: a member thread still starts (without the
// workspace's files), one in the root is refused naming set-root, thread checkouts says
// the root is missing.
func TestWorkspaceRootMissing(t *testing.T) {
	e := newWSEnv(t)
	gone := filepath.Join(t.TempDir(), "moved-away")
	e.ws.Put(workspace.Workspace{ID: "w-gone", Name: "gone", RootPath: gone, Members: []string{"r1", "r2"}, DefaultPrimary: workspace.PrimaryWorkspace})
	s := e.createIn(CreateOptions{WorkspaceID: "gone", ProjectID: "r1"})
	spec := e.spec(s.ID)
	if slices.Contains(addDirs(spec.Argv), filepath.Join(e.ws.Dir, "w-gone")) {
		t.Errorf("add-dirs %q: the managed dir of a missing root", addDirs(spec.Argv))
	}
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: s.ID})
	if err != nil || tc.WorkspaceDir != gone || !tc.WorkspaceDirMissing {
		t.Errorf("checkouts = %+v, %v", tc, err)
	}
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorkspaceID: "gone"}); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "set-root") {
		t.Errorf("a thread in the missing root = %v", err)
	}
}

// A project whose name is "workspace" wins over the keyword; a project outside the
// workspace gets a hint; an unknown project says it is not registered.
func TestWorkspaceKeywordAndRefs(t *testing.T) {
	e := newWSEnv(t)
	for _, p := range []project.Project{{ID: "r3", Name: "workspace", Git: true}, {ID: "r4", Name: "plain", Git: true}} {
		p.Path = filepath.Join(t.TempDir(), p.Name)
		if err := os.MkdirAll(p.Path, 0o755); err != nil {
			t.Fatal(err)
		}
		p.Worktrees = []project.Worktree{{ProjectID: p.ID, Path: p.Path, IsMain: true}}
		e.projects.Put(p)
	}
	if s := e.createIn(CreateOptions{ProjectID: "workspace"}); s.ProjectID != "r3" {
		t.Errorf("--project workspace without a workspace: primary %q, want the project r3", s.ProjectID)
	}
	s := e.createIn(CreateOptions{WorkspaceID: "login", ProjectIDs: []string{"r1", "r3"}, ProjectID: "workspace"})
	if s.ProjectID != "r3" {
		t.Errorf("--project workspace with a workspace: primary %q, want the project r3", s.ProjectID)
	}
	hints := e.m.CheckoutHints(s)
	if !slices.ContainsFunc(hints, func(h string) bool { return strings.HasPrefix(h, "workspace not in workspace login") }) {
		t.Errorf("hints %q: want one for the project outside the workspace", hints)
	}
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectID: "nope"})
	if !errors.Is(err, ErrNotFound) || err.Error() != "project nope is not registered" {
		t.Errorf("unknown project = %v", err)
	}
}

// A spawn's cwd: a workspace's managed dir is made again; anything else missing fails
// naming the folder, not as a missing claude.
func TestEnsureCwd(t *testing.T) {
	e := newWSEnv(t)
	if err := os.RemoveAll(e.managed()); err != nil {
		t.Fatal(err)
	}
	if err := e.m.ensureCwd(e.ctx(), Thread{ID: "s-1", WorktreePath: e.managed(), WorkspaceID: "w-login"}); err != nil || !isDir(e.managed()) {
		t.Errorf("managed dir cwd: %v, made %v", err, isDir(e.managed()))
	}
	gone := filepath.Join(t.TempDir(), "gone")
	err := e.m.ensureCwd(e.ctx(), Thread{ID: "s-2", WorktreePath: gone, WorkspaceID: "w-login"})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "working directory "+gone+" is missing") {
		t.Errorf("missing cwd = %v", err)
	}
}
