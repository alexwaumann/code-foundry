package workspace

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

type storeEnv struct {
	t      *testing.T
	m      *Manager
	dir    string
	home   string
	dbPath string
	pf     *projecttest.Fake
}

func newStoreEnv(t *testing.T) *storeEnv {
	t.Helper()
	e := &storeEnv{t: t, dir: t.TempDir(), home: t.TempDir(), dbPath: dbtest.Path(t), pf: projecttest.New(nil)}
	e.pf.Put(project.Project{ID: "r-web", Name: "web", Path: "/src/web", Git: true})
	e.pf.Put(project.Project{ID: "r-api", Name: "api", Path: "/src/api", Git: true})
	e.pf.Put(project.Project{ID: "r-docs", Name: "docs", Path: "/src/docs"})
	e.open()
	return e
}

func (e *storeEnv) open() {
	e.t.Helper()
	d, err := db.Open(context.Background(), e.dbPath)
	if err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(func() { _ = d.Close() })
	m, err := New(context.Background(), Options{DB: d, Projects: e.pf, Dir: e.dir, Home: e.home,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		e.t.Fatal(err)
	}
	e.m = m
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func linkTarget(path string) string {
	t, err := os.Readlink(path)
	if err != nil {
		return ""
	}
	return t
}

// A synthetic workspace: members sorted and resolved by name, the first given is the
// default primary, a managed dir made; names are unique whatever their case; everything
// survives a reopen; Remove deletes the managed dir.
func TestSyntheticWorkspace(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	w, err := e.m.Create(ctx, CreateOptions{Name: "Shop", Members: []string{"web", "r-api"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(w.Members, []string{"r-api", "r-web"}) || w.DefaultPrimary != "r-web" || w.ManagedDir != filepath.Join(e.dir, w.ID) || !w.Synthetic() {
		t.Fatalf("created %+v", w)
	}
	if fi, err := os.Stat(w.ManagedDir); err != nil || !fi.IsDir() {
		t.Fatalf("managed dir: %v", err)
	}
	write(t, filepath.Join(w.ManagedDir, "CLAUDE.md"), "rules")
	for _, tt := range []struct {
		name string
		o    CreateOptions
		want error
	}{
		{"name taken in another case", CreateOptions{Name: "SHOP", Members: []string{"web"}}, ErrFailedPrecondition},
		{"no projects, no root", CreateOptions{Name: "empty"}, ErrInvalidArgument},
		{"unknown project", CreateOptions{Name: "x", Members: []string{"nope"}}, ErrNotFound},
		{"twice", CreateOptions{Name: "x", Members: []string{"web", "r-web"}}, ErrInvalidArgument},
		{"reserved name", CreateOptions{Name: "Workspace", Members: []string{"web"}}, ErrInvalidArgument},
		{"primary not a member", CreateOptions{Name: "x", Members: []string{"web"}, DefaultPrimary: "api"}, ErrNotFound},
		{"root outside home", CreateOptions{Name: "x", RootPath: t.TempDir()}, ErrInvalidArgument},
	} {
		if _, err := e.m.Create(ctx, tt.o); !errors.Is(err, tt.want) {
			t.Errorf("%s: err = %v, want %v", tt.name, err, tt.want)
		}
	}
	if w, err = e.m.AddProject(ctx, "shop", "docs"); err != nil || !slices.Equal(w.Members, []string{"r-api", "r-docs", "r-web"}) {
		t.Fatalf("AddProject = %+v, %v", w, err)
	}
	if _, err := e.m.AddProject(ctx, w.ID, "docs"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("AddProject twice = %v", err)
	}
	if w, err = e.m.RemoveProject(ctx, "Shop", "web"); err != nil || w.DefaultPrimary != "r-api" || w.Member("r-web") { // the first member left (synthetic)
		t.Fatalf("RemoveProject = %+v, %v", w, err)
	}
	if w, err = e.m.SetDefaultPrimary(ctx, w.ID, "api"); err != nil || w.DefaultPrimary != "r-api" {
		t.Fatalf("SetDefaultPrimary = %+v, %v", w, err)
	}
	if _, err = e.m.Create(ctx, CreateOptions{Name: "Other", Members: []string{"web"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Rename(ctx, w.ID, "other"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("Rename onto another's name = %v", err)
	}
	if w, err = e.m.Rename(ctx, w.ID, "Store"); err != nil || w.Name != "Store" {
		t.Fatalf("Rename = %+v, %v", w, err)
	}

	e.open()
	got, ok := e.m.Snapshot().Workspace(w.ID)
	if !ok || got.Name != "Store" || got.DefaultPrimary != "r-api" || !slices.Equal(got.Members, []string{"r-api", "r-docs"}) || got.ManagedDir != w.ManagedDir {
		t.Fatalf("after reopen %+v", got)
	}
	if err := e.m.Remove(ctx, "store"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(w.ManagedDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("synthetic managed dir kept: %v", err)
	}
	if _, ok := e.m.Snapshot().Workspace(w.ID); ok {
		t.Error("removed workspace still listed")
	}
}

// A rooted workspace links its root's CLAUDE.md, AGENTS.md and .claude that exist;
// EnsureDirs adds missing links and drops dangling ones; Remove deletes only the links.
func TestRootedWorkspaceLinks(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	root := filepath.Join(e.home, "mono")
	write(t, filepath.Join(root, "CLAUDE.md"), "root rules")
	write(t, filepath.Join(root, ".claude", "skills", "x", "SKILL.md"), "skill")
	w, err := e.m.Create(ctx, CreateOptions{Name: "mono", RootPath: root, Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	if w.DefaultPrimary != PrimaryWorkspace || w.RootPath != realPath(root) || w.Dir() != w.RootPath {
		t.Fatalf("created %+v", w)
	}
	rroot := realPath(root)
	if linkTarget(filepath.Join(w.ManagedDir, "CLAUDE.md")) != filepath.Join(rroot, "CLAUDE.md") ||
		linkTarget(filepath.Join(w.ManagedDir, ".claude")) != filepath.Join(rroot, ".claude") {
		t.Fatalf("links missing in %s", w.ManagedDir)
	}
	if _, err := os.Lstat(filepath.Join(w.ManagedDir, "AGENTS.md")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("AGENTS.md linked without a target: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(w.ManagedDir, "CLAUDE.md")); err != nil || string(b) != "root rules" {
		t.Errorf("read through the link: %q %v", b, err)
	}
	// The root gains AGENTS.md and loses CLAUDE.md.
	write(t, filepath.Join(root, "AGENTS.md"), "agents")
	if err := os.Remove(filepath.Join(root, "CLAUDE.md")); err != nil {
		t.Fatal(err)
	}
	if err := e.m.EnsureDirs(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	if linkTarget(filepath.Join(w.ManagedDir, "AGENTS.md")) != filepath.Join(rroot, "AGENTS.md") {
		t.Error("missing link not added")
	}
	if _, err := os.Lstat(filepath.Join(w.ManagedDir, "CLAUDE.md")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("dangling link kept: %v", err)
	}
	if err := e.m.Remove(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(w.ManagedDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("managed dir of only links kept: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "AGENTS.md")); err != nil {
		t.Errorf("root file removed: %v", err)
	}
}

// A managed dir deleted by hand comes back at the next start.
func TestManagedDirsAtStart(t *testing.T) {
	e := newStoreEnv(t)
	w, err := e.m.Create(context.Background(), CreateOptions{Name: "a", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(w.ManagedDir); err != nil {
		t.Fatal(err)
	}
	e.open()
	if fi, err := os.Stat(w.ManagedDir); err != nil || !fi.IsDir() {
		t.Errorf("managed dir not made at start: %v", err)
	}
}

// The managed dir's contents: none at first; CLAUDE.md beats AGENTS.md; skills are the
// folders with a SKILL.md, sorted; EnsureDirs reads them again and publishes Updated only
// when they changed; a rooted workspace reports the root's real file; a reopen reads them.
func TestWorkspaceContents(t *testing.T) {
	e := newStoreEnv(t)
	ctx := context.Background()
	events := bus.Subscribe[Event](e.m.Bus(), 16)
	defer events.Close()
	w, err := e.m.Create(ctx, CreateOptions{Name: "shop", Members: []string{"web"}})
	if err != nil {
		t.Fatal(err)
	}
	<-events.C() // Create's Updated
	if w.Instructions != "" || len(w.Skills) != 0 {
		t.Fatalf("new synthetic workspace: instructions %q, skills %v; want none", w.Instructions, w.Skills)
	}
	write(t, filepath.Join(w.ManagedDir, "AGENTS.md"), "agents")
	write(t, filepath.Join(w.ManagedDir, ".claude", "skills", "zeta", "SKILL.md"), "z")
	write(t, filepath.Join(w.ManagedDir, ".claude", "skills", "alpha", "SKILL.md"), "a")
	write(t, filepath.Join(w.ManagedDir, ".claude", "skills", "notes", "README.md"), "no SKILL.md")
	if err := e.m.EnsureDirs(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Snapshot().Workspace(w.ID)
	if want := filepath.Join(w.ManagedDir, "AGENTS.md"); got.Instructions != want || !slices.Equal(got.Skills, []string{"alpha", "zeta"}) {
		t.Fatalf("after writes: instructions %q, skills %v; want %q, [alpha zeta]", got.Instructions, got.Skills, want)
	}
	select {
	case ev := <-events.C():
		if u, ok := ev.(Updated); !ok || u.Workspace.Instructions == "" {
			t.Fatalf("event %#v, want Updated with the instructions", ev)
		}
	default:
		t.Fatal("no Updated after the contents changed")
	}
	write(t, filepath.Join(w.ManagedDir, "CLAUDE.md"), "claude")
	if err := e.m.EnsureDirs(ctx, ""); err != nil {
		t.Fatal(err)
	}
	<-events.C()
	if err := e.m.EnsureDirs(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-events.C():
		t.Fatalf("unchanged contents published %#v", ev)
	default:
	}
	got, _ = e.m.Snapshot().Workspace(w.ID)
	if want := filepath.Join(w.ManagedDir, "CLAUDE.md"); got.Instructions != want {
		t.Fatalf("instructions %q, want %q (CLAUDE.md first)", got.Instructions, want)
	}
	// A rename keeps them (the commit reads them again).
	if r, err := e.m.Rename(ctx, w.ID, "store"); err != nil || r.Instructions == "" || len(r.Skills) != 2 {
		t.Fatalf("rename: %+v, %v", r, err)
	}

	root := filepath.Join(e.home, "mono")
	write(t, filepath.Join(root, "CLAUDE.md"), "root")
	write(t, filepath.Join(root, ".claude", "skills", "demo", "SKILL.md"), "demo")
	rw, err := e.m.Create(ctx, CreateOptions{Name: "mono", RootPath: root})
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(realPath(root), "CLAUDE.md"); rw.Instructions != want || !slices.Equal(rw.Skills, []string{"demo"}) {
		t.Fatalf("rooted: instructions %q, skills %v; want %q, [demo]", rw.Instructions, rw.Skills, want)
	}
	e.open()
	if got, _ := e.m.Snapshot().Workspace(rw.ID); got.Instructions == "" || len(got.Skills) != 1 {
		t.Fatalf("after reopen: %+v", got)
	}
}
