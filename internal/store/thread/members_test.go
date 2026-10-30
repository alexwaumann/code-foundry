package thread

import (
	"context"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

// The pure halves of a set change: the set, the record and the workspace reference.
func TestWithAndWithoutMember(t *testing.T) {
	base := Thread{ID: "s-1", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/w/web",
		CheckoutPaths: map[string]string{"web": "/w/web", "api": "/w/api"}, WorkspaceID: "w-plat"}
	t.Run("add", func(t *testing.T) {
		got := WithMember(base, "lib", "/w/lib")
		if !slices.Equal(got.ProjectIDs, []string{"api", "lib", "web"}) || got.CheckoutPaths["lib"] != "/w/lib" || got.WorkspaceID != "" {
			t.Errorf("added %+v", got)
		}
		if _, ok := base.CheckoutPaths["lib"]; ok || base.WorkspaceID != "w-plat" {
			t.Errorf("the original changed: %+v", base)
		}
	})
	tests := []struct {
		name    string
		s       Thread
		remove  string
		want    []string
		wantErr string
	}{
		{name: "a member", s: base, remove: "api", want: []string{"web"}},
		{name: "the cwd's", s: base, remove: "web", wantErr: "is where thread s-1 runs"},
		{name: "a queued Run in's target", s: func() Thread { s := base; s.PendingWorktreePath = "/w/api"; return s }(), remove: "api", wantErr: "moves to api once it is idle"},
		{name: "no record", s: func() Thread { s := base; s.CheckoutPaths = nil; return s }(), remove: "api", want: []string{"web"}},
	}
	for _, tt := range tests {
		t.Run("remove "+tt.name, func(t *testing.T) {
			before := maps.Clone(tt.s.CheckoutPaths)
			got, err := WithoutMember(tt.s, tt.remove, tt.remove)
			if tt.wantErr != "" {
				if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got.ProjectIDs, tt.want) || got.WorkspaceID != "" {
				t.Errorf("removed %+v", got)
			}
			if _, ok := got.CheckoutPaths[tt.remove]; ok {
				t.Errorf("the record of %s stayed: %v", tt.remove, got.CheckoutPaths)
			}
			if !maps.Equal(tt.s.CheckoutPaths, before) {
				t.Errorf("the original's record changed: %v", tt.s.CheckoutPaths)
			}
		})
	}
}

func TestCheckMembersChange(t *testing.T) {
	tests := []struct {
		name string
		s    Thread
		want string
	}{
		{name: "a project thread", s: Thread{ID: "s-1", ProjectID: "web", ProjectIDs: []string{"web"}}},
		{name: "no project", s: Thread{ID: "s-1"}, want: "has no project"},
		{name: "archived", s: Thread{ID: "s-1", ProjectID: "web", ProjectIDs: []string{"web"}, ArchivedAt: time.Unix(1, 0)}, want: "is archived; unarchive it first"},
		{name: "in its workspace's folder", s: Thread{ID: "s-1", ProjectIDs: []string{"api", "web"}, WorkspaceID: "w-1"}, want: "workspace w-1's folder"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := CheckMembersChange(tt.s)
			if (tt.want == "") != (err == nil) || err != nil && !strings.Contains(err.Error(), tt.want) {
				t.Errorf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

// memberEnv is multiEnv with a third project, lib (a plain folder), and a workspace
// store holding "platform" (repo and api).
func memberEnv(t *testing.T, mutate ...func(*Options)) (*env, *recordingProjects, string) {
	t.Helper()
	ws := workspacetest.New(nil)
	ws.Dir, ws.MakeDirs = t.TempDir(), true
	e, rr := multiEnv(t, append([]func(*Options){func(o *Options) {
		o.Projects.(*recordingProjects).MakeDirs = true
		o.Workspaces = ws
	}}, mutate...)...)
	ws.Put(workspace.Workspace{ID: "w-plat", Name: "platform", Members: []string{"r1", "r2"}, DefaultPrimary: "r1"})
	if err := ws.EnsureDirs(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	lib := filepath.Join(t.TempDir(), "lib")
	if err := os.MkdirAll(lib, 0o755); err != nil {
		t.Fatal(err)
	}
	rr.Put(project.Project{ID: "r3", Path: lib, Name: "lib"})
	return e, rr, lib
}

func hasDirsRestartNote(items []Item) bool {
	return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindCommandOutput && it.Text == DirsRestartNote })
}

func hasNote(prefix string) func([]Item) bool {
	return func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool { return it.Kind == KindNote && strings.HasPrefix(it.Text, prefix) })
	}
}

// A live worktree-mode thread from a named workspace: adding api makes its worktree for
// the thread's branch, leaves the workspace, notes it, and Claude restarts (resuming)
// with the worktree as an --add-dir; removing it drops the record, keeps the worktree on
// disk and restarts Claude without it. The cwd's project cannot be removed.
func TestAddAndRemoveProjectLive(t *testing.T) {
	e, rr, _ := memberEnv(t)
	s := e.connected(CreateOptions{ProjectID: "r1", WorkspaceID: "w-plat", ProjectIDs: []string{"r1"}, NewWorktree: &NewWorktree{Branch: "feat/x"}})
	if s.WorkspaceID != "w-plat" || !slices.Equal(s.ProjectIDs, []string{"r1"}) {
		t.Fatalf("created %+v", s)
	}
	e.waitFor(s.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	cid := argOf(e.argvOf(), "--session-id")
	e.writeTranscript(cid, userLine("earlier"))
	made := len(rr.created())

	got, err := e.m.AddProject(e.ctx(), s.ID, "api")
	if err != nil {
		t.Fatal(err)
	}
	apiWT := got.CheckoutPaths["r2"]
	if !slices.Equal(got.ProjectIDs, []string{"r1", "r2"}) || got.WorkspaceID != "" || !strings.HasSuffix(apiWT, "feat-x") || !isDir(apiWT) {
		t.Fatalf("after add %+v", got)
	}
	if c := rr.created(); len(c) != made+1 || c[made].ProjectID != "r2" || c[made].Branch != "feat/x" {
		t.Errorf("CreateWorktree calls %+v, want one more for api on feat/x", c)
	}
	argv := e.waitArgv("the restart with api", func(a []string) bool { return slices.Contains(addDirs(a), apiWT) })
	if argOf(argv, "--resume") != cid {
		t.Errorf("restart argv %q, want --resume %s", argv, cid)
	}
	e.waitItems(s.ID, "the add note and the restart's", func(items []Item) bool {
		return hasNote("Added project api to this thread (new worktree "+apiWT+"). The thread no longer follows workspace platform")(items) &&
			hasNote("")(items) && slices.ContainsFunc(items, func(it Item) bool {
			return it.Kind == KindNote && strings.HasSuffix(it.Text, "Claude restarts with the new folders once it is idle.")
		}) && hasDirsRestartNote(items)
	})
	if _, err := e.m.AddProject(e.ctx(), s.ID, "r2"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("adding it again: %v", err)
	}

	e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected && turnOver(s) })
	if _, err := e.m.RemoveProject(e.ctx(), s.ID, "repo"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "is where thread") {
		t.Errorf("removing the cwd's project: %v", err)
	}
	got, err = e.m.RemoveProject(e.ctx(), s.ID, "api")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.ProjectIDs, []string{"r1"}) || got.CheckoutPaths["r2"] != "" {
		t.Fatalf("after remove %+v", got)
	}
	e.waitArgv("the restart without api", func(a []string) bool { return !slices.Contains(addDirs(a), apiWT) })
	e.waitItems(s.ID, "the remove note", hasNote("Removed project api from this thread. Its checkout ("+apiWT+") stays on disk. Claude restarts with the new folders once it is idle; until then "+apiWT+" stays one of its folders."))
	if !isDir(apiWT) {
		t.Errorf("the removed member's worktree %s is gone", apiWT)
	}
	if slices.ContainsFunc(rr.Calls, func(c string) bool { return strings.HasPrefix(c, "RemoveWorktree") }) {
		t.Errorf("calls %q: nothing should be removed", rr.Calls)
	}
}

// A stopped checkout-mode thread: a git project gets its own checkout and a folder its
// folder, recorded and noted, nothing made and nothing started; the next start passes
// both as --add-dirs. Persisted.
func TestAddProjectStopped(t *testing.T) {
	e, rr, lib := memberEnv(t)
	s := e.create(CreateOptions{ProjectID: "r1"})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	spawns := e.spawnCount()
	for _, ref := range []string{"api", "lib"} {
		if _, err := e.m.AddProject(e.ctx(), s.ID, ref); err != nil {
			t.Fatal(err)
		}
	}
	api, _ := rr.Snapshot().Project("r2")
	got, _ := e.m.Get(e.ctx(), s.ID)
	if !slices.Equal(got.ProjectIDs, []string{"r1", "r2", "r3"}) || got.CheckoutPaths["r2"] != api.Path || got.CheckoutPaths["r3"] != lib || got.State != StateDisconnected {
		t.Fatalf("after adds %+v", got)
	}
	if n := len(rr.created()); n != 0 || e.spawnCount() != spawns {
		t.Errorf("%d worktrees made, %d spawns (want 0, %d)", n, e.spawnCount(), spawns)
	}
	e.waitItems(s.ID, "the notes", func(items []Item) bool {
		return hasNote("Added project api to this thread (checkout "+api.Path+").")(items) && hasNote("Added project lib")(items)
	})
	// Saved as a workspace (the GUI's Save as workspace: workspace.new, then
	// thread.workspace), the thread references it again.
	e.m.opts.Workspaces.(*workspacetest.Fake).Put(workspace.Workspace{ID: "w-trio", Name: "trio", Members: []string{"r1", "r2", "r3"}, DefaultPrimary: "r1"})
	if got, err := e.m.SetWorkspace(e.ctx(), s.ID, "trio"); err != nil || got.WorkspaceID != "w-trio" {
		t.Fatalf("save as workspace = %+v, %v", got, err)
	}
	e.restart()
	if got, _ := e.m.Get(e.ctx(), s.ID); !slices.Equal(got.ProjectIDs, []string{"r1", "r2", "r3"}) || got.CheckoutPaths["r3"] != lib || got.WorkspaceID != "w-trio" {
		t.Errorf("after a daemon restart %+v", got)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
	if dirs := addDirs(e.spec(s.ID).Argv); !slices.Contains(dirs, api.Path) || !slices.Contains(dirs, lib) {
		t.Errorf("add-dirs %q, want api's checkout and lib", dirs)
	}
}

// Adding a member refuses what Create refuses (a default path holding a worktree moved
// to another branch), an unknown project, a thread without a project and one in its
// workspace's folder; nothing changes.
func TestAddProjectRefusals(t *testing.T) {
	e, rr, _ := memberEnv(t, func(o *Options) {
		o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/m" }
	})
	other := e.create(CreateOptions{ProjectID: "r2", NewWorktree: &NewWorktree{Branch: "feat/m"}})
	switchBranch(rr, "r2", other.WorktreePath, "moved")
	s := e.create(CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "feat/m"}})
	docs := filepath.Join(t.TempDir(), "docs")
	if err := os.MkdirAll(docs, 0o755); err != nil {
		t.Fatal(err)
	}
	rr.Put(project.Project{ID: "r4", Path: docs, Name: "docs", Git: true, Worktrees: []project.Worktree{{ProjectID: "r4", Path: docs, IsMain: true, Branch: "feat/m"}}})
	home := e.create(CreateOptions{NoProject: true})
	inFolder := e.create(CreateOptions{WorkspaceID: "w-plat", ProjectID: workspace.PrimaryWorkspace})
	archived := e.create(CreateOptions{ProjectID: "r1"})
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	calls := len(rr.created())

	tests := []struct {
		name, id, ref string
		want          error
		text          string
	}{
		{name: "moved default path", id: s.ID, ref: "api", want: ErrFailedPrecondition, text: "has moved checked out now"},
		{name: "main checkout on the branch", id: s.ID, ref: "docs", want: ErrFailedPrecondition, text: "docs's main checkout at " + docs + " is on feat/m"},
		{name: "unknown project", id: s.ID, ref: "nope", want: ErrNotFound},
		{name: "no project", id: home.ID, ref: "api", want: ErrFailedPrecondition, text: "has no project"},
		{name: "in its workspace's folder", id: inFolder.ID, ref: "lib", want: ErrFailedPrecondition, text: "folder"},
		{name: "archived", id: archived.ID, ref: "lib", want: ErrFailedPrecondition, text: "is archived; unarchive it first"},
		{name: "unknown thread", id: "s-nope", ref: "api", want: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := e.m.AddProject(e.ctx(), tt.id, tt.ref)
			if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.text) {
				t.Fatalf("err = %v, want %v with %q", err, tt.want, tt.text)
			}
		})
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); !slices.Equal(got.ProjectIDs, []string{"r1"}) {
		t.Errorf("the refused thread changed: %+v", got)
	}
	if n := len(rr.created()); n != calls {
		t.Errorf("%d CreateWorktree calls after the refusals, want %d", n, calls)
	}
}

// A set change while Claude works: the note at once, the restart only once the turn is
// over (a permission request holds it), then the restart's own note.
func TestAddProjectRestartWaitsForTheTurn(t *testing.T) {
	e := newFixtureEnv(t, "write-allow")
	api := filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(api, 0o755); err != nil {
		t.Fatal(err)
	}
	e.projects.Put(project.Project{ID: "r2", Path: api, Name: "api", Git: true, Worktrees: []project.Worktree{{ProjectID: "r2", Path: api, IsMain: true, Branch: "main"}}})
	s := e.create(CreateOptions{ProjectID: "r1", PermissionMode: PermissionSupervised, InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	e.writeTranscript(argOf(e.argvOf(), "--session-id"), userLine("write"))
	if _, err := e.m.AddProject(e.ctx(), s.ID, "api"); err != nil {
		t.Fatal(err)
	}
	e.waitItems(s.ID, "the add note", hasNote("Added project api to this thread (checkout "+api+")."))
	time.Sleep(50 * time.Millisecond)
	if dirs := addDirs(e.argvOf()); slices.Contains(dirs, api) {
		t.Fatalf("restarted mid-turn: add-dirs %q", dirs)
	}
	if hasDirsRestartNote(e.items(s.ID).Items) {
		t.Fatal("the restart note came before the restart")
	}
	p := e.items(s.ID).Pending
	if _, err := e.m.Respond(e.ctx(), s.ID, p[0].RequestID, Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	e.waitArgv("the restart after the turn", func(a []string) bool { return slices.Contains(addDirs(a), api) && argOf(a, "--resume") != "" })
	e.waitItems(s.ID, "the restart note", hasDirsRestartNote)
}

// A set change whose note cannot reach the running Claude's runner: the note and the
// failure are queued on it and written at its next maybeRestart, and the flag still
// restarts it once it is idle.
func TestFailedSetChangeNoteRetriesTheRestart(t *testing.T) {
	e, _, _ := memberEnv(t)
	s := e.connected(CreateOptions{ProjectID: "r1"})
	e.waitFor(s.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	e.writeTranscript(argOf(e.argvOf(), "--session-id"), userLine("earlier"))
	api, _ := e.m.opts.Projects.Snapshot().Project("r2")
	// The row changes as changeMembers changes it; the note's command never arrives.
	r := e.runnerOf(s.ID)
	e.m.update(s.ID, true, func(rec *record) { rec.s = WithMember(rec.s, "r2", api.Path) })
	r.dirsStale.Store(true)
	e.m.noteFailed(r, "Added project api to this thread (checkout "+api.Path+")."+liveAddNote, context.DeadlineExceeded)
	e.waitArgv("the restart", func(a []string) bool { return slices.Contains(addDirs(a), api.Path) })
	e.waitItems(s.ID, "the queued notes and the restart's", func(items []Item) bool {
		return hasNote("Added project api to this thread")(items) &&
			hasNote("Could not restart Claude for the new project list: context deadline exceeded; it retries when idle")(items) && hasDirsRestartNote(items)
	})
}

// Removing a member of an archived thread is refused the same way.
func TestRemoveProjectArchived(t *testing.T) {
	e, _, _ := memberEnv(t)
	s := e.create(CreateOptions{ProjectID: "r1", ProjectIDs: []string{"r1", "r2"}})
	if _, err := e.m.Archive(e.ctx(), s.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.RemoveProject(e.ctx(), s.ID, "api"); !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "unarchive it first") {
		t.Fatalf("err = %v", err)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); !slices.Equal(got.ProjectIDs, []string{"r1", "r2"}) {
		t.Errorf("set changed: %v", got.ProjectIDs)
	}
}
