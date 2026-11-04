package command_test

import (
	"context"
	"errors"
	"maps"
	"slices"
	"testing"

	"connectrpc.com/connect"
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

// A yes is tied to the shells it named: one that started since refuses and stops nothing.
// One that ended is fine, and --yes (no digest) stops what runs.
func TestThreadStopWaitingBindsTheYes(t *testing.T) {
	dev := &v1.BackgroundShell{TaskId: "b1", Command: "npm run dev"}
	late := &v1.BackgroundShell{TaskId: "b2", Command: "rm -rf build"}
	stop := &v1.StopThreadWaitingRequest{ThreadId: "s5"}
	shown := []*v1.BackgroundShell{dev}
	tests := []struct {
		name     string
		now      []*v1.BackgroundShell
		bound    bool
		wantCode connect.Code
		wantStop bool
	}{
		{name: "the same shells", now: shown, bound: true, wantStop: true},
		{name: "another shell started while the question was open", now: []*v1.BackgroundShell{dev, late}, bound: true, wantCode: connect.CodeFailedPrecondition},
		{name: "a different one in its place", now: []*v1.BackgroundShell{late}, bound: true, wantCode: connect.CodeFailedPrecondition},
		{name: "the shell ended meanwhile", bound: true, wantStop: true},
		{name: "--yes names no list", now: []*v1.BackgroundShell{dev, late}, wantStop: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			ctx := command.Context{ActiveThreadID: "s5"}
			b.Current = &v1.Thread{Id: "s5", Name: "drv", BackgroundShells: shown}
			var ce *command.ConfirmError
			if _, err := reg.Invoke(context.Background(), ctx, "thread.stop-waiting", nil); !errors.As(err, &ce) {
				t.Fatalf("err = %v, want the question", err)
			}
			args := map[string]string{}
			if tt.bound {
				maps.Copy(args, ce.Bind)
				if args["shown-digest"] != command.ConfirmDigest(ce.Message) {
					t.Fatalf("bind %v", ce.Bind)
				}
			}
			b.Current = &v1.Thread{Id: "s5", Name: "drv", BackgroundShells: tt.now}
			_, err := reg.Invoke(context.Background(), ctx, "thread.stop-waiting", args, command.Confirmed(true))
			if connect.CodeOf(err) != tt.wantCode && (tt.wantCode != 0 || err != nil) {
				t.Fatalf("err = %v, want code %v", err, tt.wantCode)
			}
			stopped := slices.ContainsFunc(b.Requests(), func(m proto.Message) bool { return proto.Equal(m, stop) })
			if stopped != tt.wantStop {
				t.Errorf("stopped = %v, want %v", stopped, tt.wantStop)
			}
		})
	}
}

// A resident thread is not asked about its shells: the store refuses it, and the refusal
// must reach the palette and the CLI as itself.
func TestThreadStopWaitingResident(t *testing.T) {
	refused := connect.NewError(connect.CodeFailedPrecondition, errors.New("thread s5 is the resident ember thread"))
	reg, b, _ := newLifecycleRegistry(t)
	b.Current = &v1.Thread{Id: "s5", Kind: v1.ThreadKind_THREAD_KIND_RESIDENT, BackgroundShells: []*v1.BackgroundShell{{TaskId: "b1", Command: "x"}}}
	b.StopWaitingErr = refused
	_, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s5"}, "thread.stop-waiting", nil)
	var ce *command.ConfirmError
	if errors.As(err, &ce) {
		t.Fatalf("it asked: %q", ce.Message)
	}
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("err = %v, want the store's refusal", err)
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
