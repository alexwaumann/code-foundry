package command_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.move: the positional place is a project unless none answers to it (then a
// workspace), the placement flags map to the request as thread.new's do, and the
// message says where the thread runs now, or where it goes once its turn ends.
func TestThreadMove(t *testing.T) {
	queued := &v1.Thread{Name: "Fix login", State: v1.ThreadState_THREAD_STATE_CONNECTED,
		PendingMove: &v1.ThreadMove{ProjectId: "r-web", WorktreePath: "/w/web"}}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		current *v1.Thread
		wantReq *v1.MoveThreadRequest
		wantMsg string
		wantErr error
		// unknownProject: the daemon answers NOT_FOUND for the project; unknownWorkspace for
		// the workspace too.
		unknownProject, unknownWorkspace bool
	}{
		{name: "a project, default placement", ctx: command.Context{ActiveThreadID: "s-1"}, args: map[string]string{"to": "web"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web"},
			wantMsg: "moved thread s-1 to web, in /projects/r-web"},
		{name: "a new worktree from a base", args: map[string]string{"id": "s-1", "to": "web", "new-worktree": "true", "base": "develop"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web", NewWorktree: &v1.NewWorktree{BaseRef: "develop"}},
			wantMsg: "moved thread s-1 to web, in /worktrees/r-web (new worktree on cf/1 from develop)"},
		{name: "an existing branch", args: map[string]string{"id": "s-1", "to": "web", "new-worktree": "true", "branch": "feat/x"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web", NewWorktree: &v1.NewWorktree{Branch: "feat/x"}},
			wantMsg: "moved thread s-1 to web, in /worktrees/r-web (new worktree on existing branch feat/x)"},
		{name: "the project's folder", args: map[string]string{"id": "s-1", "to": "web", "new-worktree": "false"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web", CheckoutMode: true},
			wantMsg: "moved thread s-1 to web, in /projects/r-web"},
		{name: "an existing checkout", args: map[string]string{"id": "s-1", "to": "web", "worktree": "/w/web-2"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web", WorktreePath: "/w/web-2"},
			wantMsg: "moved thread s-1 to web, in /w/web-2"},
		{name: "not a project: a workspace", args: map[string]string{"id": "s-1", "to": "platform"}, unknownProject: true,
			wantReq: &v1.MoveThreadRequest{Id: "s-1", WorkspaceId: "platform"},
			wantMsg: "moved thread s-1 to workspace platform, in /projects/platform-1"},
		{name: "neither", args: map[string]string{"id": "s-1", "to": "nowhere"}, unknownProject: true, unknownWorkspace: true,
			wantErr: errors.New(`not_found: no project or workspace "nowhere" (code-foundry project list, workspace list)`)},
		{name: "a workspace and its primary", args: map[string]string{"id": "s-1", "workspace": "platform", "to": "workspace"},
			wantReq: &v1.MoveThreadRequest{Id: "s-1", WorkspaceId: "platform", ProjectId: "workspace"},
			wantMsg: "moved thread s-1 to workspace platform, in /projects/workspace"},
		{name: "mid-turn it is queued", args: map[string]string{"id": "s-1", "to": "web"}, current: queued,
			wantReq: &v1.MoveThreadRequest{Id: "s-1", ProjectId: "r-web"},
			wantMsg: "thread Fix login (s-1) moves to /w/web once its turn ends"},
		{name: "no place", args: map[string]string{"id": "s-1"}, wantErr: command.ErrInvalidArgs},
		{name: "the project twice", args: map[string]string{"id": "s-1", "to": "web", "project": "api"}, wantErr: command.ErrInvalidArgs},
		{name: "a branch needs new-worktree", args: map[string]string{"id": "s-1", "to": "web", "branch": "feat/x"}, wantErr: command.ErrInvalidArgs},
		{name: "a base needs new-worktree", args: map[string]string{"id": "s-1", "to": "web", "base": "main", "new-worktree": "false"}, wantErr: command.ErrInvalidArgs},
		{name: "no thread in the GUI", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"to": "web"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			reg.SetRefResolver(command.ProjectID, func(_ context.Context, _, ref string) (string, error) {
				if ref == "web" {
					return "r-web", nil
				}
				return ref, nil // as the registry's: an unknown ref goes as it is
			})
			b.MoveErr = func(req *v1.MoveThreadRequest) error {
				switch {
				case tt.unknownProject && req.GetProjectId() != "":
					return connect.NewError(connect.CodeNotFound, fmt.Errorf("project %s is not registered", req.GetProjectId()))
				case tt.unknownWorkspace && req.GetWorkspaceId() != "":
					return connect.NewError(connect.CodeNotFound, fmt.Errorf("workspace %s not found", req.GetWorkspaceId()))
				}
				return nil
			}
			reg.SetProjectNames(func(context.Context) (map[string]string, error) { return map[string]string{"r-web": "web"}, nil })
			if tt.current != nil {
				b.Current = proto.CloneOf(tt.current)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.move", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) && (err == nil || err.Error() != tt.wantErr.Error()) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if reqs := b.Requests(); len(reqs) == 0 || !proto.Equal(reqs[len(reqs)-1], tt.wantReq) {
				t.Errorf("requests = %v, want %v", reqs, tt.wantReq)
			}
		})
	}
}
