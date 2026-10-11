package api

import (
	"context"
	"math"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestUsageToProto(t *testing.T) {
	opus := session.UsageBucket{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 2,
		Input: 1_000_000, Output: 1_000_000, CacheRead: 1_000_000, CacheWrite5m: 1_000_000, CacheWrite1h: 1_000_000}
	haikuLong := session.UsageBucket{Model: "claude-haiku-5-5", Tier: "long", Day: "2026-10-09", Requests: 1, Input: 1_000_000}
	unknown := session.UsageBucket{Model: "claude-next-1", Day: "2026-10-10", Requests: 1, Input: 5}
	tests := []struct {
		name     string
		in       []session.UsageBucket
		cost     float64
		unpriced bool
	}{
		{name: "none"},
		{name: "priced", in: []session.UsageBucket{opus, haikuLong}, cost: 4 + 20 + 0.2 + 5 + 8 + 0.5},
		{name: "an unpriced bucket adds nothing and flags the session", in: []session.UsageBucket{opus, unknown},
			cost: 4 + 20 + 0.2 + 5 + 8, unpriced: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, cost, unpriced := usageToProto(tt.in)
			if len(out) != len(tt.in) || !near(cost, tt.cost) || unpriced != tt.unpriced {
				t.Fatalf("usageToProto = %d buckets, %v, %v; want %d, %v, %v", len(out), cost, unpriced, len(tt.in), tt.cost, tt.unpriced)
			}
			for i, p := range out {
				b := tt.in[i]
				if p.GetModel() != b.Model || p.GetTier() != b.Tier || p.GetDay() != b.Day || p.GetRequests() != b.Requests ||
					p.GetInput() != b.Input || p.GetCacheWrite_5M() != b.CacheWrite5m || p.GetCacheWrite_1H() != b.CacheWrite1h {
					t.Errorf("bucket %d = %v; want %+v", i, p, b)
				}
				if p.GetUnpriced() != (b.Model == unknown.Model) || (p.GetUnpriced() && p.GetCostUsd() != 0) {
					t.Errorf("bucket %d priced = %v, %v", i, p.GetCostUsd(), p.GetUnpriced())
				}
				kinds := p.GetInputCostUsd() + p.GetOutputCostUsd() + p.GetCacheReadCostUsd() + p.GetCacheWrite_5MCostUsd() + p.GetCacheWrite_1HCostUsd()
				if !near(kinds, p.GetCostUsd()) {
					t.Errorf("bucket %d per-kind costs sum to %v; cost %v", i, kinds, p.GetCostUsd())
				}
			}
			if tt.name == "priced" {
				// Opus 5.5 at 1M of each kind: input 4, output 20, cache read 0.2, write 5m 5, write 1h 8.
				o := out[0]
				if !near(o.GetInputCostUsd(), 4) || !near(o.GetOutputCostUsd(), 20) || !near(o.GetCacheReadCostUsd(), 0.2) ||
					!near(o.GetCacheWrite_5MCostUsd(), 5) || !near(o.GetCacheWrite_1HCostUsd(), 8) {
					t.Errorf("opus per-kind costs = %v", o)
				}
			}
		})
	}
}

func TestSessionUsageOnTheWire(t *testing.T) {
	fake, c := newSessionServer(t)
	usage := []session.UsageBucket{{Model: "claude-opus-5-5", Day: "2026-10-09", Requests: 1, Output: 1_000_000}}
	fake.Put(session.Session{ID: "s-a", CreatedAt: time.Unix(1, 0), Usage: usage})
	fake.SetRetiredUsage([]session.UsageBucket{{Model: "claude-haiku-5-5", Day: "2026-10-08", Requests: 1, Output: 2_000_000}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	list, err := c.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	s := list.Msg.GetSessions()[0]
	if len(s.GetUsage()) != 1 || !near(s.GetCostUsd(), 20) || s.GetUnpriced() {
		t.Errorf("listed session usage = %v, cost %v, unpriced %v", s.GetUsage(), s.GetCostUsd(), s.GetUnpriced())
	}
	if r := list.Msg.GetRetiredUsage(); len(r) != 1 || !near(r[0].GetCostUsd(), 1) {
		t.Errorf("listed retired = %v", r)
	}

	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchSessionsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || len(stream.Msg().GetSnapshot().GetRetiredUsage()) != 1 {
		t.Fatalf("snapshot = %v (%v)", stream.Msg(), stream.Err())
	}
	if err := fake.Remove(ctx, "s-a"); err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || stream.Msg().GetRemovedId() != "s-a" {
		t.Fatalf("removed = %v (%v)", stream.Msg(), stream.Err())
	}
	if !stream.Receive() {
		t.Fatal(stream.Err())
	}
	retired := stream.Msg().GetRetiredUsage().GetBuckets()
	if len(retired) != 2 || retired[0].GetModel() != "claude-haiku-5-5" || retired[1].GetModel() != "claude-opus-5-5" {
		t.Errorf("retired event = %v", stream.Msg())
	}
}
