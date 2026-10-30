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

// thread.shell.stop sends the task and the thread (the active one in the GUI).
func TestThreadShellStop(t *testing.T) {
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		wantErr  error
		wantMsg  string
		wantReqs []proto.Message
	}{
		{name: "the active thread's shell", ctx: command.Context{ActiveThreadID: "s5"}, args: map[string]string{"task": "b1x2"},
			wantMsg: "stopping background shell b1x2 of thread drv (s5)", wantReqs: []proto.Message{&v1.StopThreadShellRequest{ThreadId: "s5", TaskId: "b1x2"}}},
		{name: "a named thread", args: map[string]string{"task": "b1x2", "id": "s7"},
			wantReqs: []proto.Message{&v1.StopThreadShellRequest{ThreadId: "s7", TaskId: "b1x2"}}},
		{name: "the task is required", ctx: command.Context{ActiveThreadID: "s5"}, wantErr: command.ErrInvalidArgs},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, b, _ := newLifecycleRegistry(t)
			b.Current = &v1.Thread{Id: "s5", Name: "drv"}
			res, err := reg.Invoke(context.Background(), tt.ctx, "thread.shell.stop", tt.args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.wantMsg != "" && res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			if got := b.Requests(); !slices.EqualFunc(got, tt.wantReqs, proto.Equal) {
				t.Errorf("requests = %v, want %v", got, tt.wantReqs)
			}
		})
	}
}

// thread.get lists the running background shells with the ports they listen on.
func TestThreadGetShells(t *testing.T) {
	reg, b, _ := newLifecycleRegistry(t)
	b.Current = &v1.Thread{Name: "drv", BackgroundShells: []*v1.BackgroundShell{
		{TaskId: "b1", Command: "python3 -m http.server 9399", Ports: []uint32{9399}},
		{TaskId: "b2", Command: "pnpm dev", Ports: []uint32{5173, 24678}},
		{TaskId: "b3", Description: "Watch the build"},
		{TaskId: "b4", Command: "for f in *; do\n  echo $f\ndone"},
	}}
	res, err := reg.Invoke(context.Background(), command.Context{}, "thread.get", map[string]string{"id": "s5"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"background shell b1: python3 -m http.server 9399 (localhost:9399)",
		"background shell b2: pnpm dev (localhost:5173, localhost:24678)",
		"background shell b3: Watch the build\n",
		"background shell b4: for f in *; do …\n",
	} {
		if !strings.Contains(res.Message, want) {
			t.Errorf("thread get:\n%s\nwant %q", res.Message, want)
		}
	}
}
