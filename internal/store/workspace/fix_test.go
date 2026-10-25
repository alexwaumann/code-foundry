package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Fuzz round fixes (docs/notes/workspaces-v2-fix-1-workspace.md).

// Names never look like ids, and NFC and NFD spellings are one name.
func TestWorkspaceNameRules(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	victim, err := e.m.Create(ctx, CreateOptions{Name: "victim", Members: []string{"api"}})
	if err != nil {
		t.Fatal(err)
	}
	nfc, nfd := "café", "café"
	if _, err := e.m.Create(ctx, CreateOptions{Name: nfc, Members: []string{"web"}}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		do   func() error
		want error
	}{
		{"an id-shaped name", func() error {
			_, err := e.m.Create(ctx, CreateOptions{Name: "w-0123456789ab", Members: []string{"web"}})
			return err
		}, ErrInvalidArgument},
		{"another workspace's id", func() error {
			_, err := e.m.Create(ctx, CreateOptions{Name: strings.ToUpper(victim.ID), Members: []string{"web"}})
			return err
		}, ErrInvalidArgument},
		{"rename to an id", func() error { _, err := e.m.Rename(ctx, "victim", victim.ID); return err }, ErrInvalidArgument},
		{"the NFD spelling of a taken name", func() error {
			_, err := e.m.Create(ctx, CreateOptions{Name: nfd, Members: []string{"web"}})
			return err
		}, ErrFailedPrecondition},
	} {
		if err := tt.do(); !errors.Is(err, tt.want) {
			t.Errorf("%s: err = %v, want %v", tt.name, err, tt.want)
		}
	}
	if w, err := ResolveWorkspace(e.m.Snapshot(), nfd); err != nil || w.Name != nfc {
		t.Errorf("resolve the NFD spelling = %+v, %v", w, err)
	}
	if w, err := ResolveWorkspace(e.m.Snapshot(), victim.ID); err != nil || w.ID != victim.ID {
		t.Errorf("resolve by id = %+v, %v", w, err)
	}
}

// A root is never home itself, nor a registered project's checkout or worktree or a
// folder inside one; a folder holding projects is fine.
func TestWorkspaceRootRules(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	repo := filepath.Join(e.home, "repo")
	wt := filepath.Join(e.home, "wt", "repo-feature")
	for _, d := range []string{filepath.Join(repo, "sub"), wt, filepath.Join(e.home, "product", "child")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.pf.Put(project.Project{ID: "r-repo", Name: "repo", Path: realPath(repo), Git: true,
		Worktrees: []project.Worktree{{Path: realPath(repo)}, {Path: realPath(wt)}}})
	e.pf.Put(project.Project{ID: "r-child", Name: "child", Path: realPath(filepath.Join(e.home, "product", "child")), Git: true})
	for _, tt := range []struct {
		name, root string
		want       error
		msg        string
	}{
		{"home", e.home, ErrInvalidArgument, "home directory"},
		{"a project's checkout", repo, ErrInvalidArgument, "inside project repo"},
		{"inside a checkout", filepath.Join(repo, "sub"), ErrInvalidArgument, "inside project repo"},
		{"a worktree", wt, ErrInvalidArgument, "inside project repo"},
		{"a folder of projects", filepath.Join(e.home, "product"), nil, ""},
	} {
		_, err := e.m.Create(ctx, CreateOptions{Name: "ws " + tt.name, RootPath: tt.root})
		if !errors.Is(err, tt.want) || (tt.msg != "" && !strings.Contains(err.Error(), tt.msg)) {
			t.Errorf("%s: err = %v, want %v with %q", tt.name, err, tt.want, tt.msg)
		}
	}
}

// A moved root: RootMissing at the next EnsureDirs, links dropped; SetRoot points it at
// the new folder and links again; a synthetic workspace has no root to set.
func TestSetRoot(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	root := filepath.Join(e.home, "root1")
	write(t, filepath.Join(root, "CLAUDE.md"), "rules")
	w, err := e.m.Create(ctx, CreateOptions{Name: "rooted", RootPath: root, Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(e.home, "root1-moved")
	if err := os.Rename(root, moved); err != nil {
		t.Fatal(err)
	}
	if err := e.m.EnsureDirs(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.m.Snapshot().Workspace(w.ID); !got.RootMissing || got.Instructions != "" {
		t.Fatalf("after the move: %+v, want RootMissing", got)
	}
	if _, err := e.m.SetRoot(ctx, "rooted", filepath.Join(e.home, "nope")); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("SetRoot to a missing folder = %v", err)
	}
	got, err := e.m.SetRoot(ctx, "rooted", moved)
	if err != nil {
		t.Fatal(err)
	}
	if got.RootPath != realPath(moved) || got.RootMissing || got.Instructions != filepath.Join(realPath(moved), "CLAUDE.md") {
		t.Fatalf("after SetRoot: %+v", got)
	}
	if linkTarget(filepath.Join(w.ManagedDir, "CLAUDE.md")) != filepath.Join(realPath(moved), "CLAUDE.md") {
		t.Error("link not made for the new root")
	}
	e.open()
	if got, _ := e.m.Snapshot().Workspace(w.ID); got.RootPath != realPath(moved) {
		t.Errorf("after reopen: root %q", got.RootPath)
	}
	syn, err := e.m.Create(ctx, CreateOptions{Name: "syn", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.SetRoot(ctx, syn.ID, moved); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("SetRoot of a synthetic workspace = %v", err)
	}
}

// Where the default primary goes when its project leaves: the first member left of a
// synthetic workspace, else "workspace"; ProjectRemoved does it for every workspace.
func TestDefaultPrimaryFallback(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	root := filepath.Join(e.home, "mono")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	syn, err := e.m.Create(ctx, CreateOptions{Name: "syn", Members: []string{"web", "api", "docs"}})
	if err != nil {
		t.Fatal(err)
	}
	rooted, err := e.m.Create(ctx, CreateOptions{Name: "rooted", RootPath: root, Members: []string{"web", "api"}, DefaultPrimary: "web"})
	if err != nil {
		t.Fatal(err)
	}
	lone, err := e.m.Create(ctx, CreateOptions{Name: "lone", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.ProjectRemoved(ctx, "r-web"); err != nil {
		t.Fatal(err)
	}
	snap := e.m.Snapshot()
	for _, tt := range []struct {
		id, wantPrimary string
		wantMembers     []string
	}{
		{syn.ID, "r-api", []string{"r-api", "r-docs"}},
		{rooted.ID, PrimaryWorkspace, []string{"r-api"}},
		{lone.ID, PrimaryWorkspace, nil},
	} {
		w, _ := snap.Workspace(tt.id)
		if w.DefaultPrimary != tt.wantPrimary || !slices.Equal(w.Members, tt.wantMembers) {
			t.Errorf("%s: primary %q members %v, want %q %v", w.Name, w.DefaultPrimary, w.Members, tt.wantPrimary, tt.wantMembers)
		}
	}
	e.open()
	if w, _ := e.m.Snapshot().Workspace(syn.ID); w.Member("r-web") {
		t.Error("the dropped member came back after a reopen")
	}
}

// Remove of a synthetic workspace asks InUse first and keeps everything when it refuses;
// a rooted one is not asked (its root stays).
func TestRemoveInUse(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	var asked []string
	e.m.opts.InUse = func(w Workspace) error {
		asked = append(asked, w.Name)
		return errors.New("thread t (s-1) runs in its folder")
	}
	w, err := e.m.Create(ctx, CreateOptions{Name: "shop", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.m.Remove(ctx, "shop"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "runs in its folder") {
		t.Fatalf("Remove = %v", err)
	}
	if _, ok := e.m.Snapshot().Workspace(w.ID); !ok || !isDirT(w.ManagedDir) {
		t.Fatal("a refused remove removed something")
	}
	root := filepath.Join(e.home, "mono")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Create(ctx, CreateOptions{Name: "mono", RootPath: root}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Remove(ctx, "mono"); err != nil {
		t.Fatalf("Remove rooted = %v", err)
	}
	if !slices.Equal(asked, []string{"shop"}) {
		t.Errorf("InUse asked for %v, want [shop]", asked)
	}
}

func isDirT(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// EnsureDirs puts a managed dir's permissions back to 0700.
func TestManagedDirPermissions(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	w, err := e.m.Create(ctx, CreateOptions{Name: "shop", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []os.FileMode{0o777, 0o000, 0o755} {
		if err := os.Chmod(w.ManagedDir, mode); err != nil {
			t.Fatal(err)
		}
		if err := e.m.EnsureDirs(ctx, w.ID); err != nil {
			t.Fatal(err)
		}
		if fi, err := os.Stat(w.ManagedDir); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("after chmod %#o: %v %v, want 0700", mode, fi.Mode().Perm(), err)
		}
	}
}

// InstructionsFile skips a CLAUDE.md that is not a file (a folder, a symlink loop) for
// AGENTS.md, and says what it skipped; Strays lists a rooted managed dir's real files.
func TestInstructionsFileAndStrays(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "AGENTS.md"), "agents")
	if p, skipped := InstructionsFile(dir); p != filepath.Join(dir, "AGENTS.md") || len(skipped) != 0 {
		t.Errorf("AGENTS.md only: %q %v", p, skipped)
	}
	if err := os.Mkdir(filepath.Join(dir, "CLAUDE.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	if p, skipped := InstructionsFile(dir); p != filepath.Join(dir, "AGENTS.md") || !slices.Equal(skipped, []string{filepath.Join(dir, "CLAUDE.md")}) {
		t.Errorf("CLAUDE.md a folder: %q %v", p, skipped)
	}
	loop := t.TempDir()
	if err := os.Symlink("CLAUDE.md", filepath.Join(loop, "CLAUDE.md")); err != nil {
		t.Fatal(err)
	}
	if p, skipped := InstructionsFile(loop); p != "" || len(skipped) != 1 {
		t.Errorf("a symlink loop: %q %v", p, skipped)
	}

	managed, root := t.TempDir(), t.TempDir()
	write(t, filepath.Join(managed, "CLAUDE.md"), "stray")
	if err := os.Symlink(filepath.Join(root, ".claude"), filepath.Join(managed, ".claude")); err != nil {
		t.Fatal(err)
	}
	if got := Strays(Workspace{ManagedDir: managed, RootPath: root}); !slices.Equal(got, []string{filepath.Join(managed, "CLAUDE.md")}) {
		t.Errorf("Strays = %v", got)
	}
	if got := Strays(Workspace{ManagedDir: managed}); got != nil {
		t.Errorf("Strays of a synthetic workspace = %v", got)
	}
}

// A project whose id or name is "workspace" wins over the keyword.
func TestIsKeyword(t *testing.T) {
	plain := &project.Snapshot{Projects: []project.Project{{ID: "r-web", Name: "web"}}}
	named := &project.Snapshot{Projects: []project.Project{{ID: "r-ws", Name: "workspace"}}}
	for _, tt := range []struct {
		name string
		snap *project.Snapshot
		ref  string
		want bool
	}{
		{"the keyword", plain, "workspace", true},
		{"any case", plain, " Workspace ", true},
		{"a project name", plain, "web", false},
		{"a project named workspace", named, "workspace", false},
		{"no snapshot", nil, "workspace", true},
	} {
		if got := IsKeyword(tt.snap, tt.ref); got != tt.want {
			t.Errorf("%s: IsKeyword(%q) = %v, want %v", tt.name, tt.ref, got, tt.want)
		}
	}
	e := newStoreEnv(t)
	e.pf.Put(project.Project{ID: "r-ws", Name: "workspace", Path: "/src/workspace", Git: true})
	ctx := context.Background()
	w, err := e.m.Create(ctx, CreateOptions{Name: "scan", Members: []string{"web", "r-ws"}, DefaultPrimary: "workspace"})
	if err != nil || w.DefaultPrimary != "r-ws" {
		t.Fatalf("default primary \"workspace\" with a project of that name = %+v, %v", w, err)
	}
	if w, err = e.m.SetDefaultPrimary(ctx, w.ID, "web"); err != nil {
		t.Fatal(err)
	}
	if w, err = e.m.SetDefaultPrimary(ctx, w.ID, "workspace"); err != nil || w.DefaultPrimary != "r-ws" {
		t.Fatalf("set-primary workspace = %+v, %v", w, err)
	}
}
