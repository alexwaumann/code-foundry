package command_test

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestUsageShow(t *testing.T) {
	opus := &v1.UsageBucket{Day: "2026-10-09", Model: "claude-opus-5-5", Requests: 2, Output: 100, CostUsd: 3}
	haiku := &v1.UsageBucket{Day: "2026-10-09", Model: "claude-haiku-5-5", Requests: 1, Output: 50, CostUsd: 1}
	b := &commandtest.Thread{
		Current:      &v1.Thread{Id: "s-1", Name: "demo", Usage: []*v1.UsageBucket{opus}},
		Others:       []*v1.Thread{{Id: "s-2", Usage: []*v1.UsageBucket{haiku}}},
		RetiredUsage: []*v1.UsageBucket{opus},
	}
	reg := command.NewRegistry()
	if err := command.RegisterUsage(reg, b); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name     string
		args     map[string]string
		heading  string
		requests int64
		cost     float64
		threads  int
		retired  bool
	}{
		{name: "one thread", args: map[string]string{"thread": "s-1"}, heading: "Thread s-1 (demo): 2 requests",
			requests: 2, cost: 3, threads: 1},
		{name: "every thread plus removed ones", heading: "All threads (2 + removed): 5 requests",
			requests: 5, cost: 7, threads: 2, retired: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := reg.Invoke(context.Background(), command.Context{}, "usage.show", tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(res.Message, tt.heading) {
				t.Errorf("message = %q", res.Message)
			}
			rep, ok := res.JSON.(command.UsageReport)
			if !ok || rep.Total.Requests != tt.requests || rep.Total.CostUSD != tt.cost || rep.Threads != tt.threads || rep.Retired != tt.retired {
				t.Errorf("json = %+v", res.JSON)
			}
		})
	}
	if _, err := reg.Invoke(context.Background(), command.Context{ActiveView: "thread"}, "usage.show", nil); err == nil {
		t.Error("usage.show ran from the GUI; it is the CLI's (the palette has view.usage)")
	}
}
