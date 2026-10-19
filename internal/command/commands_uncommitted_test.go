package command_test

import (
	"context"
	"errors"
	"maps"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// uncommittedErr is a backend's refusal of a dirty worktree: FailedPrecondition with an
// UncommittedWork detail.
func uncommittedErr(wts ...*v1.Worktree) error {
	err := connect.NewError(connect.CodeFailedPrecondition, errors.New("uncommitted changes; commit them or remove with --force"))
	d, derr := connect.NewErrorDetail(&v1.UncommittedWork{Worktrees: wts})
	if derr != nil {
		panic(derr)
	}
	err.AddDetail(d)
	return err
}

// TestRemovalsAskBeforeDeletingUncommittedWork: the three removals that refuse a dirty
// worktree ask their own question first, then (confirmed) a second one naming the work
// and its counts with args force=true; invoked again with force they remove it. Without
// that second yes nothing is forced.
func TestRemovalsAskBeforeDeletingUncommittedWork(t *testing.T) {
	dirtyStatus := project.Status{Dirty: true, Modified: 2, Untracked: 1}
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		setup   func(t *testing.T) (*command.Registry, func() []string)
		first   string
		message []string // in the second-stage prompt
	}{
		{
			name: "project.worktree.remove", cmd: "project.worktree.remove", args: map[string]string{"path": "/wt/app-fix"},
			setup: func(t *testing.T) (*command.Registry, func() []string) {
				p := &commandtest.Project{
					Projects: []*v1.Project{{Id: "r1", Name: "app", Path: "/src/app", Git: true, Worktrees: []*v1.Worktree{{Path: "/src/app"}, {Path: "/wt/app-fix", Branch: "cf/fix"}}}},
					OnRemoveWorktree: func(r *v1.RemoveWorktreeRequest) error {
						if r.GetForce() {
							return nil
						}
						return uncommittedErr(&v1.Worktree{ProjectId: "r1", Path: "/wt/app-fix", Branch: "cf/fix", Status: &v1.GitStatus{Dirty: true, Modified: 2, Untracked: 1}})
					},
				}
				reg := command.NewRegistry()
				if err := command.RegisterProject(reg, p, nil); err != nil {
					t.Fatal(err)
				}
				return reg, func() []string {
					var calls []string
					for _, m := range p.Requests() {
						if r, ok := m.(*v1.RemoveWorktreeRequest); ok {
							calls = append(calls, "remove force="+map[bool]string{true: "true", false: "false"}[r.GetForce()])
						}
					}
					return calls
				}
			},
			first:   "Remove worktree /wt/app-fix? This deletes files on disk.",
			message: []string{"The worktree of cf/fix at /wt/app-fix has uncommitted work: 2 modified, 1 untracked.", "Removing the worktree deletes that work for good."},
		},
		{
			name: "workspace.remove-project", cmd: "workspace.remove-project", args: map[string]string{"project": "web", "workspace": "base"},
			setup: func(t *testing.T) (*command.Registry, func() []string) {
				reg, fake := newWorkspaceRegistry(t)
				if _, err := fake.Create(context.Background(), wsCreate("base", "web", "api")); err != nil {
					t.Fatal(err)
				}
				fake.Uncommitted = []project.Worktree{{ProjectID: "web", Path: "/worktrees/web/cf-login", Branch: "cf/login", Status: dirtyStatus}}
				return reg, func() []string { return fake.Calls()[1:] }
			},
			first:   "Remove project web from its workspace? This deletes its worktree from disk.",
			message: []string{"The worktree of cf/login at /worktrees/web/cf-login has uncommitted work: 2 modified, 1 untracked."},
		},
		{
			name: "workspace.remove, two dirty members", cmd: "workspace.remove", args: map[string]string{"workspace": "base"},
			setup: func(t *testing.T) (*command.Registry, func() []string) {
				reg, fake := newWorkspaceRegistry(t)
				if _, err := fake.Create(context.Background(), wsCreate("base", "web", "api")); err != nil {
					t.Fatal(err)
				}
				fake.Uncommitted = []project.Worktree{
					{ProjectID: "web", Path: "/worktrees/web/cf-login", Branch: "cf/login", Status: dirtyStatus},
					{ProjectID: "api", Path: "/worktrees/api/cf-login", Branch: "cf/login", Status: project.Status{Dirty: true, Staged: 1, Conflicted: 1}},
				}
				return reg, func() []string { return fake.Calls()[1:] }
			},
			first: "Remove workspace base? This deletes every member worktree from disk.",
			message: []string{"2 worktrees have uncommitted work:\n- cf/login at /worktrees/web/cf-login: 2 modified, 1 untracked\n" +
				"- cf/login at /worktrees/api/cf-login: 1 staged, 1 conflicted", "Removing the workspace's worktrees deletes that work for good."},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, calls := tt.setup(t)
			ctx := context.Background()
			// Stage 1: the command's own question; nothing is called.
			_, err := reg.Invoke(ctx, command.Context{}, tt.cmd, tt.args)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || ce.Message != tt.first || ce.Args != nil {
				t.Fatalf("first: err = %v, want %q without args", err, tt.first)
			}
			// Stage 2: confirmed, the backend refuses for the uncommitted work.
			_, err = reg.Invoke(ctx, command.Context{}, tt.cmd, tt.args, command.Confirmed(true))
			if !errors.As(err, &ce) {
				t.Fatalf("second: err = %v, want a confirmation", err)
			}
			if ce.Command != tt.cmd || ce.Title != "Delete Uncommitted Work" || !maps.Equal(ce.Args, map[string]string{"force": "true"}) || ce.Declined != nil {
				t.Errorf("second = %+v", ce)
			}
			for _, m := range tt.message {
				if !strings.Contains(ce.Message, m) {
					t.Errorf("second prompt = %q\nwant it to contain %q", ce.Message, m)
				}
			}
			// The user agreed: the args are merged in and it removes.
			args := maps.Clone(tt.args)
			maps.Copy(args, ce.Args)
			if _, err := reg.Invoke(ctx, command.Context{}, tt.cmd, args, command.Confirmed(true)); err != nil {
				t.Fatalf("forced: %v", err)
			}
			got := calls()
			if len(got) != 2 || strings.Contains(got[0], "force=true") || !strings.Contains(got[1], "force") || strings.Contains(got[1], "force=false") {
				t.Errorf("backend calls = %q, want one without force, then one with", got)
			}
		})
	}
}

// Another refusal (a live thread) stays an error, not a question.
func TestRemovalOtherRefusalStaysAnError(t *testing.T) {
	p := &commandtest.Project{
		Projects: []*v1.Project{{Id: "r1", Name: "app", Path: "/src/app", Git: true, Worktrees: []*v1.Worktree{{Path: "/src/app"}, {Path: "/wt/x"}}}},
		OnRemoveWorktree: func(*v1.RemoveWorktreeRequest) error {
			return connect.NewError(connect.CodeFailedPrecondition, errors.New("worktree is locked"))
		},
	}
	reg := command.NewRegistry()
	if err := command.RegisterProject(reg, p, nil); err != nil {
		t.Fatal(err)
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "project.worktree.remove", map[string]string{"path": "/wt/x"}, command.Confirmed(true))
	var ce *command.ConfirmError
	if err == nil || errors.As(err, &ce) || !strings.Contains(err.Error(), "locked") {
		t.Fatalf("err = %v, want the refusal as is", err)
	}
}

// project.worktree.cleanup: the dry run lists a dirty, otherwise merged worktree as
// removable if its work is deleted; the run removes the clean ones and asks, naming the
// dirty one with counts, with force=true and the run's result as what declining keeps;
// the forced run asks the daemon with force.
func TestProjectCleanupAsksAboutUncommittedWork(t *testing.T) {
	a := cleanWt("cf/a", "/wt/a")
	d := &v1.Worktree{ProjectId: "r1", Branch: "cf/d", Path: "/wt/d", Status: &v1.GitStatus{BaseRef: "origin/main", Dirty: true, Modified: 2, Untracked: 1}}
	u := &v1.Worktree{ProjectId: "r1", Branch: "cf/u", Path: "/wt/u", Status: &v1.GitStatus{Dirty: true, Modified: 1}}
	res := &v1.CleanupWorktreesResponse{
		ProjectId: "r1",
		Removed:   []*v1.RemovedWorktree{{Worktree: a, Reason: inMain}},
		Skipped: []*v1.SkippedWorktree{
			{Worktree: d, Reason: "uncommitted changes", Uncommitted: true},
			{Worktree: u, Reason: "uncommitted changes"},
		},
	}
	reg, _, project, _ := cleanupFixture(t, res, res)
	ctx := context.Background()
	args := map[string]string{"project": "proj"}

	_, err := reg.Invoke(ctx, command.Context{}, "project.worktree.cleanup", args)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("first: %v", err)
	}
	wantFirst := "Fetch, then remove 1 worktree (branches are kept; each is checked again after the fetch):\n" +
		"- cf/a at /wt/a: branch is in origin/main\n" +
		"Also removable if their uncommitted work is deleted (you are asked again first):\n" +
		"- cf/d at /wt/d: 2 modified, 1 untracked\n" +
		"Keep 1:\n" +
		"- cf/u at /wt/u: uncommitted changes"
	if ce.Message != wantFirst || ce.Args != nil {
		t.Errorf("first prompt = %q\nwant         %q", ce.Message, wantFirst)
	}

	_, err = reg.Invoke(ctx, command.Context{}, "project.worktree.cleanup", args, command.Confirmed(true))
	if !errors.As(err, &ce) {
		t.Fatalf("second: %v", err)
	}
	wantSecond := "Removed 1 worktree: cf/a.\n\n" +
		"The work of 1 more worktree is in the default branch, but it has uncommitted work:\n" +
		"- cf/d at /wt/d: 2 modified, 1 untracked\n\n" +
		"Remove them too and delete that work for good? Branches are kept."
	if ce.Message != wantSecond || !maps.Equal(ce.Args, map[string]string{"force": "true"}) || ce.Title != "Delete Uncommitted Work" {
		t.Errorf("second = %+v\nwant message %q", ce, wantSecond)
	}
	if ce.Declined == nil || ce.Declined.Message != "Removed 1 worktree: cf/a (branch is in origin/main); kept 2 worktrees: cf/d (uncommitted changes), cf/u (uncommitted changes)" {
		t.Errorf("declined = %+v", ce.Declined)
	}

	project.OnCleanup = func(req *v1.CleanupWorktreesRequest) (*v1.CleanupWorktreesResponse, error) {
		if !req.GetForce() {
			t.Errorf("forced run asked without force: %v", req)
		}
		return &v1.CleanupWorktreesResponse{ProjectId: "r1",
			Removed: []*v1.RemovedWorktree{{Worktree: d, Reason: inMain, Uncommitted: true}},
			Skipped: []*v1.SkippedWorktree{{Worktree: u, Reason: "uncommitted changes"}}}, nil
	}
	args["force"] = "true"
	out, err := reg.Invoke(ctx, command.Context{}, "project.worktree.cleanup", args, command.Confirmed(true))
	if err != nil {
		t.Fatal(err)
	}
	if want := "Removed 1 worktree: cf/d (branch is in origin/main; uncommitted changes deleted); kept 1 worktree: cf/u (uncommitted changes)"; out.Message != want {
		t.Errorf("forced message = %q\nwant %q", out.Message, want)
	}
}

// One path: the dry run says it is asked again; the second stage names it alone.
func TestProjectCleanupOnePathAsksAboutUncommittedWork(t *testing.T) {
	d := &v1.Worktree{ProjectId: "r1", Branch: "cf/d", Path: "/wt/d", Status: &v1.GitStatus{Dirty: true, Staged: 3}}
	res := &v1.CleanupWorktreesResponse{ProjectId: "r1", Skipped: []*v1.SkippedWorktree{{Worktree: d, Reason: "uncommitted changes", Uncommitted: true}}}
	reg, _, _, _ := cleanupFixture(t, res, res)
	args := map[string]string{"project": "proj", "path": "/wt/d"}
	_, err := reg.Invoke(context.Background(), command.Context{}, "project.worktree.cleanup", args)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || ce.Message != "Fetch and check the worktree of cf/d at /wt/d again? Its work is otherwise removable, but it has uncommitted work (3 staged); you are asked again before that is deleted." {
		t.Fatalf("first = %v", err)
	}
	_, err = reg.Invoke(context.Background(), command.Context{}, "project.worktree.cleanup", args, command.Confirmed(true))
	want := "The work of cf/d at /wt/d is in the default branch, but the worktree has uncommitted work: 3 staged.\n\n" +
		"Remove the worktree and delete that work for good? The branch is kept."
	if !errors.As(err, &ce) || ce.Message != want || ce.Declined == nil || ce.Declined.Message != "Nothing removed; kept 1 worktree: cf/d (uncommitted changes)" {
		t.Fatalf("second = %v (%+v)", err, ce)
	}
}
