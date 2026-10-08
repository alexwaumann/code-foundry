package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
)

func newGitOpsRegistry(t *testing.T) (*command.Registry, *commandtest.GitOps) {
	t.Helper()
	reg := command.NewRegistry()
	be := &commandtest.GitOps{}
	slugs := map[string]string{"/gh": "me/repo"}
	err := command.RegisterGitOps(reg, command.GitOpsDeps{
		Backend:    be,
		GitHubSlug: func(c command.Context) string { return slugs[c.ActiveWorktreePath] },
	})
	if err != nil {
		t.Fatal(err)
	}
	return reg, be
}

func TestGitOpsAvailability(t *testing.T) {
	reg, _ := newGitOpsRegistry(t)
	wt := command.Context{ActiveRepoID: "r", ActiveWorktreePath: "/wt"}
	gh := command.Context{ActiveRepoID: "r", ActiveWorktreePath: "/gh"}
	tests := []struct {
		cmd  string
		ctx  command.Context
		want bool
	}{
		{"git.fetch", command.Context{}, false},
		{"git.fetch", command.Context{ActiveRepoID: "r"}, false},
		{"git.fetch", wt, true},
		{"git.pull", wt, true},
		{"git.push", wt, true},
		{"worktree.open.editor", wt, true},
		{"worktree.reveal", command.Context{}, false},
		{"worktree.reveal", wt, true},
		{"pr.create", wt, false}, // no GitHub slug
		{"pr.create", gh, true},
		{"pr.open", wt, false},
		{"pr.open", gh, true},
		{"view.open.url", command.Context{}, true},
	}
	for _, tt := range tests {
		c, ok := reg.Get(tt.cmd)
		if !ok {
			t.Fatalf("%s not registered", tt.cmd)
		}
		if got := c.Available(tt.ctx); got != tt.want {
			t.Errorf("%s available in %+v = %v, want %v", tt.cmd, tt.ctx, got, tt.want)
		}
	}
}

func TestGitOpsCommands(t *testing.T) {
	t.Setenv("HOME", "/Users/me")
	wt := command.Context{ActiveRepoID: "r", ActiveWorktreePath: "/wt"}
	tests := []struct {
		name    string
		cmd     string
		ctx     command.Context
		args    map[string]string
		wantReq proto.Message
		wantErr error
	}{
		{name: "fetch from context", cmd: "git.fetch", ctx: wt, wantReq: &v1.GitFetchRequest{WorktreePath: "/wt"}},
		{name: "fetch with explicit worktree needs no context", cmd: "git.fetch", args: map[string]string{"worktree": "~/src/x"},
			wantReq: &v1.GitFetchRequest{WorktreePath: "/Users/me/src/x"}},
		{name: "fetch without worktree", cmd: "git.fetch", wantErr: command.ErrUnavailable},
		{name: "pull ff-only", cmd: "git.pull", ctx: wt, wantReq: &v1.GitPullRequest{WorktreePath: "/wt"}},
		{name: "pull rebase", cmd: "git.pull", ctx: wt, args: map[string]string{"rebase": "true"}, wantReq: &v1.GitPullRequest{WorktreePath: "/wt", Rebase: true}},
		{name: "push", cmd: "git.push", ctx: wt, wantReq: &v1.GitPushRequest{WorktreePath: "/wt"}},
		{name: "push force", cmd: "git.push", ctx: wt, args: map[string]string{"force-with-lease": "1"}, wantReq: &v1.GitPushRequest{WorktreePath: "/wt", ForceWithLease: true}},
		{name: "push bad bool", cmd: "git.push", ctx: wt, args: map[string]string{"force-with-lease": "maybe"}, wantErr: command.ErrInvalidArgs},
		{name: "pr.create defaults", cmd: "pr.create", args: map[string]string{"worktree": "/gh"}, wantReq: &v1.CreatePullRequestRequest{WorktreePath: "/gh"}},
		{name: "pr.create all args", cmd: "pr.create", ctx: command.Context{ActiveWorktreePath: "/gh"},
			args:    map[string]string{"title": "T", "body": "B", "draft": "true", "base": "dev"},
			wantReq: &v1.CreatePullRequestRequest{WorktreePath: "/gh", Title: "T", Body: "B", Draft: true, Base: "dev"}},
		{name: "pr.create without slug", cmd: "pr.create", ctx: wt, wantErr: command.ErrUnavailable},
		{name: "pr.open", cmd: "pr.open", ctx: command.Context{ActiveWorktreePath: "/gh"}, wantReq: &v1.OpenPullRequestRequest{WorktreePath: "/gh"}},
		{name: "open editor", cmd: "worktree.open.editor", ctx: wt, wantReq: &v1.OpenEditorRequest{WorktreePath: "/wt"}},
		{name: "reveal", cmd: "worktree.reveal", ctx: wt, wantReq: &v1.RevealRequest{WorktreePath: "/wt"}},
		{name: "open url", cmd: "view.open.url", args: map[string]string{"url": "https://x.test/a"}, wantReq: &v1.OpenUrlRequest{Url: "https://x.test/a"}},
		{name: "open url missing", cmd: "view.open.url", wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, be := newGitOpsRegistry(t)
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if res.Message != "ok" {
				t.Errorf("message = %q", res.Message)
			}
			reqs := be.Requests()
			if len(reqs) != 1 || !proto.Equal(reqs[0], tt.wantReq) {
				t.Errorf("requests = %v, want %v", reqs, tt.wantReq)
			}
		})
	}
}

func TestGitOpsResults(t *testing.T) {
	wt := command.Context{ActiveWorktreePath: "/gh"}
	t.Run("success with URL", func(t *testing.T) {
		reg, be := newGitOpsRegistry(t)
		be.Op = &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_SUCCEEDED, Summary: "created pull request #4", Url: "https://github.com/me/repo/pull/4"}
		res, err := reg.Invoke(context.Background(), wt, "pr.create", nil)
		if err != nil {
			t.Fatal(err)
		}
		if res.Message != "created pull request #4: https://github.com/me/repo/pull/4" {
			t.Errorf("message = %q", res.Message)
		}
		if js, _ := res.EncodeJSON(); !strings.Contains(js, `"url":"https://github.com/me/repo/pull/4"`) {
			t.Errorf("json = %s", js)
		}
	})
	t.Run("failed op is an error carrying the op", func(t *testing.T) {
		reg, be := newGitOpsRegistry(t)
		be.Op = &v1.GitOp{Id: "op-9", Title: "Push feat", State: v1.GitOpState_GIT_OP_STATE_FAILED, Summary: "[rejected] feat -> feat (fetch first)",
			Output: "$ git push\n ! [rejected] feat -> feat (fetch first)\n(exit 1)\n"}
		_, err := reg.Invoke(context.Background(), wt, "git.push", nil)
		var ce *connect.Error
		if !errors.As(err, &ce) {
			t.Fatalf("err = %v, want a *connect.Error", err)
		}
		if !strings.HasPrefix(ce.Message(), "Push feat failed: [rejected] feat -> feat (fetch first)\n\n$ git push") {
			t.Errorf("message = %q", ce.Message())
		}
		if len(ce.Details()) != 1 {
			t.Fatalf("details = %v", ce.Details())
		}
		v, err := ce.Details()[0].Value()
		if op, ok := v.(*v1.GitOp); err != nil || !ok || op.GetId() != "op-9" {
			t.Errorf("detail = %v, %v", v, err)
		}
	})
	t.Run("request errors pass through", func(t *testing.T) {
		reg, be := newGitOpsRegistry(t)
		be.Err = connect.NewError(connect.CodeInvalidArgument, errors.New("not a directory"))
		_, err := reg.Invoke(context.Background(), wt, "git.fetch", nil)
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("err = %v", err)
		}
	})
}

// The chords the 3c brief asked for, so a later edit does not drop them silently.
func TestGitOpsKeybindings(t *testing.T) {
	reg, _ := newGitOpsRegistry(t)
	for name, chord := range map[string]string{
		"git.fetch": "cmd+shift+f", "git.pull": "cmd+shift+u", "git.push": "cmd+shift+k", "worktree.open.editor": "cmd+shift+o",
	} {
		c, _ := reg.Get(name)
		if len(c.Keybindings) != 1 || c.Keybindings[0] != chord {
			t.Errorf("%s keybindings = %v, want [%s]", name, c.Keybindings, chord)
		}
	}
}
