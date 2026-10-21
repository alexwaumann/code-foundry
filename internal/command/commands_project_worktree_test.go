package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// project.worktree.remove takes its project from the worktree's path when --project is
// left out (W4 finding 2: inside a thread it was "not available in this context"), and
// says which flag is missing when it cannot.
func TestProjectWorktreeRemoveProject(t *testing.T) {
	projects := []*v1.Project{
		{Id: "r1", Name: "app", Path: "/src/app", Git: true, Worktrees: []*v1.Worktree{{Path: "/src/app"}, {Path: "/wt/app-fix", Branch: "cf/fix"}}},
		{Id: "r2", Name: "lib", Path: "/src/lib", Git: true, Worktrees: []*v1.Worktree{{Path: "/src/lib"}, {Path: "/wt/lib-fix"}}},
	}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		wantReq *v1.RemoveWorktreeRequest
		wantErr error
		wantMsg string // in the error
	}{
		{name: "the path names the project", args: map[string]string{"path": "/wt/lib-fix", "delete-branch": "true"},
			wantReq: &v1.RemoveWorktreeRequest{ProjectId: "r2", Path: "/wt/lib-fix", DeleteBranch: true}},
		{name: "inside a thread, the context thread does not matter", ctx: command.Context{ActiveThreadID: "s-1"},
			args: map[string]string{"path": "/wt/app-fix"}, wantReq: &v1.RemoveWorktreeRequest{ProjectId: "r1", Path: "/wt/app-fix"}},
		{name: "an explicit project is used as given", args: map[string]string{"project": "r9", "path": "/wt/app-fix"},
			wantReq: &v1.RemoveWorktreeRequest{ProjectId: "r9", Path: "/wt/app-fix"}},
		{name: "a path no project has", args: map[string]string{"path": "/elsewhere"}, wantErr: command.ErrInvalidArgs,
			wantMsg: "/elsewhere is not a worktree of a registered project; give its project with --project"},
		{name: "no path", ctx: command.Context{ActiveProjectID: "r1", ActiveView: "projects"}, wantErr: command.ErrUnavailable,
			wantMsg: "give the worktree with --path"},
		{name: "no path from the CLI", ctx: command.Context{ActiveProjectID: "r1"}, wantErr: command.ErrInvalidArgs,
			wantMsg: "missing --path (default: the active worktree; there is none)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			p := &commandtest.Project{Projects: projects}
			if err := command.RegisterProject(reg, p, nil); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "project.worktree.remove", tt.args, command.Confirmed(true))
			if !errors.Is(err, tt.wantErr) || (err != nil && !strings.Contains(err.Error(), tt.wantMsg)) {
				t.Fatalf("err = %v, want %v with %q", err, tt.wantErr, tt.wantMsg)
			}
			var got *v1.RemoveWorktreeRequest
			for _, r := range p.Requests() {
				if rr, ok := r.(*v1.RemoveWorktreeRequest); ok {
					got = rr
				}
			}
			if !proto.Equal(got, tt.wantReq) {
				t.Errorf("request = %v, want %v", got, tt.wantReq)
			}
		})
	}
}
