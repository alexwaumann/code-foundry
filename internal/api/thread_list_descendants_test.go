package api

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// A List with descendants_of answers the subtree in tree order with each thread's depth
// and the totals; without it neither is set.
func TestThreadListDescendants(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	t0 := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	usage := func(in int64) []thread.UsageBucket {
		return []thread.UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-10-19", Requests: 1, Input: in}}
	}
	fake.Put(thread.Thread{ID: "s-orch", CreatedAt: t0, LastActivityAt: t0.Add(9 * time.Minute), Usage: usage(1_000_000)})
	fake.Put(thread.Thread{ID: "s-lead", CreatedAt: t0.Add(time.Minute), CreatedBy: "s-orch", Usage: usage(2_000_000)})
	fake.Put(thread.Thread{ID: "s-w1", CreatedAt: t0.Add(2 * time.Minute), LastActivityAt: t0.Add(8 * time.Minute), CreatedBy: "s-lead"})
	fake.Put(thread.Thread{ID: "s-x", CreatedAt: t0, LastActivityAt: t0.Add(time.Hour)})
	h := NewThread(fake, b)
	res, err := h.List(context.Background(), connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{DescendantsOf: "s-orch"}}))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	var cost float64
	for _, s := range res.Msg.GetThreads() {
		if s.Depth == nil {
			t.Errorf("%s has no depth", s.GetId())
		}
		got = append(got, fmt.Sprintf("%s@%d", s.GetId(), s.GetDepth()))
		cost += s.GetCostUsd()
	}
	if want := []string{"s-orch@0", "s-lead@1", "s-w1@2"}; !slices.Equal(got, want) {
		t.Errorf("threads = %v, want %v", got, want)
	}
	tot := res.Msg.GetTotals()
	if tot.GetThreads() != 3 || cost == 0 || tot.GetCostUsd() != cost {
		t.Errorf("totals = %v, want 3 threads and $%v", tot, cost)
	}
	plain, err := h.List(context.Background(), connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{}}))
	if err != nil {
		t.Fatal(err)
	}
	if plain.Msg.GetTotals() != nil || plain.Msg.GetThreads()[0].Depth != nil {
		t.Errorf("a List without descendants_of has totals %v or a depth", plain.Msg.GetTotals())
	}
}
