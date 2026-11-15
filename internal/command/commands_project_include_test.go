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

// project.files.include sends the whole list, split at commas; none clears it.
func TestProjectFilesInclude(t *testing.T) {
	projects := []*v1.Project{{Id: "p1", Name: "repo", Worktrees: []*v1.Worktree{{Path: "/src/repo"}}}}
	tests := []struct {
		name    string
		c       command.Context
		args    map[string]string
		wantErr error
		wantReq *v1.SetIncludeIgnoredRequest
		wantMsg string
	}{
		{name: "patterns", args: map[string]string{"project": "repo", "patterns": " .env* , docs/scratch/,, "},
			wantReq: &v1.SetIncludeIgnoredRequest{Id: "p1", Patterns: []string{".env*", "docs/scratch/"}},
			wantMsg: "includes ignored files matching .env*, docs/scratch/"},
		{name: "none clears", c: command.Context{ActiveProjectID: "p1"}, args: map[string]string{"patterns": "None"},
			wantReq: &v1.SetIncludeIgnoredRequest{Id: "p1"}, wantMsg: "no ignored files of its own"},
		{name: "no patterns arg", args: map[string]string{"project": "repo"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			b := &commandtest.Project{Projects: projects}
			if err := command.RegisterProject(reg, b, nil); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.c, "project.files.include", tt.args)
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
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
		})
	}
}
