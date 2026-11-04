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

// thread.stop-waiting asks only when shells would stop, naming them, and never says it
// stops a child thread.
func TestThreadStopWaiting(t *testing.T) {
	shell := func(cmd, desc string) *v1.BackgroundShell {
		return &v1.BackgroundShell{TaskId: "b1", Command: cmd, Description: desc}
	}
	stop := &v1.StopThreadWaitingRequest{ThreadId: "s5"}
	get := &v1.GetThreadRequest{Id: "s5"}
	tests := []struct {
		name      string
		ctx       command.Context
		shells    []*v1.BackgroundShell
		confirmed bool
		wantAsk   string
		wantErr   error
		wantMsg   string
		wantReqs  []proto.Message
	}{
		{name: "no shells: no question", ctx: command.Context{ActiveThreadID: "s5"},
			wantMsg: "thread drv (s5) had nothing to stop", wantReqs: []proto.Message{get, stop}},
		{name: "a shell: it asks, naming it", ctx: command.Context{ActiveThreadID: "s5"}, shells: []*v1.BackgroundShell{shell("npm run dev", "")},
			wantAsk:  "This stops 1 background shell: npm run dev. Its other wakes go too; child threads keep working.",
			wantReqs: []proto.Message{get, get}},
		{name: "two shells, one known by its description, one by the first line", ctx: command.Context{ActiveThreadID: "s5"},
			shells:   []*v1.BackgroundShell{shell("", "Serve the docs"), shell("make\nmake check", "")},
			wantAsk:  "This stops 2 background shells: Serve the docs, make …. Its other wakes go too; child threads keep working.",
			wantReqs: []proto.Message{get, get}},
		{name: "confirmed: it runs", ctx: command.Context{ActiveThreadID: "s5"}, shells: []*v1.BackgroundShell{shell("npm run dev", "")}, confirmed: true,
			wantReqs: []proto.Message{stop}},
		{name: "unavailable without a thread", ctx: command.Context{ActiveView: "pullrequests"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = &v1.Thread{Id: "s5", Name: "drv", BackgroundShells: tt.shells}
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.stop-waiting", nil, command.Confirmed(tt.confirmed))
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			case tt.wantAsk != "":
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk || ce.Label != "Stop waiting" {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
			case err != nil:
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := b.Requests(); tt.wantReqs != nil && !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
		})
	}
}

// What it says it did, and that subagents ran on.
func TestStopWaitingMessage(t *testing.T) {
	th := func(agents int32) *v1.Thread {
		return &v1.Thread{Id: "s5", Name: "drv", BackgroundAgentsRunning: agents}
	}
	subs := []*v1.ThreadSubscription{{Id: "sub-1"}, {Id: "sub-2"}}
	tests := []struct {
		name string
		res  *v1.StopThreadWaitingResponse
		want string
	}{
		{"nothing", &v1.StopThreadWaitingResponse{Thread: th(0)}, "thread drv (s5) had nothing to stop"},
		{"wakes", &v1.StopThreadWaitingResponse{Thread: th(0), Removed: subs}, "thread drv (s5): removed 2 wakes"},
		{"a wake and a shell", &v1.StopThreadWaitingResponse{Thread: th(0), Removed: subs[:1], StoppedShells: []*v1.BackgroundShell{{}}},
			"thread drv (s5): removed 1 wake, stopping 1 background shell"},
		{"subagents run on", &v1.StopThreadWaitingResponse{Thread: th(2), Removed: subs}, "thread drv (s5): removed 2 wakes; 2 subagents still running"},
		{"only subagents", &v1.StopThreadWaitingResponse{Thread: th(1)}, "thread drv (s5) had nothing to stop; 1 subagent still running"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := command.StopWaitingMessage(tt.res); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
