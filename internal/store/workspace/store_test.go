package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// faultyProjects wraps the project fake to fail CreateWorktree for one project and
// RemoveWorktree for one path (as git does for a dirty worktree).
type faultyProjects struct {
	*projecttest.Fake
	failCreate string // project id
	failRemove string // worktree path
}

func (f *faultyProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if o.ProjectID == f.failCreate {
		return project.Worktree{}, fmt.Errorf("%w: git: fatal: invalid reference: %s", project.ErrFailedPrecondition, o.BaseRef)
	}
	return f.Fake.CreateWorktree(ctx, o)
}

func (f *faultyProjects) RemoveWorktree(ctx context.Context, o project.RemoveWorktreeOptions) error {
	if o.Path == f.failRemove && !o.Force {
		return fmt.Errorf("%w: git: fatal: '%s' contains modified or untracked files, use --force to delete it", project.ErrFailedPrecondition, o.Path)
	}
	return f.Fake.RemoveWorktree(ctx, o)
}

type harness struct {
	t        *testing.T
	db       *sql.DB
	bus      *bus.Bus
	projects *faultyProjects
	m        *Manager
	root     string // worktree root; member worktrees are real directories under it
	trusted  []string
	threads  []Thread
	mu       sync.Mutex
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, dbtest.Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	b := bus.New()
	h := &harness{t: t, db: d, bus: b, projects: &faultyProjects{Fake: projecttest.New(b)}, root: t.TempDir()}
	h.projects.WorktreeRoot = h.root
	for _, name := range []string{"web", "api", "lib"} {
		if _, err := h.projects.Register(ctx, "/src/"+name); err != nil {
			t.Fatal(err)
		}
	}
	// A project without git: never a member.
	h.projects.NotGit = true
	if _, err := h.projects.Register(ctx, "/src/notes"); err != nil {
		t.Fatal(err)
	}
	h.projects.NotGit = false
	h.m = h.open()
	return h
}

func (h *harness) open() *Manager {
	h.t.Helper()
	m, err := New(context.Background(), Options{
		DB: h.db, Projects: h.projects, Bus: h.bus,
		Threads: func() []Thread {
			h.mu.Lock()
			defer h.mu.Unlock()
			return slices.Clone(h.threads)
		},
		Trust: func(dir string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.trusted = append(h.trusted, dir)
			// The fake does not touch disk; make the worktree exist like git would.
			return os.MkdirAll(dir, 0o755)
		},
		Now: func() time.Time { return time.UnixMilli(1_700_000_000_000) },
	})
	if err != nil {
		h.t.Fatal(err)
	}
	return m
}

// id is the fake project id for /src/<name>.
func id(name string) string { return projecttest.ID("/src/" + name) }

func (h *harness) wt(name, branch string) string {
	return filepath.Join(h.root, "_local", name, strings.ReplaceAll(branch, "/", "-"))
}

func (h *harness) create(name string, projects ...string) Workspace {
	h.t.Helper()
	specs := make([]MemberSpec, len(projects))
	for i, r := range projects {
		specs[i] = MemberSpec{Project: r}
	}
	w, err := h.m.Create(context.Background(), CreateOptions{Name: name, Members: specs, Fetch: true})
	if err != nil {
		h.t.Fatal(err)
	}
	return w
}

func (h *harness) worktrees(projectName string) []string {
	r, _ := h.projects.Snapshot().Project(id(projectName))
	var out []string
	for _, w := range r.Worktrees {
		if !w.IsMain {
			out = append(out, w.Path)
		}
	}
	return out
}

func TestCreate(t *testing.T) {
	h := newHarness(t)
	sub := bus.Subscribe[Event](h.bus, 8)
	defer sub.Close()
	w, err := h.m.Create(context.Background(), CreateOptions{
		Name: "Login fix", BaseRef: "origin/develop", Fetch: true,
		Members: []MemberSpec{{Project: "web"}, {Project: id("api"), BaseRef: "origin/main"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(w.ID, "w-") || w.Name != "Login fix" || w.Branch != "cf/login-fix" {
		t.Fatalf("workspace = %+v", w)
	}
	want := []Member{
		{ProjectID: id("web"), WorktreePath: h.wt("web", "cf/login-fix")},
		{ProjectID: id("api"), WorktreePath: h.wt("api", "cf/login-fix")},
	}
	if !slices.Equal(w.Members, want) {
		t.Fatalf("members = %+v, want %+v", w.Members, want)
	}
	creates := h.projects.Creates
	if len(creates) != 2 || creates[0].BaseRef != "origin/develop" || creates[1].BaseRef != "origin/main" ||
		!creates[0].Fetch || creates[0].Branch != "cf/login-fix" {
		t.Fatalf("creates = %+v", creates)
	}
	if !slices.Equal(h.trusted, []string{want[0].WorktreePath, want[1].WorktreePath}) {
		t.Fatalf("trusted = %v", h.trusted)
	}
	select {
	case ev := <-sub.C():
		if u, ok := ev.(Updated); !ok || u.Workspace.ID != w.ID {
			t.Fatalf("event = %#v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no Updated event")
	}
	if got, ok := h.m.Snapshot().Workspace(w.ID); !ok || len(got.Members) != 2 {
		t.Fatalf("snapshot = %+v", h.m.Snapshot())
	}
	// Persisted: a new Manager over the same database sees it.
	again := h.open()
	if got, ok := again.Snapshot().Workspace(w.ID); !ok || !slices.Equal(got.Members, want) || got.Branch != w.Branch ||
		!got.CreatedAt.Equal(w.CreatedAt) {
		t.Fatalf("reloaded = %+v, want %+v", got, w)
	}
}

func TestCreateRefusals(t *testing.T) {
	tests := []struct {
		name    string
		opts    CreateOptions
		wantErr error
		errText string
	}{
		{"no name", CreateOptions{Members: []MemberSpec{{Project: "web"}}}, ErrInvalidArgument, "name"},
		{"no members", CreateOptions{Name: "x"}, ErrInvalidArgument, "at least one"},
		{"unknown repo", CreateOptions{Name: "x", Members: []MemberSpec{{Project: "web"}, {Project: "nope"}}}, ErrNotFound, "nope"},
		{"repo twice", CreateOptions{Name: "x", Members: []MemberSpec{{Project: "web"}, {Project: id("web")}}}, ErrInvalidArgument, "twice"},
		{"bad base", CreateOptions{Name: "x", Members: []MemberSpec{{Project: "web", BaseRef: "--upload-pack=x"}}}, ErrInvalidArgument, "base ref"},
		{"name taken", CreateOptions{Name: "taken", Members: []MemberSpec{{Project: "lib"}}}, ErrFailedPrecondition, "exists"},
		{"project without git", CreateOptions{Name: "x", Members: []MemberSpec{{Project: "web"}, {Project: "notes"}}}, ErrFailedPrecondition, "notes is not a git repository"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.create("taken", "api")
			before := len(h.projects.Creates)
			_, err := h.m.Create(context.Background(), tt.opts)
			if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.errText) {
				t.Fatalf("err = %v, want %v mentioning %q", err, tt.wantErr, tt.errText)
			}
			if n := len(h.projects.Creates); n != before {
				t.Fatalf("a worktree was created: %+v", h.projects.Creates[before:])
			}
			if n := len(h.m.Snapshot().Workspaces); n != 1 {
				t.Fatalf("workspaces = %d", n)
			}
		})
	}
}

func TestCreateRollsBack(t *testing.T) {
	h := newHarness(t)
	h.projects.failCreate = id("api")
	_, err := h.m.Create(context.Background(), CreateOptions{Name: "x", Members: []MemberSpec{{Project: "web"}, {Project: "api"}}})
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "create worktree cf/x in api") ||
		!strings.Contains(err.Error(), "invalid reference") {
		t.Fatalf("err = %v", err)
	}
	if got := h.worktrees("web"); len(got) != 0 {
		t.Fatalf("web worktrees after rollback = %v", got)
	}
	calls := strings.Join(h.projects.Calls, "\n")
	if !strings.Contains(calls, "RemoveWorktree "+id("web")+" "+h.wt("web", "cf/x")) {
		t.Fatalf("calls = %s", calls)
	}
	if len(h.m.Snapshot().Workspaces) != 0 {
		t.Fatal("workspace recorded")
	}
	var n int
	if err := h.db.QueryRow(`SELECT count(*) FROM workspaces`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows = %d, %v", n, err)
	}
}

func TestAddProject(t *testing.T) {
	h := newHarness(t)
	w := h.create("x", "web")
	tests := []struct {
		name    string
		opts    AddProjectOptions
		wantErr error
		errText string
	}{
		{"by cwd", AddProjectOptions{Ref: Ref{Cwd: h.wt("web", "cf/x") + "/src"}, Member: MemberSpec{Project: "api"}, Fetch: true}, nil, ""},
		{"already a member", AddProjectOptions{Ref: Ref{Workspace: "x"}, Member: MemberSpec{Project: "web"}}, ErrFailedPrecondition, "already in workspace x"},
		{"unknown workspace", AddProjectOptions{Ref: Ref{Workspace: "y"}, Member: MemberSpec{Project: "lib"}}, ErrNotFound, "workspace"},
		{"project without git", AddProjectOptions{Ref: Ref{Workspace: "x"}, Member: MemberSpec{Project: "notes"}}, ErrFailedPrecondition, "not a git repository"},
		{"cwd outside", AddProjectOptions{Ref: Ref{Cwd: "/elsewhere"}, Member: MemberSpec{Project: "lib"}}, ErrNotFound, "not inside"},
		{"by id with base", AddProjectOptions{Ref: Ref{Workspace: w.ID}, Member: MemberSpec{Project: "lib", BaseRef: "v1.2"}}, nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := h.m.AddProject(context.Background(), tt.opts)
			if !errors.Is(err, tt.wantErr) || (err != nil && !strings.Contains(err.Error(), tt.errText)) {
				t.Fatalf("err = %v, want %v mentioning %q", err, tt.wantErr, tt.errText)
			}
		})
	}
	got, _ := h.m.Snapshot().Workspace(w.ID)
	want := []Member{
		{ProjectID: id("web"), WorktreePath: h.wt("web", "cf/x")},
		{ProjectID: id("api"), WorktreePath: h.wt("api", "cf/x")},
		{ProjectID: id("lib"), WorktreePath: h.wt("lib", "cf/x")},
	}
	if !slices.Equal(got.Members, want) {
		t.Fatalf("members = %+v", got.Members)
	}
	if last := h.projects.Creates[len(h.projects.Creates)-1]; last.Branch != "cf/x" || last.BaseRef != "v1.2" {
		t.Fatalf("last create = %+v", last)
	}
	again, _ := h.open().Snapshot().Workspace(w.ID)
	if !slices.Equal(again.Members, want) {
		t.Fatalf("reloaded members = %+v", again.Members)
	}
}

func TestRemoveProject(t *testing.T) {
	tests := []struct {
		name    string
		threads []Thread
		dirty   bool
		opts    RemoveProjectOptions
		wantErr error
		errText string
		removed bool
	}{
		{name: "by name", opts: RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api"}, removed: true},
		{
			name:    "a thread on the worktree",
			threads: []Thread{{ID: "s-1", Name: "fix-login", Cwd: "API/src"}},
			opts:    RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api"},
			wantErr: ErrFailedPrecondition, errText: "thread fix-login (s-1) is on API; archive it first",
		},
		{
			name:    "two threads on the worktree",
			threads: []Thread{{ID: "s-1", Cwd: "API"}, {ID: "s-2", Cwd: "API/src"}},
			opts:    RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api"},
			wantErr: ErrFailedPrecondition, errText: "thread s-1, thread s-2 are on API; archive them first",
		},
		{
			name:    "thread in another member is fine",
			threads: []Thread{{ID: "s-1", Cwd: "WEB"}},
			opts:    RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api"}, removed: true,
		},
		{
			name: "dirty", dirty: true,
			opts:    RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api"},
			wantErr: ErrFailedPrecondition, errText: "use --force",
		},
		{name: "dirty with force", dirty: true, opts: RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "api", Force: true}, removed: true},
		{name: "by cwd and worktree path", opts: RemoveProjectOptions{Ref: Ref{Cwd: "WEB"}, Project: "API"}, removed: true},
		{name: "not a member", opts: RemoveProjectOptions{Ref: Ref{Workspace: "x"}, Project: "lib"}, wantErr: ErrNotFound, errText: "not a member"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			w := h.create("x", "web", "api")
			subst := strings.NewReplacer("API", h.wt("api", "cf/x"), "WEB", h.wt("web", "cf/x"))
			for _, th := range tt.threads {
				th.Cwd = subst.Replace(th.Cwd)
				h.threads = append(h.threads, th)
			}
			tt.opts.Cwd, tt.opts.Project = subst.Replace(tt.opts.Cwd), subst.Replace(tt.opts.Project)
			if tt.dirty {
				h.projects.failRemove = h.wt("api", "cf/x")
			}
			got, err := h.m.RemoveProject(context.Background(), tt.opts)
			if !errors.Is(err, tt.wantErr) || (err != nil && !strings.Contains(err.Error(), subst.Replace(tt.errText))) {
				t.Fatalf("err = %v, want %v mentioning %q", err, tt.wantErr, subst.Replace(tt.errText))
			}
			snap, _ := h.m.Snapshot().Workspace(w.ID)
			stored, _ := h.open().Snapshot().Workspace(w.ID)
			_, inSnap := snap.Member(id("api"))
			_, inDB := stored.Member(id("api"))
			if inSnap == tt.removed || inDB == tt.removed {
				t.Fatalf("api member in snapshot %v, in db %v; want removed=%v", inSnap, inDB, tt.removed)
			}
			if tt.removed {
				if _, ok := got.Member(id("api")); ok || len(got.Members) != 1 {
					t.Fatalf("returned workspace = %+v", got)
				}
				if wts := h.worktrees("api"); len(wts) != 0 {
					t.Fatalf("api worktrees = %v", wts)
				}
			}
		})
	}
}

func TestRemoveProjectWhenWorktreeAlreadyGone(t *testing.T) {
	h := newHarness(t)
	w := h.create("x", "web", "api")
	path := h.wt("api", "cf/x")
	// Deleted by hand, and the project store no longer lists it.
	if err := h.projects.RemoveWorktree(context.Background(), project.RemoveWorktreeOptions{ProjectID: id("api"), Path: path}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.RemoveProject(context.Background(), RemoveProjectOptions{Ref: Ref{Workspace: w.ID}, Project: "api"}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.m.Snapshot().Workspace(w.ID); len(got.Members) != 1 {
		t.Fatalf("members = %+v", got.Members)
	}
}

func TestRemove(t *testing.T) {
	tests := []struct {
		name    string
		threads []Thread
		dirty   string // project name whose worktree the project store reports dirty
		gitDirt bool   // git refuses to remove api's worktree
		force   bool
		wantErr error
		errText string
		gone    bool
		left    []string // members kept when not gone
	}{
		{name: "clean", gone: true},
		{
			name:    "threads in two members",
			threads: []Thread{{ID: "s-1", Cwd: "WEB"}, {ID: "s-2", Name: "b", Cwd: "API/x"}},
			wantErr: ErrFailedPrecondition, errText: "thread s-1 is on WEB; thread b (s-2) is on API; archive them first", left: []string{"web", "api"},
		},
		{name: "dirty refused before anything is removed", dirty: "api", wantErr: ErrFailedPrecondition,
			errText: "uncommitted changes in api (API)", left: []string{"web", "api"}},
		{name: "dirty with force", dirty: "api", force: true, gone: true},
		{name: "git refuses midway", gitDirt: true, wantErr: ErrFailedPrecondition, errText: "use --force", left: []string{"api"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			w := h.create("x", "web", "api")
			subst := strings.NewReplacer("API", h.wt("api", "cf/x"), "WEB", h.wt("web", "cf/x"))
			for _, th := range tt.threads {
				th.Cwd = subst.Replace(th.Cwd)
				h.threads = append(h.threads, th)
			}
			if tt.dirty != "" {
				p := h.wt(tt.dirty, "cf/x")
				h.projects.UpdateWorktree(project.Worktree{ProjectID: id(tt.dirty), Path: p, Branch: "cf/x", Status: project.Status{Dirty: true}})
			}
			if tt.gitDirt {
				h.projects.failRemove = h.wt("api", "cf/x")
			}
			sub := bus.Subscribe[Event](h.bus, 8)
			defer sub.Close()
			err := h.m.Remove(context.Background(), RemoveOptions{Workspace: "x", Force: tt.force})
			if !errors.Is(err, tt.wantErr) || (err != nil && !strings.Contains(err.Error(), subst.Replace(tt.errText))) {
				t.Fatalf("err = %v, want %v mentioning %q", err, tt.wantErr, subst.Replace(tt.errText))
			}
			_, inSnap := h.m.Snapshot().Workspace(w.ID)
			stored, inDB := h.open().Snapshot().Workspace(w.ID)
			if inSnap == tt.gone || inDB == tt.gone {
				t.Fatalf("workspace in snapshot %v, in db %v; want gone=%v", inSnap, inDB, tt.gone)
			}
			if tt.gone {
				if len(h.worktrees("web")) != 0 || len(h.worktrees("api")) != 0 {
					t.Fatalf("worktrees left: %v %v", h.worktrees("web"), h.worktrees("api"))
				}
				var removed bool
				for len(sub.C()) > 0 {
					if r, ok := (<-sub.C()).(Removed); ok && r.ID == w.ID {
						removed = true
					}
				}
				if !removed {
					t.Fatal("no Removed event")
				}
				return
			}
			var left []string
			for _, m := range stored.Members {
				left = append(left, strings.TrimPrefix(m.ProjectID, "id-src-"))
			}
			if !slices.Equal(left, tt.left) {
				t.Fatalf("members left = %v, want %v", left, tt.left)
			}
		})
	}
}

func TestMembers(t *testing.T) {
	h := newHarness(t)
	w := h.create("x", "web", "api")
	m, err := h.m.Members(context.Background(), Ref{Cwd: h.wt("api", "cf/x") + "/pkg"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Workspace.ID != w.ID || len(m.Members) != 2 || m.Members[0].ProjectName != "web" || m.Members[0].Current ||
		!m.Members[1].Current || m.Members[1].Branch != "cf/x" || m.Members[1].Missing {
		t.Fatalf("membership = %+v", m)
	}
	if _, err := h.m.Members(context.Background(), Ref{Cwd: "/src/web"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("main worktree resolved a workspace: %v", err)
	}
}
