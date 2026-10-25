package thread

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// A thread's checkouts are derived: the primary at its cwd; in worktree mode a git
// member's worktree on the branch (the default path when none is listed), a plain folder
// the folder; in checkout mode each member's own checkout.
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
	snap := &project.Snapshot{Projects: []project.Project{
		{ID: "web", Name: "web", Path: webMain, Git: true, Worktrees: []project.Worktree{
			{ProjectID: "web", Path: webMain, IsMain: true, Branch: "main"},
			{ProjectID: "web", Path: webWT, Branch: "feat/x"},
		}},
		{ID: "api", Name: "api", Path: apiMain, Git: true, Worktrees: []project.Worktree{
			{ProjectID: "api", Path: apiMain, IsMain: true, Branch: "dev"},
		}},
		{ID: "docs", Name: "docs", Path: docs, Worktrees: []project.Worktree{{ProjectID: "docs", Path: docs, IsMain: true}}},
	}}
	pathFor := func(id, branch string) string { return filepath.Join(dir, "wt", id, "feat-x") }
	withAPIElsewhere := &project.Snapshot{Projects: slices.Clone(snap.Projects)}
	withAPIElsewhere.Projects[1].Worktrees = append(slices.Clone(snap.Projects[1].Worktrees), project.Worktree{ProjectID: "api", Path: apiOther, Branch: "feat/x"})

	tests := []struct {
		name string
		t    Thread
		snap *project.Snapshot
		want []Checkout
	}{
		{name: "worktree mode: derived worktrees, a missing one at the default path, a folder as itself",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"api", "docs", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"},
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: filepath.Join(dir, "wt/api/feat-x"), Branch: "feat/x", Git: true, Registered: true, Derived: true, Missing: true},
				{ProjectID: "docs", ProjectName: "docs", Path: docs, Registered: true},
				{ProjectID: "web", ProjectName: "web", Path: webWT, Branch: "feat/x", Primary: true, Git: true, Registered: true, Derived: true,
					Instructions: filepath.Join(webWT, "CLAUDE.md")},
			}},
		{name: "worktree mode: a worktree on the branch elsewhere is the member's",
			t:    Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webWT, CreatedWorktree: true, Branch: "feat/x"},
			snap: withAPIElsewhere,
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiOther, Branch: "feat/x", Git: true, Registered: true, Derived: true},
				{ProjectID: "web", ProjectName: "web", Path: webWT, Branch: "feat/x", Primary: true, Git: true, Registered: true, Derived: true,
					Instructions: filepath.Join(webWT, "CLAUDE.md")},
			}},
		{name: "checkout mode: each member's own checkout",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"api", "web"}, WorktreePath: webMain},
			want: []Checkout{
				{ProjectID: "api", ProjectName: "api", Path: apiMain, Branch: "dev", Git: true, Registered: true},
				{ProjectID: "web", ProjectName: "web", Path: webMain, Branch: "main", Primary: true, Git: true, Registered: true},
			}},
		{name: "a project no longer registered",
			t: Thread{ProjectID: "web", ProjectIDs: []string{"gone", "web"}, WorktreePath: webMain},
			want: []Checkout{
				{ProjectID: "gone", Missing: true},
				{ProjectID: "web", ProjectName: "web", Path: webMain, Branch: "main", Primary: true, Git: true, Registered: true},
			}},
		{name: "a row from before the set has its project", t: Thread{ProjectID: "web", WorktreePath: webMain},
			want: []Checkout{{ProjectID: "web", ProjectName: "web", Path: webMain, Branch: "main", Primary: true, Git: true, Registered: true}}},
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
