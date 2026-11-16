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

func TestThreadSnoozeClear(t *testing.T) {
	needs := v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION
	woken := &v1.Thread{Name: "drv", Status: needs, StatusReason: command.SnoozeEndedReason}
	clear := &v1.ClearSnoozeEndedRequest{Id: "s5"}
	inView := command.Context{ActiveView: "thread", ActiveThreadID: "s5"}

	tests := []struct {
		name       string
		ctx        command.Context
		args       map[string]string
		current    *v1.Thread
		backendErr error
		wantErr    error
		wantCode   connect.Code
		wantMsg    string
		wantReqs   []proto.Message
	}{
		{name: "a woken thread is cleared", args: map[string]string{"id": "s5"}, current: woken,
			wantMsg: "cleared snooze ended on thread drv (s5)", wantReqs: []proto.Message{clear}},
		{name: "the active woken thread in a window", ctx: inView, current: woken,
			wantMsg: "cleared snooze ended on thread drv (s5)", wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}, clear}},
		{name: "from the CLI a thread that is not woken says so", args: map[string]string{"id": "s5"},
			current: &v1.Thread{Name: "drv", Status: needs, StatusReason: "finished"},
			wantMsg: "thread drv (s5) was not woken from a snooze; nothing to clear", wantReqs: []proto.Message{clear}},
		{name: "in a window a thread that is not woken has no clear", ctx: inView,
			current: &v1.Thread{Name: "drv", Status: v1.ThreadStatus_THREAD_STATUS_IDLE, StatusReason: "at prompt"},
			wantErr: command.ErrUnavailable, wantReqs: []proto.Message{&v1.GetThreadRequest{Id: "s5"}}},
		{name: "no thread", wantErr: command.ErrInvalidArgs, wantReqs: []proto.Message{}},
		{name: "an unknown thread", args: map[string]string{"id": "s5"},
			backendErr: connect.NewError(connect.CodeNotFound, errors.New("nope")), wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current, b.Err = tt.current, tt.backendErr
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.snooze.clear", tt.args)
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
			if got := b.Requests(); tt.wantReqs != nil && !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
		})
	}
}
