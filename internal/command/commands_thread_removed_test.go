package command_test

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// thread.get, thread.send and thread.wait on a removed thread say so and exit 1; an id
// never seen stays a not-found usage error.
func TestRemovedThreadCommands(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Now = func() time.Time { return time.Date(2026, 10, 19, 12, 0, 0, 0, time.Local) }
	reg := command.NewRegistry()
	h := api.NewThread(fake, b)
	if err := command.RegisterThread(reg, h); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterThreadLifecycle(reg, h, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	fake.Put(thread.Thread{ID: "s-c", Name: "Add persistence", CreatedBy: "s-p", Labels: []string{"e4"}, State: thread.StateDisconnected,
		Report: thread.Report{Status: thread.ReportDone, Summary: "c6b0cb6", Data: `{"n":1}`}})
	fake.Put(thread.Thread{ID: "s-q", State: thread.StateDisconnected})
	for _, id := range []string{"s-c", "s-q"} {
		if err := fake.Remove(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		wantMsg  string
		wantCode connect.Code
	}{
		{name: "get", cmd: "thread.get", args: map[string]string{"id": "s-c"},
			wantMsg: "thread Add persistence (s-c) was removed at 2026-10-19 12:00:00\ncreated by: s-p\nlabels: e4\n" +
				"last report: done — c6b0cb6\n    {\n      \"n\": 1\n    }"},
		{name: "get, unnamed and unreported", cmd: "thread.get", args: map[string]string{"id": "s-q"},
			wantMsg: "thread s-q was removed at 2026-10-19 12:00:00\nno report"},
		{name: "wait", cmd: "thread.wait", args: map[string]string{"id": "s-c"},
			wantMsg: "thread s-c Add persistence was removed at 2026-10-19 12:00:00\nlast report: done — c6b0cb6\n    {\n      \"n\": 1\n    }"},
		{name: "wait after an item", cmd: "thread.wait", args: map[string]string{"id": "s-q", "after": "3"},
			wantMsg: "thread s-q was removed at 2026-10-19 12:00:00\nno report"},
		{name: "send", cmd: "thread.send", args: map[string]string{"id": "s-q", "text": "hi"},
			wantMsg: "thread s-q was removed at 2026-10-19 12:00:00\nno report"},
		{name: "send --wait", cmd: "thread.send", args: map[string]string{"id": "s-q", "text": "hi", "wait": "true"},
			wantMsg: "thread s-q was removed at 2026-10-19 12:00:00\nno report"},
		{name: "get of an unknown id", cmd: "thread.get", args: map[string]string{"id": "s-nope"}, wantCode: connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := reg.Invoke(ctx, command.Context{}, tt.cmd, tt.args)
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want %s", err, tt.wantCode)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			r, ok := res.JSON.(command.ThreadReport)
			if res.Message != tt.wantMsg || res.ExitCode != 1 || !ok || !r.Removed || r.Status != "removed" || r.RemovedAt == nil {
				t.Errorf("result = %q (exit %d, JSON %+v), want\n%s", res.Message, res.ExitCode, res.JSON, tt.wantMsg)
			}
		})
	}
}
