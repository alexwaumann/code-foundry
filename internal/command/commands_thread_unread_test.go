package command_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

func TestThreadUnread(t *testing.T) {
	idle := &v1.Thread{Name: "drv", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt"}
	busy := &v1.Thread{Name: "drv", Status: v1.ThreadStatus_THREAD_STATUS_BUSY, StatusReason: "working"}
	mark := &v1.MarkUnreadRequest{Id: "s5"}
	inView := command.Context{ActiveView: "thread", ActiveThreadID: "s5"}

	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		current  *v1.Thread
		wantErr  error
		wantCode connect.Code
		wantMsg  string
		wantReqs []proto.Message
	}{
		{name: "from the CLI an idle thread is marked", args: map[string]string{"id": "s5"}, current: idle,
			wantMsg: "marked thread drv (s5) unread", wantReqs: []proto.Message{mark}},
		{name: "the active thread in a window", ctx: inView, current: idle,
			wantMsg: "marked thread drv (s5) unread", wantReqs: []proto.Message{mark}},
		// The daemon's rule (internal/store/thread unread.go): its refusal is the error.
		{name: "a thread that is not idle is refused by the daemon", ctx: inView, current: busy,
			wantCode: connect.CodeFailedPrecondition, wantReqs: []proto.Message{mark}},
		{name: "no thread from the CLI", wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "no thread in a window", ctx: command.Context{ActiveView: "pullrequests"}, wantErr: command.ErrUnavailable, wantReqs: []proto.Message{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = tt.current
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.unread", tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case err != nil:
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
		})
	}
}

func TestThreadUnreadSpec(t *testing.T) {
	reg, _, _ := newLifecycleRegistry(t)
	c, ok := reg.Get("thread.unread")
	if !ok {
		t.Fatal("no thread.unread")
	}
	if c.Title != "Mark as Unread" || c.Category != "Thread" || !slices.Equal(c.Keybindings, []string{"cmd+shift+u"}) || c.NoPalette || !c.NoIndex {
		t.Errorf("thread.unread = %+v", c)
	}
}
