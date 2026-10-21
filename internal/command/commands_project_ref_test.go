package command_test

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// Every project arg takes an id, a unique name, or a path inside the project.
func TestProjectArgsTakeNamesAndPaths(t *testing.T) {
	projects := []*v1.Project{
		{Id: "135656834808", Name: "repo", Worktrees: []*v1.Worktree{{Path: "/src/repo"}}},
		{Id: "p2", Name: "twin"}, {Id: "p3", Name: "twin"},
	}
	tests := []struct {
		name    string
		cmd     string
		args    map[string]string
		wantErr error
		wantReq proto.Message
	}{
		{name: "a name", cmd: "project.worktree.new", args: map[string]string{"project": "repo", "branch": "fz1"},
			wantReq: &v1.CreateWorktreeRequest{ProjectId: "135656834808", Branch: "fz1", Fetch: true}},
		{name: "a path inside it", cmd: "project.refresh", args: map[string]string{"project": "/src/repo/sub"},
			wantReq: &v1.RefreshProjectRequest{Id: "135656834808"}},
		{name: "an id", cmd: "project.refresh", args: map[string]string{"project": "p2"}, wantReq: &v1.RefreshProjectRequest{Id: "p2"}},
		{name: "an ambiguous name", cmd: "project.refresh", args: map[string]string{"project": "twin"}, wantErr: command.ErrInvalidArgs},
		{name: "a path outside every project", cmd: "project.refresh", args: map[string]string{"project": "/elsewhere"}, wantErr: command.ErrInvalidArgs},
		// Anything else reaches the backend, which says it is not found.
		{name: "unknown passes through", cmd: "project.refresh", args: map[string]string{"project": "nope"}, wantReq: &v1.RefreshProjectRequest{Id: "nope"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Project{Projects: projects}
			if err := command.RegisterProject(reg, b, nil); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantReq == nil {
				return
			}
			reqs := b.Requests()
			if len(reqs) == 0 || !proto.Equal(reqs[len(reqs)-1], tt.wantReq) {
				t.Errorf("requests = %v, want last %v", reqs, tt.wantReq)
			}
		})
	}
}
