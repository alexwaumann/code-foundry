package command_test

import (
	"context"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.pr.link: the request (the active thread by default), the message for a new
// link and for one the thread has, and refusals passed through.
func TestThreadPRLink(t *testing.T) {
	has := &v1.Thread{Name: "fix", LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "o/r", Number: 5, Url: "https://github.com/o/r/pull/5"}}}
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		current  *v1.Thread
		wantReq  proto.Message
		wantMsg  string
		wantErr  error
		wantCode connect.Code
	}{
		{name: "the active thread, by URL", ctx: command.Context{ActiveThreadID: "s-c"}, args: map[string]string{"pr": "https://github.com/o/r/pull/7"}, current: has,
			wantReq: &v1.LinkThreadPullRequestRequest{Id: "s-c", PullRequest: "https://github.com/o/r/pull/7"}, wantMsg: "linked o/r#7 to thread fix (s-c)"},
		{name: "already linked: a quiet success", args: map[string]string{"id": "s-c", "pr": "O/R#5"}, current: has,
			wantReq: &v1.LinkThreadPullRequestRequest{Id: "s-c", PullRequest: "O/R#5"}, wantMsg: "thread fix (s-c) already has o/r#5 linked"},
		{name: "not a pull request passes through", args: map[string]string{"id": "s-c", "pr": "https://github.com/o/r/issues/1"}, current: has,
			wantCode: connect.CodeInvalidArgument},
		{name: "no thread in the GUI", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"pr": "o/r#1"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			if tt.current != nil {
				b.Current = proto.CloneOf(tt.current)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.pr.link", tt.args)
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if reqs := b.Requests(); len(reqs) == 0 || !proto.Equal(reqs[len(reqs)-1], tt.wantReq) {
				t.Errorf("requests = %v, want %v last", reqs, tt.wantReq)
			}
		})
	}
}
