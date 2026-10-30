package command_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.project.add and thread.project.remove: the request, the message (the
// workspace left, a live Claude's restart), and the removal's confirmation when the
// member's checkout has uncommitted work.
func TestThreadProjectSet(t *testing.T) {
	dirty := &v1.ThreadCheckoutsResponse{Checkouts: []*v1.ThreadCheckout{
		{ProjectId: "r-web", ProjectName: "web", Path: "/w/web", Primary: true, Status: &v1.GitStatus{Dirty: true, Modified: 1}},
		{ProjectId: "r-api", ProjectName: "api", Path: "/w/api", Status: &v1.GitStatus{Dirty: true, Modified: 2, Untracked: 1}},
		{ProjectId: "r-lib", ProjectName: "lib", Path: "/w/lib", Status: &v1.GitStatus{}},
	}}
	inPlatform := &v1.ThreadCheckoutsResponse{WorkspaceId: "w-plat", WorkspaceName: "platform", Checkouts: dirty.GetCheckouts()}
	stopped := &v1.Thread{Name: "fix", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, ProjectIds: []string{"r-web"}}
	inWS := &v1.Thread{Name: "fix", State: v1.ThreadState_THREAD_STATE_CONNECTED, ProjectIds: []string{"r-web", "r-api"}, WorkspaceId: "w-plat"}
	tests := []struct {
		name      string
		cmd       string
		ctx       command.Context
		args      map[string]string
		current   *v1.Thread
		checkouts *v1.ThreadCheckoutsResponse
		wantMsg   string
		wantReq   proto.Message
		wantErr   error
		wantAsk   string
		yes       bool
	}{
		{name: "add to a stopped thread", cmd: "thread.project.add", ctx: command.Context{ActiveThreadID: "s-c"}, args: map[string]string{"project": "api"},
			current: stopped, wantMsg: "added api to thread fix (s-c) (2 projects)",
			wantReq: &v1.AddThreadProjectRequest{Id: "s-c", Project: "api"}},
		{name: "add to a live thread in a workspace", cmd: "thread.project.add", args: map[string]string{"id": "s-c", "project": "lib"}, current: inWS, checkouts: inPlatform,
			wantMsg: "added lib to thread fix (s-c) (3 projects); it no longer follows workspace platform (w-plat) (thread workspace saves the set as one); " +
				"Claude restarts for it once idle, resuming the conversation",
			wantReq: &v1.AddThreadProjectRequest{Id: "s-c", Project: "lib"}},
		{name: "remove a clean member", cmd: "thread.project.remove", args: map[string]string{"id": "s-c", "project": "lib"},
			current: stopped, checkouts: dirty, wantMsg: "removed lib from thread fix (s-c) (1 project); its checkout stays on disk",
			wantReq: &v1.RemoveThreadProjectRequest{Id: "s-c", Project: "lib"}},
		{name: "remove a dirty member asks", cmd: "thread.project.remove", args: map[string]string{"id": "s-c", "project": "api"},
			current: stopped, checkouts: dirty,
			wantAsk: "api's checkout at /w/api has uncommitted work: 2 modified, 1 untracked.\n\nIt stays on disk with the work, but this thread no longer sees it. Remove api from the thread?"},
		{name: "remove a dirty member with --yes", cmd: "thread.project.remove", args: map[string]string{"id": "s-c", "project": "r-api"}, yes: true,
			current: inWS, checkouts: inPlatform,
			wantMsg: "removed r-api from thread fix (s-c) (1 project); its checkout stays on disk; it no longer follows workspace platform (w-plat) " +
				"(thread workspace saves the set as one); Claude restarts for it once idle, resuming the conversation",
			wantReq: &v1.RemoveThreadProjectRequest{Id: "s-c", Project: "r-api"}},
		{name: "no thread in the GUI", cmd: "thread.project.add", ctx: command.Context{ActiveView: "dashboard"}, args: map[string]string{"project": "api"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			if tt.current != nil {
				b.Current = proto.CloneOf(tt.current)
			}
			b.CheckoutsResp = tt.checkouts
			res, err := reg.Invoke(context.Background(), tt.ctx, tt.cmd, tt.args, command.Confirmed(tt.yes))
			if tt.wantAsk != "" {
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
				return
			}
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
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
			if i := slices.IndexFunc(b.Requests(), func(m proto.Message) bool { return proto.Equal(m, tt.wantReq) }); i < 0 {
				t.Errorf("requests = %v, want %v among them", b.Requests(), tt.wantReq)
			}
		})
	}
}
