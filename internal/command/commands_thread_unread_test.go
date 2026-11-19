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

// thread.unread given ids (the sidebar's bulk menu): each is marked, past one the daemon
// refuses, in one command.
func TestThreadUnreadIDs(t *testing.T) {
	a, b := idle("s-aaaa11112222", "one"), idle("s-bbbb33334444", "two")
	refused := connect.NewError(connect.CodeFailedPrecondition, errors.New("thread is not idle at its prompt"))
	atPrompt := &v1.Thread{Name: "one", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt"}
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		fail     map[string]error
		wantErr  error
		wantMsg  string
		wantExit int
		wantIDs  []string
	}{
		{name: "every one is marked", args: map[string]string{"ids": "11112222,33334444"},
			wantMsg: "marked 2 threads unread: s-aaaa11112222, s-bbbb33334444", wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444"}},
		// In a window id is the thread in view; ids replaces it.
		{name: "ids ignore the thread in view", ctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-aaaa11112222"},
			args: map[string]string{"ids": "33334444"}, wantMsg: "marked 1 thread unread: s-bbbb33334444", wantIDs: []string{"s-bbbb33334444"}},
		{name: "one refused, the rest are marked and it exits 1", args: map[string]string{"ids": "11112222,33334444"},
			fail:     map[string]error{"s-aaaa11112222": refused},
			wantMsg:  "marked 1 thread unread: s-bbbb33334444\nfailed on 1 thread:\n  s-aaaa11112222: failed_precondition: thread is not idle at its prompt",
			wantExit: 1, wantIDs: []string{"s-aaaa11112222", "s-bbbb33334444"}},
		{name: "one id as before", args: map[string]string{"id": "s-aaaa11112222"},
			wantMsg: "marked thread one (s-aaaa11112222) unread", wantIDs: []string{"s-aaaa11112222"}},
		{name: "neither id nor ids from the CLI", wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newBulkRegistry(t, a, b)
			fake.Current = proto.CloneOf(atPrompt)
			fake.FailIDs = tt.fail
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.unread", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg || res.ExitCode != tt.wantExit {
				t.Errorf("result = %q (exit %d), want %q (exit %d)", res.Message, res.ExitCode, tt.wantMsg, tt.wantExit)
			}
			var ids []string
			for _, r := range fake.Requests() {
				if r, ok := r.(*v1.MarkUnreadRequest); ok {
					ids = append(ids, r.GetId())
				}
			}
			if !slices.Equal(ids, tt.wantIDs) {
				t.Errorf("marked %v, want %v", ids, tt.wantIDs)
			}
		})
	}
}
