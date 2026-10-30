package thread

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

// CheckPlacement answers what a Create with the same projects, branch and mode would do,
// per project; each case then runs that Create and checks it did exactly that (the
// refusal's message, the shared checkout, the new worktree's path).
func TestCheckPlacement(t *testing.T) {
	type want struct {
		outcome PlacementOutcome
		path    string // "default" is DefaultWorktreePath(project, branch)
		branch  string
		message string // a substring of the refusal
	}
	tests := []struct {
		name string
		// setup prepares the projects and returns the paths the wants refer to by key.
		setup  func(t *testing.T, e *env, rr *recordingProjects) map[string]string
		cfg    *BranchNaming
		check  PlacementCheck
		branch string // the report's branch
		named  bool   // BranchNamedAtCreate
		want   map[string]want
		// noCreate skips the Create (one that would call the namer).
		noCreate bool
	}{
		{name: "a new branch: new worktrees at the default paths",
			check: PlacementCheck{ProjectIDs: []string{"api", "r1"}, Branch: "feat/new"}, branch: "feat/new",
			want: map[string]want{"r1": {outcome: PlacementNew, path: "default", branch: "feat/new"}, "r2": {outcome: PlacementNew, path: "default", branch: "feat/new"}}},
		{name: "a worktree on the branch is shared",
			setup: func(t *testing.T, _ *env, rr *recordingProjects) map[string]string {
				return map[string]string{"x": mkWorktree(t, rr, "r1", "feat/x")}
			},
			check: PlacementCheck{ProjectIDs: []string{"r1", "r2"}, Branch: "feat/x"}, branch: "feat/x",
			want: map[string]want{"r1": {outcome: PlacementShare, path: "x", branch: "feat/x"}, "r2": {outcome: PlacementNew, path: "default", branch: "feat/x"}}},
		{name: "the main checkout on the branch refuses",
			check: PlacementCheck{ProjectIDs: []string{"r2"}, Branch: "main"}, branch: "main",
			want: map[string]want{"r2": {outcome: PlacementRefused, message: "api's main checkout at "}}},
		{name: "a default-path worktree switched away refuses",
			setup: func(t *testing.T, e *env, rr *recordingProjects) map[string]string {
				s := e.create(CreateOptions{ProjectIDs: []string{"r1"}, NewWorktree: &NewWorktree{Branch: "feat/m"}})
				switchBranch(rr, "r1", s.WorktreePath, "other")
				return nil
			},
			check: PlacementCheck{ProjectIDs: []string{"r1"}, Branch: "feat/m"}, branch: "feat/m",
			want: map[string]want{"r1": {outcome: PlacementRefused, message: "has other checked out now"}}},
		{name: "checkout mode: each project's own checkout",
			check: PlacementCheck{ProjectIDs: []string{"r1", "api"}, CheckoutMode: true},
			want:  map[string]want{"r1": {outcome: PlacementShare, path: "r1-main"}, "r2": {outcome: PlacementShare, path: "r2-main", branch: "main"}}},
		{name: "no branch: the namer names it at the Create", noCreate: true,
			check: PlacementCheck{ProjectIDs: []string{"r1"}}, named: true,
			want: map[string]want{"r1": {outcome: PlacementNew}}},
		{name: "a slug in prefix mode is known before the Create",
			cfg:   &BranchNaming{Mode: BranchModePrefix, Prefix: "cf"},
			check: PlacementCheck{ProjectIDs: []string{"r1"}, Branch: "Login fix"}, branch: "cf/login-fix",
			want: map[string]want{"r1": {outcome: PlacementNew, path: "default", branch: "cf/login-fix"}}},
		{name: "a slug the namer wraps is named at the Create", noCreate: true,
			check: PlacementCheck{ProjectIDs: []string{"r1"}, Branch: "login"}, named: true,
			want: map[string]want{"r1": {outcome: PlacementNew}}},
		{name: "a plain folder beside a git project runs in its folder",
			setup: plainDocs,
			check: PlacementCheck{ProjectIDs: []string{"r1", "docs"}, Branch: "feat/d"}, branch: "feat/d",
			want: map[string]want{"r1": {outcome: PlacementNew, path: "default", branch: "feat/d"}, "docs": {outcome: PlacementFolder, path: "docs"}}},
		{name: "plain folders alone refuse a new worktree",
			setup: plainDocs,
			check: PlacementCheck{ProjectIDs: []string{"docs"}, Branch: "feat/d"}, branch: "",
			want: map[string]want{"docs": {outcome: PlacementRefused, message: "docs is not a git repository; threads run in its current checkout"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := multiEnv(t, func(o *Options) {
				o.Projects.(*recordingProjects).MakeDirs = true
				o.RefExists = func(_ context.Context, _, ref string) bool {
					return ref == "refs/heads/main" || ref == "refs/heads/feat/x" || ref == "refs/heads/feat/m"
				}
				if tt.cfg != nil {
					o.BranchNaming = func() BranchNaming { return *tt.cfg }
				}
			})
			keys := map[string]string{}
			for _, r := range rr.Snapshot().Projects {
				keys[r.ID+"-main"] = mainCheckout(r)
			}
			if tt.setup != nil {
				for k, v := range tt.setup(t, e, rr) {
					keys[k] = v
				}
			}
			rep, err := e.m.CheckPlacement(e.ctx(), tt.check)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Branch != tt.branch || rep.BranchNamedAtCreate != tt.named {
				t.Errorf("branch %q (named at create %v), want %q (%v)", rep.Branch, rep.BranchNamedAtCreate, tt.branch, tt.named)
			}
			if len(rep.Members) != len(tt.want) || !slices.IsSortedFunc(rep.Members, func(a, b MemberPlacement) int { return strings.Compare(a.ProjectID, b.ProjectID) }) {
				t.Fatalf("members %+v, want %d in id order", rep.Members, len(tt.want))
			}
			wantPath := func(id string, w want) string {
				switch w.path {
				case "":
					return ""
				case "default":
					return rr.DefaultWorktreePath(id, w.branch)
				}
				return keys[w.path]
			}
			for _, mp := range rep.Members {
				w := tt.want[mp.ProjectID]
				if mp.Outcome != w.outcome || mp.Path != wantPath(mp.ProjectID, w) || mp.Branch != w.branch ||
					(w.message == "") != (mp.Message == "") || !strings.Contains(mp.Message, w.message) {
					t.Errorf("%s: %+v, want %s at %q on %q, message %q", mp.ProjectID, mp, w.outcome, wantPath(mp.ProjectID, w), w.branch, w.message)
				}
			}
			if tt.noCreate {
				return
			}
			// The Create agrees.
			o := CreateOptions{ProjectIDs: tt.check.ProjectIDs, CheckoutMode: tt.check.CheckoutMode}
			if !tt.check.CheckoutMode {
				o.NewWorktree = &NewWorktree{Branch: tt.check.Branch}
			}
			s, err := e.m.Create(e.ctx(), o)
			for _, mp := range rep.Members {
				switch mp.Outcome {
				case PlacementRefused:
					if err == nil || !strings.Contains(err.Error(), mp.Message) {
						t.Errorf("Create err = %v, want the check's refusal %q", err, mp.Message)
					}
				default:
					if err != nil {
						t.Fatalf("Create err = %v, the check said %s", err, mp.Outcome)
					}
					if got := s.CheckoutPaths[mp.ProjectID]; !samePath(got, mp.Path) {
						t.Errorf("Create placed %s at %q, the check said %q", mp.ProjectID, got, mp.Path)
					}
				}
			}
		})
	}
}

// plainDocs registers "docs", a folder without git.
func plainDocs(t *testing.T, _ *env, rr *recordingProjects) map[string]string {
	dir := filepath.Join(t.TempDir(), "docs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rr.Put(project.Project{ID: "docs", Path: dir, Name: "docs", Worktrees: []project.Worktree{{ProjectID: "docs", Path: dir, IsMain: true}}})
	return map[string]string{"docs": dir}
}

func TestCheckPlacementInvalid(t *testing.T) {
	e, _ := multiEnv(t)
	for _, c := range []PlacementCheck{
		{},
		{ProjectIDs: []string{"nope"}},
		{ProjectIDs: []string{"r1", "repo"}},
		{ProjectIDs: []string{"r1"}, Branch: "-x/y"},
	} {
		if _, err := e.m.CheckPlacement(e.ctx(), c); err == nil {
			t.Errorf("CheckPlacement(%+v) = nil error", c)
		} else if !errors.Is(err, ErrInvalidArgument) && !errors.Is(err, ErrNotFound) {
			t.Errorf("CheckPlacement(%+v) err = %v, want invalid argument or not found", c, err)
		}
	}
}
