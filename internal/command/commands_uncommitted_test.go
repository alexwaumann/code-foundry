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

// TestRemovalsAskBeforeDeletingUncommittedWork: the removals that refuse a dirty
// worktree ask their own question first, then (confirmed) a second one naming the work
// and its counts with args force=true; invoked again with force they remove it. Without
// that second yes nothing is forced.
func TestRemovalsAskBeforeDeletingUncommittedWork(t *testing.T) {
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
