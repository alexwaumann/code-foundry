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

// thread.get, thread.send, thread.wait and thread.read on a removed thread say so alike,
// with its cost, and exit 1, by full id or suffix (E4 4.5, W4 finding 4); an id never
// seen stays a not-found usage error.
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
	fake.Put(thread.Thread{ID: "s-2a058e5a795a", Name: "Add persistence", CreatedBy: "s-p", Labels: []string{"e4"}, State: thread.StateDisconnected,
		Report: thread.Report{Status: thread.ReportDone, Summary: "c6b0cb6", Data: `{"n":1}`}, BudgetUSD: 0.5,
		Usage: []thread.UsageBucket{{Model: "claude-haiku-4-5", Day: "2026-10-19", Requests: 3, Input: 94_000}}})
	fake.Put(thread.Thread{ID: "s-00000000000q", State: thread.StateDisconnected})
	fake.Put(thread.Thread{ID: "s-11110000795a", Name: "Alive", State: thread.StateDisconnected})
	for _, id := range []string{"s-2a058e5a795a", "s-00000000000q"} {
		if err := fake.Remove(ctx, id); err != nil {
			t.Fatal(err)
		}
	}
	const (
		removed = "thread Add persistence (s-2a058e5a795a) was removed at 2026-10-19 12:00:00\n"
		report  = "last report: done — c6b0cb6\n    {\n      \"n\": 1\n    }\n"
		cost    = "cost: $0.09 of a $0.50 budget"
		plain   = "thread s-00000000000q was removed at 2026-10-19 12:00:00\nno report\ncost: $0.00"
	)
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		wantMsg  string
		wantCost float64
		wantCode connect.Code
	}{
		{name: "get", cmd: "thread.get", args: map[string]string{"id": "s-2a058e5a795a"},
			wantMsg: removed + "created by: s-p\nlabels: e4\n" + report + cost, wantCost: 0.094},
		{name: "get by suffix", cmd: "thread.get", args: map[string]string{"id": "2a058e5a795a"},
			wantMsg: removed + "created by: s-p\nlabels: e4\n" + report + cost, wantCost: 0.094},
		{name: "get, unnamed and unreported", cmd: "thread.get", args: map[string]string{"id": "s-00000000000q"}, wantMsg: plain},
		{name: "wait", cmd: "thread.wait", args: map[string]string{"id": "s-2a058e5a795a"}, wantMsg: removed + report + cost, wantCost: 0.094},
		{name: "wait by suffix", cmd: "thread.wait", args: map[string]string{"id": "8e5a795a"}, wantMsg: removed + report + cost, wantCost: 0.094},
		{name: "wait after an item", cmd: "thread.wait", args: map[string]string{"id": "s-00000000000q", "after": "3"}, wantMsg: plain},
		{name: "read", cmd: "thread.read", args: map[string]string{"id": "s-2a058e5a795a"}, wantMsg: removed + report + cost, wantCost: 0.094},
		{name: "read by suffix", cmd: "thread.read", args: map[string]string{"id": "000q"}, wantMsg: plain},
		{name: "items", cmd: "thread.items", args: map[string]string{"id": "s-00000000000q"}, wantMsg: plain},
		{name: "send", cmd: "thread.send", args: map[string]string{"id": "s-00000000000q", "text": "hi"}, wantMsg: plain},
		{name: "send --wait", cmd: "thread.send", args: map[string]string{"id": "s-00000000000q", "text": "hi", "wait": "true"}, wantMsg: plain},
		{name: "get of an unknown id", cmd: "thread.get", args: map[string]string{"id": "s-nope"}, wantCode: connect.CodeNotFound},
		{name: "an unknown suffix", cmd: "thread.get", args: map[string]string{"id": "ffff"}, wantCode: connect.CodeNotFound},
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
			if d := r.CostUSD - tt.wantCost; d > 1e-9 || d < -1e-9 {
				t.Errorf("costUsd = %v, want %v", r.CostUSD, tt.wantCost)
			}
		})
	}
	// A live thread wins a suffix both end in: removed threads are only the fallback.
	res, err := reg.Invoke(ctx, command.Context{}, "thread.get", map[string]string{"id": "795a"})
	if err != nil || res.ExitCode != 0 {
		t.Fatalf("get 795a = %q, %v", res.Message, err)
	}
}
