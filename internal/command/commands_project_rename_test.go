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

// project.rename resolves its project ref (the old name works) before the daemon
// checks the new name.
func TestProjectRename(t *testing.T) {
	projects := []*v1.Project{
		{Id: "135656834808", Name: "repo", Worktrees: []*v1.Worktree{{Path: "/src/repo"}}},
		{Id: "p2", Name: "twin"}, {Id: "p3", Name: "twin"},
	}
	tests := []struct {
		name    string
		c       command.Context
		args    map[string]string
		wantErr error
		wantReq *v1.RenameProjectRequest
		wantMsg string
	}{
		{name: "by its name", args: map[string]string{"project": "repo", "name": "shop"},
			wantReq: &v1.RenameProjectRequest{Id: "135656834808", Name: "shop"}, wantMsg: "renamed project 135656834808 to shop"},
		{name: "by a path inside it", args: map[string]string{"project": "/src/repo/sub", "name": "shop"},
			wantReq: &v1.RenameProjectRequest{Id: "135656834808", Name: "shop"}},
		{name: "the active project", c: command.Context{ActiveProjectID: "p2"}, args: map[string]string{"name": "left"},
			wantReq: &v1.RenameProjectRequest{Id: "p2", Name: "left"}},
		{name: "an ambiguous name", args: map[string]string{"project": "twin", "name": "x"}, wantErr: command.ErrInvalidArgs},
		{name: "no name", args: map[string]string{"project": "p2"}, wantErr: command.ErrInvalidArgs},
		{name: "no project", args: map[string]string{"name": "x"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Project{Projects: projects}
			if err := command.RegisterProject(reg, b, nil); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.c, "project.rename", tt.args)
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
			if tt.wantMsg != "" && !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
		})
	}
}
