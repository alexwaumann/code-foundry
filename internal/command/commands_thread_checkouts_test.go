package command_test

import (
	"context"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.checkouts prints the thread, one line per project and its workspace; the
// thread is --id, else the palette's active thread, else the one holding --cwd.
func TestThreadCheckouts(t *testing.T) {
	resp := &v1.ThreadCheckoutsResponse{
		Thread: &v1.Thread{Id: "s1", Name: "login", CreatedWorktree: true, Branch: "feat/login"},
		Checkouts: []*v1.ThreadCheckout{
			{ProjectId: "api", ProjectName: "api", Path: "/wt/api/feat-login", Missing: true, Git: true, WorktreeMode: true, CreatedBranch: "feat/login"},
			{ProjectId: "cli", ProjectName: "cli", Path: "/wt/cli/feat-login", Detached: true, Head: "0badc0ffee", Git: true, WorktreeMode: true,
				CreatedBranch: "feat/login", Moved: true},
			{ProjectId: "docs", ProjectName: "docs", Path: "/src/docs"},
			{ProjectId: "web", ProjectName: "web", Path: "/wt/web/feat-login", Branch: "feat/login-2", Primary: true, Current: true,
				Instructions: "/wt/web/feat-login/CLAUDE.md", Git: true, WorktreeMode: true, CreatedBranch: "feat/login", Moved: true},
		},
		WorkspaceId: "w-1", WorkspaceName: "shop",
	}
	const want = "thread login (s1): worktrees made for branch feat/login\n" +
		"PROJECT  PATH                BRANCH                                          INSTRUCTIONS\n" +
		"api      /wt/api/feat-login  feat/login (missing)                            -\n" +
		"cli      /wt/cli/feat-login  (detached 0badc0f) (moved from feat/login)      -\n" +
		"docs     /src/docs           (folder)                                        -\n" +
		"web      /wt/web/feat-login  feat/login-2 (moved from feat/login) (current)  /wt/web/feat-login/CLAUDE.md\n" +
		"WORKSPACE shop  -"
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		wantReq *v1.ThreadCheckoutsRequest
	}{
		{name: "by id", args: map[string]string{"id": "s1"}, wantReq: &v1.ThreadCheckoutsRequest{Id: "s1"}},
		{name: "by cwd", args: map[string]string{"cwd": "/wt/web/feat-login/src"}, wantReq: &v1.ThreadCheckoutsRequest{Cwd: "/wt/web/feat-login/src"}},
		{name: "the palette's thread", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, wantReq: &v1.ThreadCheckoutsRequest{Id: "s1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.CheckoutsResp = resp
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.checkouts", tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != want {
				t.Errorf("message:\n%s\nwant:\n%s", res.Message, want)
			}
			if got := b.Requests(); !slices.EqualFunc(got, []proto.Message{tt.wantReq}, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReq)
			}
		})
	}
}

// thread.new's collision hints are warnings (stderr in the CLI), never a refusal.
func TestThreadNewHints(t *testing.T) {
	reg, b, _ := newLifecycleRegistry(t)
	b.Hints = []string{"web @ feat/x is also open in fix (s-2)"}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.new", map[string]string{"project": "web"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.Warnings, b.Hints) {
		t.Errorf("warnings %q, want %q", res.Warnings, b.Hints)
	}
}
