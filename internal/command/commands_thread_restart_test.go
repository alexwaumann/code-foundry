package command_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// thread.restart asks only when the restart cuts something off: a turn (interrupted) or
// background work (stopped). A thread whose Claude is not running is not restarted.
func TestThreadRestart(t *testing.T) {
	connected := v1.ThreadState_THREAD_STATE_CONNECTED
	live := func(status v1.ThreadStatus, reason string) *v1.Thread {
		return &v1.Thread{Name: "drv", State: connected, Status: status, StatusReason: reason, PluginEnvStale: true, PluginEnvChange: "Hello removed CF_HELLO"}
	}
	get := &v1.GetThreadRequest{Id: "s5"}
	restart := &v1.RestartThreadRequest{Id: "s5"}
	const interrupted = "Restart Claude for drv? The conversation continues; the current turn is interrupted."
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		current   *v1.Thread
		confirmed bool
		wantErr   error
		wantAsk   string
		wantMsg   string
		wantReqs  []proto.Message
	}{
		{name: "an idle thread restarts without asking", ctx: command.Context{ActiveThreadID: "s5"},
			current: live(v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt"),
			wantMsg: "restarting Claude for thread drv (s5); the conversation continues", wantReqs: []proto.Message{get, restart}},
		{name: "a finished turn restarts without asking", args: map[string]string{"id": "s5"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "finished"),
			wantMsg: "restarting Claude for thread drv (s5); the conversation continues"},
		{name: "a working thread asks", args: map[string]string{"id": "s5"},
			current: live(v1.ThreadStatus_THREAD_STATUS_BUSY, "working"), wantAsk: interrupted, wantReqs: []proto.Message{get, get}},
		{name: "a pending question asks", args: map[string]string{"id": "s5"},
			current: live(v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which one?"), wantAsk: interrupted},
		{name: "a starting thread asks", args: map[string]string{"id": "s5"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_STARTING}, wantAsk: interrupted},
		{name: "background work asks", args: map[string]string{"id": "s5"},
			current: &v1.Thread{Name: "drv", State: connected, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundAgentsRunning: 1},
			wantAsk: "Restart Claude for drv? The conversation continues, but 1 background agent is running; restarting stops it."},
		{name: "a working thread restarts once confirmed", args: map[string]string{"id": "s5"}, confirmed: true,
			current: live(v1.ThreadStatus_THREAD_STATUS_BUSY, "working"),
			wantMsg: "restarting Claude for thread drv (s5); the conversation continues", wantReqs: []proto.Message{restart}},
		{name: "a stopped thread is left as it is", args: map[string]string{"id": "s5"},
			current: &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_DISCONNECTED},
			wantMsg: "Claude is not running for thread drv (s5); its next message starts it with the current environment"},
		{name: "unavailable in the GUI without a thread", ctx: command.Context{ActiveView: "dashboard"}, wantErr: command.ErrUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = tt.current
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.restart", tt.args, command.Confirmed(tt.confirmed))
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case tt.wantAsk != "":
				var ce *command.ConfirmError
				if !errors.As(err, &ce) || ce.Message != tt.wantAsk || ce.Title != "Restart Claude" {
					t.Fatalf("err = %v, want the confirmation %q", err, tt.wantAsk)
				}
			case err != nil:
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			got := b.Requests()
			if tt.wantReqs != nil && !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
			if tt.wantAsk != "" && slices.ContainsFunc(got, func(m proto.Message) bool { _, ok := m.(*v1.RestartThreadRequest); return ok }) {
				t.Error("restarted without the confirmation")
			}
		})
	}
}

// thread.get says when the running process has an old plugin environment, and how to
// apply the new one.
func TestThreadGetPluginEnv(t *testing.T) {
	reg, b, _ := newLifecycleRegistry(t)
	b.Current = &v1.Thread{Name: "drv", State: v1.ThreadState_THREAD_STATE_CONNECTED, PluginEnvStale: true, PluginEnvChange: "Hello removed CF_HELLO"}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.get", map[string]string{"id": "s5"})
	if err != nil {
		t.Fatal(err)
	}
	const want = "plugin environment: changed since Claude started (Hello removed CF_HELLO); thread restart s5 applies it"
	if !strings.Contains(res.Message, want) {
		t.Errorf("thread get:\n%s\nwant a line %q", res.Message, want)
	}
	b.Current.PluginEnvStale, b.Current.PluginEnvChange = false, ""
	if res, _ = reg.Invoke(context.Background(), command.Context{}, "thread.get", map[string]string{"id": "s5"}); strings.Contains(res.Message, "plugin environment") {
		t.Errorf("thread get of a current thread:\n%s", res.Message)
	}
}
