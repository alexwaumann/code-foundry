package thread

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// A thread's checkouts are the paths it records (the primary at its cwd), read from the
// project snapshot there: HEAD, detached, main, status, and for a worktree-mode one the
// branch it was made for and whether it moved. A member with none recorded is resolved by
// the creation rule: in worktree mode a git member's worktree on the branch (the default
// path when none is listed), a plain folder the folder; in checkout mode each member's
// own checkout.
func TestCheckoutsOf(t *testing.T) {
	dir := t.TempDir()
	mk := func(p string) string {
		p = filepath.Join(dir, p)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	webMain, webWT, apiMain, docs := mk("web"), mk("wt/web/feat-x"), mk("api"), mk("docs")
	apiOther := mk("elsewhere/api-feat-x")
	if err := os.WriteFile(filepath.Join(webWT, "CLAUDE.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	ahead := project.Status{Upstream: "origin/feat/y", Ahead: 2, Behind: 1, Operation: project.OpRebase, OperationStep: 1, OperationTotal: 3}
	snap := &project.Snapshot{Projects: []project.Project{
		{ID: "web", Name: "web", Path: webMain, Git: true, Worktrees: []project.Worktree{
			{ProjectID: "web", Path: webMain, IsMain: true, Branch: "main", Head: "m1"},
			{ProjectID: "web", Path: webWT, Branch: "feat/x", Head: "w1"},
		}},
		{ID: "api", Name: "api", Path: apiMain, Git: true, Worktrees: []project.Worktree{
			{ProjectID: "api", Path: apiMain, IsMain: true, Branch: "dev", Head: "a1"},
		}},
		{ID: "docs", Name: "docs", Path: docs, Worktrees: []project.Worktree{{ProjectID: "docs", Path: docs, IsMain: true}}},
	}}
	pathFor := func(id, branch string) string { return filepath.Join(dir, "wt", id, "feat-x") }
	with := func(i int, wts ...project.Worktree) *project.Snapshot {
		out := &project.Snapshot{Projects: slices.Clone(snap.Projects)}
		out.Projects[i].Worktrees = wts
		return out
	}
	withAPIElsewhere := with(1, snap.Projects[1].Worktrees[0], project.Worktree{ProjectID: "api", Path: apiOther, Branch: "feat/x", Head: "a2"})
	apiTwo := with(1, snap.Projects[1].Worktrees[0], project.Worktree{ProjectID: "api", Path: filepath.Join(dir, "wt/api/feat-x"), Branch: "feat/x", Head: "a4"},
		project.Worktree{ProjectID: "api", Path: apiOther, Branch: "feat/z", Head: "a2"})
	withAPIMainOnBranch := with(1, project.Worktree{ProjectID: "api", Path: apiMain, IsMain: true, Branch: "feat/x", Head: "a1"})
	// git switch in both worktrees: web's to another branch, api's (by hand, elsewhere) to
	// feat/y mid-rebase.
	moved := with(0, snap.Projects[0].Worktrees[0], project.Worktree{ProjectID: "web", Path: webWT, Branch: "other", Head: "w2"})
	moved.Projects[1].Worktrees = []project.Worktree{snap.Projects[1].Worktrees[0], {ProjectID: "api", Path: apiOther, Branch: "feat/y", Head: "a3", Status: ahead}}
	detached := with(0, snap.Projects[0].Worktrees[0], project.Worktree{ProjectID: "web", Path: webWT, Detached: true, Head: "w3"})
	// The user switched the main checkout of an in-place thread.
	switched := with(0, project.Worktree{ProjectID: "web", Path: webMain, IsMain: true, Branch: "hotfix", Head: "m2"}, snap.Projects[0].Worktrees[1])

	webPrimary := func(c Checkout) Checkout {
		c.ProjectID, c.ProjectName, c.Path, c.Primary, c.Git, c.Registered, c.Recorded = "web", "web", webWT, true, true, true, true
		c.Instructions = filepath.Join(webWT, "CLAUDE.md")
		return c
	}
	wtThread := Thread{ProjectID: "web", ProjectIDs: []string{"api", "docs", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"}
	tests := []struct {
		name string
		t    Thread
		snap *project.Snapshot
		want []Checkout
	}{
		{name: "nothing recorded, worktree mode: resolved worktrees, a missing one at the default path, a folder as itself",
			t: wtThread,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: filepath.Join(dir, "wt/api/feat-x"), Git: true, Registered: true, WorktreeMode: true, CreatedBranch: "feat/x", Missing: true},
				{ProjectID: "docs", ProjectName: "docs", Path: docs, Registered: true, Listed: true, Main: true},
				webPrimary(Checkout{Listed: true, Branch: "feat/x", Head: "w1", WorktreeMode: true, CreatedBranch: "feat/x"}),
			}},
		{name: "nothing recorded, worktree mode: a worktree on the branch elsewhere is the member's",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"},
			snap: withAPIElsewhere,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiOther, Listed: true, Branch: "feat/x", Head: "a2", Git: true, Registered: true, WorktreeMode: true, CreatedBranch: "feat/x"},
				webPrimary(Checkout{Listed: true, Branch: "feat/x", Head: "w1", WorktreeMode: true, CreatedBranch: "feat/x"}),
			}},
		// Fuzz finding A7: the user may switch the main checkout to another branch.
		{name: "nothing recorded, worktree mode: a main checkout on the branch is never the member's",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"},
			snap: withAPIMainOnBranch,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: filepath.Join(dir, "wt/api/feat-x"), Git: true, Registered: true, WorktreeMode: true, CreatedBranch: "feat/x", Missing: true},
				webPrimary(Checkout{Listed: true, Branch: "feat/x", Head: "w1", WorktreeMode: true, CreatedBranch: "feat/x"}),
			}},
		{name: "nothing recorded, checkout mode: each member's own checkout",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webMain},
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiMain, Listed: true, Main: true, Branch: "dev", Head: "a1", Git: true, Registered: true},
				{ProjectID: "web", ProjectName: "web", Path: webMain, Recorded: true, Listed: true, Main: true, Branch: "main", Head: "m1", Primary: true, Git: true, Registered: true},
			}},
		{name: "recorded: the branches moved; still the thread's checkouts, with HEAD, status and the branch they were made for",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x", CheckoutPaths: map[string]string{"api": apiOther, "web": webWT}},
			snap: moved,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiOther, Recorded: true, Listed: true, Branch: "feat/y", Head: "a3", Status: ahead, Git: true, Registered: true,
					WorktreeMode: true, CreatedBranch: "feat/x", Moved: true},
				webPrimary(Checkout{Listed: true, Branch: "other", Head: "w2", WorktreeMode: true, CreatedBranch: "feat/x", Moved: true}),
			}},
		{name: "recorded: detached HEAD has moved",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x", CheckoutPaths: map[string]string{"web": webWT}},
			snap: detached,
			want: []Checkout{webPrimary(Checkout{Listed: true, Detached: true, Head: "w3", WorktreeMode: true, CreatedBranch: "feat/x", Moved: true})},
		},
		{name: "recorded: a recorded path wins over the branch's worktree at the default path",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x", CheckoutPaths: map[string]string{"api": apiOther}},
			snap: apiTwo,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiOther, Recorded: true, Listed: true, Branch: "feat/z", Head: "a2", Git: true, Registered: true, WorktreeMode: true, CreatedBranch: "feat/x", Moved: true},
				webPrimary(Checkout{Listed: true, Branch: "feat/x", Head: "w1", WorktreeMode: true, CreatedBranch: "feat/x"}),
			}},
		{name: "recorded empty: resolved, as a member with nothing recorded",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x", CheckoutPaths: map[string]string{"api": "", "web": webWT}},
			snap: withAPIElsewhere,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiOther, Listed: true, Branch: "feat/x", Head: "a2", Git: true, Registered: true, WorktreeMode: true, CreatedBranch: "feat/x"},
				webPrimary(Checkout{Listed: true, Branch: "feat/x", Head: "w1", WorktreeMode: true, CreatedBranch: "feat/x"}),
			}},
		{name: "in place: the main checkout whatever it has checked out, never moved",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"web"}, WorktreePath: webMain, CheckoutPaths: map[string]string{"web": webMain}},
			snap: switched,
			want: []Checkout{{ProjectID: "web", ProjectName: "web", Path: webMain, Recorded: true, Listed: true, Main: true, Branch: "hotfix", Head: "m2", Primary: true, Git: true, Registered: true}},
		},
		{name: "a project no longer registered: its recorded path is kept",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"gone", "web"}, WorktreePath: webMain, CheckoutPaths: map[string]string{"gone": filepath.Join(dir, "gone"), "web": webMain}},
			want: []Checkout{
				{ProjectID: "gone", Path: filepath.Join(dir, "gone"), Recorded: true, Missing: true},
				{ProjectID: "web", ProjectName: "web", Path: webMain, Recorded: true, Listed: true, Main: true, Branch: "main", Head: "m1", Primary: true, Git: true, Registered: true},
			}},
		{name: "a project no longer registered, nothing recorded",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"gone", "web"}, WorktreePath: webMain},
			want: []Checkout{
				{ProjectID: "gone", Missing: true},
				{ProjectID: "web", ProjectName: "web", Path: webMain, Recorded: true, Listed: true, Main: true, Branch: "main", Head: "m1", Primary: true, Git: true, Registered: true},
			}},
		{name: "a row from before the set has its project", t: Thread{ProjectID: "web", WorktreePath: webMain},
			want: []Checkout{{ProjectID: "web", ProjectName: "web", Path: webMain, Recorded: true, Listed: true, Main: true, Branch: "main", Head: "m1", Primary: true, Git: true, Registered: true}}},
		{name: "no project, no checkouts", t: Thread{WorktreePath: dir}, want: []Checkout{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := tt.snap
			if s == nil {
				s = snap
			}
			got := CheckoutsOf(tt.t, s, pathFor, isDir)
			if !slices.Equal(got, tt.want) {
				t.Errorf("checkouts\n got %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

// The fill of a row from before migration 0049 records the derivation it replaces: a
// missing worktree gets "", a project that has not listed its worktrees waits (unless
// forced), an unregistered one gets "".
func TestFillPaths(t *testing.T) {
	dir := t.TempDir()
	mk := func(p string) string {
		p = filepath.Join(dir, p)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	webMain, webWT, apiMain, apiWT, docs := mk("web"), mk("wt/web/feat-x"), mk("api"), mk("wt/api/feat-x"), mk("docs")
	pathFor := func(id, branch string) string { return filepath.Join(dir, "wt", id, "feat-x") }
	listed := &project.Snapshot{Projects: []project.Project{
		{ID: "web", Name: "web", Path: webMain, Git: true, Worktrees: []project.Worktree{{Path: webMain, IsMain: true, Branch: "main"}, {Path: webWT, Branch: "feat/x"}}},
		{ID: "api", Name: "api", Path: apiMain, Git: true, Worktrees: []project.Worktree{{Path: apiMain, IsMain: true, Branch: "dev"}, {Path: apiWT, Branch: "moved"}}},
		{ID: "docs", Name: "docs", Path: docs, Worktrees: []project.Worktree{{Path: docs, IsMain: true}}},
	}}
	apiMissing := &project.Snapshot{Projects: slices.Clone(listed.Projects)}
	apiMissing.Projects[1].Worktrees = listed.Projects[1].Worktrees[:1]
	notListed := &project.Snapshot{Projects: slices.Clone(listed.Projects)}
	notListed.Projects[1].Worktrees = nil
	wt := Thread{ProjectID: "web", ProjectIDs: []string{"api", "docs", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"}
	tests := []struct {
		name    string
		t       Thread
		snap    *project.Snapshot
		exists  func(string) bool
		force   bool
		want    map[string]string
		decided bool
	}{
		{"worktree mode: the worktree at the default path, even moved; the folder", wt, listed, isDir, false,
			map[string]string{"api": apiWT, "docs": docs, "web": webWT}, true},
		{"worktree mode: a missing worktree is empty", wt, apiMissing, func(p string) bool { return p != apiWT && isDir(p) }, false,
			map[string]string{"api": "", "docs": docs, "web": webWT}, true},
		{"a project that has not listed its worktrees waits", wt, notListed, isDir, false, nil, false},
		{"past the wait it is empty", wt, notListed, isDir, true, map[string]string{"api": "", "docs": docs, "web": webWT}, true},
		{"checkout mode: the main checkouts", Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT}, listed, isDir, false,
			map[string]string{"api": apiMain, "web": webWT}, true},
		{"an unregistered member is empty; a missing primary keeps its path", Thread{ProjectID: "web", ProjectIDs: []string{"gone", "web"}, WorktreePath: "/nope"}, listed, isDir, false,
			map[string]string{"gone": "", "web": "/nope"}, true},
		{"no projects", Thread{WorktreePath: dir}, listed, isDir, false, map[string]string{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, decided := fillPaths(tt.t, tt.snap, pathFor, tt.exists, tt.force)
			if decided != tt.decided || !maps.Equal(got, tt.want) {
				t.Errorf("fillPaths = %v, %v; want %v, %v", got, decided, tt.want, tt.decided)
			}
		})
	}
}

// Moving the cwd keeps the checkout it leaves recorded and records the one it moves to.
func TestMovedTo(t *testing.T) {
	tests := []struct {
		name             string
		t                Thread
		project, path    string
		want             map[string]string
		wantPrimary      string
		wantWorktreePath string
	}{
		{"to another member", Thread{ProjectID: "web", WorktreePath: "/u/web-wt", CheckoutPaths: map[string]string{"api": "/api", "web": "/u/web-wt"}},
			"api", "/api", map[string]string{"api": "/api", "web": "/u/web-wt"}, "api", "/api"},
		{"a row with nothing recorded records both", Thread{ProjectID: "web", WorktreePath: "/u/web-wt"},
			"api", "/api", map[string]string{"api": "/api", "web": "/u/web-wt"}, "api", "/api"},
		{"to the workspace's folder", Thread{ProjectID: "web", WorktreePath: "/w", CheckoutPaths: map[string]string{"web": "/w"}},
			"", "/ws", map[string]string{"web": "/w"}, "", "/ws"},
		{"from the workspace's folder", Thread{WorktreePath: "/ws", CheckoutPaths: map[string]string{"web": "/w"}},
			"web", "/w", map[string]string{"web": "/w"}, "web", "/w"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := maps.Clone(tt.t.CheckoutPaths)
			got := tt.t.movedTo(tt.project, tt.path)
			if !maps.Equal(got.CheckoutPaths, tt.want) || got.ProjectID != tt.wantPrimary || got.WorktreePath != tt.wantWorktreePath {
				t.Errorf("movedTo = %v %q %q; want %v %q %q", got.CheckoutPaths, got.ProjectID, got.WorktreePath, tt.want, tt.wantPrimary, tt.wantWorktreePath)
			}
			if !maps.Equal(tt.t.CheckoutPaths, before) {
				t.Errorf("movedTo changed the original's paths: %v", tt.t.CheckoutPaths)
			}
		})
	}
}

func TestCleanProjectIDs(t *testing.T) {
	tests := []struct {
		primary string
		ids     []string
		want    []string
	}{
		{"", nil, nil},
		{"web", nil, []string{"web"}},
		{"web", []string{"api", " web", "api", ""}, []string{"api", "web"}},
		{"", []string{"b", "a"}, []string{"a", "b"}},
	}
	for _, tt := range tests {
		if got := CleanProjectIDs(tt.primary, tt.ids); !slices.Equal(got, tt.want) {
			t.Errorf("CleanProjectIDs(%q, %q) = %q, want %q", tt.primary, tt.ids, got, tt.want)
		}
	}
}

// Collision is the same checkout path: a moved worktree is still its thread's, another
// worktree on the thread's branch is not; archived threads and the thread itself hold
// nothing. A row with nothing recorded resolves by its branch until it is filled.
func TestHolderOf(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a"), filepath.Join(dir, "b")
	snap := &project.Snapshot{Projects: []project.Project{{ID: "r1", Name: "repo", Path: dir, Git: true, Worktrees: []project.Worktree{
		{ProjectID: "r1", Path: dir, IsMain: true, Branch: "main"},
		{ProjectID: "r1", Path: a, Branch: "other"}, // was feat/x: git switch
		{ProjectID: "r1", Path: b, Branch: "feat/x"},
	}}}}
	pathFor := func(string, string) string { return filepath.Join(dir, "default") }
	cos := func(t Thread) []Checkout { return CheckoutsOf(t, snap, pathFor, func(string) bool { return true }) }
	member := func(id string, rec map[string]string) Thread {
		return Thread{ID: id, ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, WorktreePath: "/r2/" + id, CreatedWorktree: true, Branch: "feat/x", CheckoutPaths: rec}
	}
	moved := member("moved", map[string]string{"r1": a})
	inB := Thread{ID: "in-b", ProjectID: "r1", WorktreePath: b, CheckoutPaths: map[string]string{"r1": b}}
	archived := member("archived", map[string]string{"r1": a})
	archived.ArchivedAt = time.Unix(1, 0)
	legacy := member("legacy", nil)
	tests := []struct {
		name     string
		threads  []Thread
		self     string
		path     string
		wantFrom string // "" when nobody holds it
	}{
		{"a moved worktree is still its thread's", []Thread{moved}, "x", a, "moved"},
		{"another worktree on the thread's branch is not", []Thread{moved}, "x", b, ""},
		{"the thread at the path", []Thread{moved, inB}, "x", b, "in-b"},
		{"the thread itself does not count", []Thread{moved}, "moved", a, ""},
		{"archived threads hold nothing", []Thread{archived}, "x", a, ""},
		{"nothing recorded: resolved by the branch until filled", []Thread{legacy}, "x", b, "legacy"},
		{"a primary's cwd", []Thread{moved}, "x", "/r2/moved", "moved"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := holderOf(tt.threads, tt.self, tt.path, cos)
			if ok != (tt.wantFrom != "") || got.ID != tt.wantFrom {
				t.Errorf("holderOf = %q, %v; want %q", got.ID, ok, tt.wantFrom)
			}
		})
	}
}

// A thread placed like another shares its checkouts when it keeps its mode and branch:
// each one on disk, of a registered project in the new set.
func TestSharedCheckouts(t *testing.T) {
	src := Thread{ID: "src", ProjectID: "web", ProjectIDs: []string{"api", "docs", "web"}, WorktreePath: "/wt/web", CreatedWorktree: true, Branch: "feat/x"}
	cos := []Checkout{
		{ProjectID: "api", Path: "/wt/api-moved", Registered: true},
		{ProjectID: "docs", Path: "/docs", Registered: true},
		{ProjectID: "web", Path: "/wt/web", Registered: true, Primary: true},
	}
	missing := slices.Clone(cos)
	missing[0].Missing = true
	gone := slices.Clone(cos)
	gone[1].Registered = false
	inPlace := Thread{ID: "src", ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: "/u/web-mine"}
	inPlaceCos := []Checkout{{ProjectID: "api", Path: "/api", Registered: true}, {ProjectID: "web", Path: "/u/web-mine", Registered: true, Primary: true}}
	all := []string{"api", "docs", "web"}
	tests := []struct {
		name string
		src  Thread
		pl   placement
		cos  []Checkout
		want map[string]string
	}{
		{"same mode and branch: every checkout", src, placement{projectIDs: all, worktreeMode: true, branch: "feat/x"}, cos,
			map[string]string{"api": "/wt/api-moved", "docs": "/docs", "web": "/wt/web"}},
		{"a narrowed set: its members only", src, placement{projectIDs: []string{"api"}, worktreeMode: true, branch: "feat/x"}, cos,
			map[string]string{"api": "/wt/api-moved"}},
		{"a missing worktree is made, not shared", src, placement{projectIDs: all, worktreeMode: true, branch: "feat/x"}, missing,
			map[string]string{"docs": "/docs", "web": "/wt/web"}},
		{"an unregistered project is not shared", src, placement{projectIDs: all, worktreeMode: true, branch: "feat/x"}, gone,
			map[string]string{"api": "/wt/api-moved", "web": "/wt/web"}},
		{"a new branch shares nothing", src, placement{projectIDs: all, worktreeMode: true, newBranch: true}, cos, nil},
		{"checkout mode from worktree mode shares nothing", src, placement{projectIDs: all}, cos, nil},
		{"in place: the same checkouts, a user's worktree included", inPlace, placement{projectIDs: []string{"api", "web"}}, inPlaceCos,
			map[string]string{"api": "/api", "web": "/u/web-mine"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sharedCheckouts(tt.src, tt.pl, tt.cos); !maps.Equal(got, tt.want) {
				t.Errorf("sharedCheckouts = %v, want %v", got, tt.want)
			}
		})
	}
}
