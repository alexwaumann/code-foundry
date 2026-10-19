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

// project.branch.delete deletes a branch whose worktree is gone (W4 finding 3), the
// project by id or name.
func TestProjectBranchDelete(t *testing.T) {
	projects := []*v1.Project{
		{Id: "r1", Name: "app", Git: true}, {Id: "r2", Name: "twin", Git: true}, {Id: "r3", Name: "twin", Git: true},
	}
	tests := []struct {
		name        string
		ctx         command.Context
		args        map[string]string
		confirmed   bool
		wantReq     *v1.DeleteBranchRequest
		wantMsg     string
		wantErr     error
		wantConfirm string
	}{
		{name: "by id", args: map[string]string{"project": "r1", "branch": "cf/x"}, confirmed: true,
			wantReq: &v1.DeleteBranchRequest{ProjectId: "r1", Branch: "cf/x"}, wantMsg: "deleted branch cf/x locally"},
		{name: "by name, forced, with origin", args: map[string]string{"project": "app", "branch": "cf/x", "force": "true", "remote": "true"},
			confirmed: true, wantReq: &v1.DeleteBranchRequest{ProjectId: "r1", Branch: "cf/x", Force: true, Remote: true},
			wantMsg: "deleted branch cf/x locally and on origin"},
		{name: "the context project", ctx: command.Context{ActiveProjectID: "r1"}, args: map[string]string{"branch": "cf/x"}, confirmed: true,
			wantReq: &v1.DeleteBranchRequest{ProjectId: "r1", Branch: "cf/x"}},
		{name: "asks first", args: map[string]string{"project": "r1", "branch": "cf/x"}, wantConfirm: "Delete branch cf/x of project r1?"},
		{name: "asks first about origin", args: map[string]string{"project": "r1", "branch": "cf/x", "remote": "true"},
			wantConfirm: "Delete branch cf/x of project r1, and on origin?"},
		{name: "an unknown project", args: map[string]string{"project": "nope", "branch": "cf/x"}, confirmed: true, wantErr: command.ErrInvalidArgs},
		{name: "two projects of that name", args: map[string]string{"project": "twin", "branch": "cf/x"}, confirmed: true, wantErr: command.ErrInvalidArgs},
		{name: "no branch", args: map[string]string{"project": "r1"}, confirmed: true, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			p := &commandtest.Project{Projects: projects}
			if err := command.RegisterProject(reg, p, nil); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "project.branch.delete", tt.args, command.Confirmed(tt.confirmed))
			var ce *command.ConfirmError
			switch {
			case tt.wantConfirm != "":
				if !errors.As(err, &ce) || ce.Message != tt.wantConfirm {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantConfirm)
				}
				return
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			case err != nil:
				return
			}
			if !strings.HasPrefix(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			var got *v1.DeleteBranchRequest
			for _, r := range p.Requests() {
				if d, ok := r.(*v1.DeleteBranchRequest); ok {
					got = d
				}
			}
			if !proto.Equal(got, tt.wantReq) {
				t.Errorf("request = %v, want %v", got, tt.wantReq)
			}
		})
	}
}
