package pricing

import (
	"math"
	"testing"
)

func TestLookup(t *testing.T) {
	tests := []struct {
		name               string
		model, tier, speed string
		want               Rate
		ok                 bool
	}{
		{name: "fable 5.1", model: "claude-fable-5-1", ok: true, want: Rate{10, 50, 12.5, 20, 0.25}},
		{name: "fable 5", model: "claude-fable-5", ok: true, want: Rate{10, 50, 12.5, 20, 1}},
		{name: "opus 5.5", model: "claude-opus-5-5", ok: true, want: Rate{4, 20, 5, 8, 0.2}},
		{name: "opus 5", model: "claude-opus-5", ok: true, want: Rate{5, 25, 6.25, 10, 0.5}},
		{name: "opus 4.8", model: "claude-opus-4-8", ok: true, want: Rate{5, 25, 6.25, 10, 0.5}},
		{name: "opus 4.7", model: "claude-opus-4-7", ok: true, want: Rate{5, 25, 6.25, 10, 0.5}},
		{name: "opus 4.6", model: "claude-opus-4-6", ok: true, want: Rate{5, 25, 6.25, 10, 0.5}},
		{name: "sonnet 5.5", model: "claude-sonnet-5-5", ok: true, want: Rate{2, 10, 2.5, 4, 0.1}},
		{name: "sonnet 5", model: "claude-sonnet-5", ok: true, want: Rate{2, 10, 2.5, 4, 0.2}},
		{name: "sonnet 4.6", model: "claude-sonnet-4-6", ok: true, want: Rate{3, 15, 3.75, 6, 0.3}},
		{name: "haiku 5.5", model: "claude-haiku-5-5", ok: true, want: Rate{0.1, 0.5, 0.125, 0.2, 0.01}},
		{name: "haiku 5.5 long", model: "claude-haiku-5-5", tier: TierLong, ok: true, want: Rate{0.5, 2.5, 0.625, 1, 0.05}},
		{name: "haiku 4.5", model: "claude-haiku-4-5", ok: true, want: Rate{1, 5, 1.25, 2, 0.1}},
		{name: "mythos shares fable", model: "claude-mythos-5-1", ok: true, want: Rate{10, 50, 12.5, 20, 0.25}},

		{name: "dated id by prefix", model: "claude-haiku-4-5-20251001", ok: true, want: Rate{1, 5, 1.25, 2, 0.1}},
		{name: "longest prefix wins", model: "claude-opus-5-5-20261001", ok: true, want: Rate{4, 20, 5, 8, 0.2}},
		{name: "context suffix", model: "claude-opus-5[1m]", ok: true, want: Rate{5, 25, 6.25, 10, 0.5}},
		{name: "newer version is not the older row", model: "claude-opus-5-6"},
		{name: "short numeric suffix is not a date", model: "claude-opus-5-2026"},
		{name: "long numeric run is not a date", model: "claude-opus-5-202610011"},
		{name: "unknown model", model: "claude-unknown-1"},
		{name: "synthetic", model: "<synthetic>"},
		{name: "empty", model: ""},

		{name: "fast opus 5.5", model: "claude-opus-5-5", speed: SpeedFast, ok: true, want: Rate{8, 40, 10, 16, 0.4}},
		{name: "fast opus 5", model: "claude-opus-5", speed: SpeedFast, ok: true, want: Rate{10, 50, 12.5, 20, 1}},
		{name: "fast opus 4.8", model: "claude-opus-4-8", speed: SpeedFast, ok: true, want: Rate{10, 50, 12.5, 20, 1}},
		{name: "fast on a model without fast mode", model: "claude-sonnet-5-5", speed: SpeedFast},
		{name: "unknown speed", model: "claude-opus-5-5", speed: "turbo"},
		{name: "long tier on a model without one", model: "claude-opus-5-5", tier: TierLong},
		{name: "unknown tier", model: "claude-haiku-5-5", tier: "huge"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Lookup(tt.model, tt.tier, tt.speed)
			if ok != tt.ok || got != tt.want {
				t.Errorf("Lookup(%q, %q, %q) = %+v, %v; want %+v, %v", tt.model, tt.tier, tt.speed, got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestCost(t *testing.T) {
	tests := []struct {
		name string
		b    Bucket
		want float64
		ok   bool
	}{
		{name: "every counter", ok: true, want: (1e6*4 + 2e6*20 + 3e6*0.2 + 4e6*5 + 5e6*8) / 1e6,
			b: Bucket{Model: "claude-opus-5-5", Input: 1e6, Output: 2e6, CacheRead: 3e6, CacheWrite5m: 4e6, CacheWrite1h: 5e6}},
		{name: "small haiku turn", ok: true, want: (3*0.1 + 12*0.5 + 20000*0.01 + 5000*0.2) / 1e6,
			b: Bucket{Model: "claude-haiku-5-5", Input: 3, Output: 12, CacheRead: 20000, CacheWrite1h: 5000}},
		{name: "empty bucket", ok: true, b: Bucket{Model: "claude-fable-5-1"}},
		{name: "unpriced", b: Bucket{Model: "claude-unknown", Input: 100}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := Cost(tt.b)
			if ok != tt.ok || math.Abs(got-tt.want) > 1e-12 {
				t.Errorf("Cost = %v, %v; want %v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestCostByKind(t *testing.T) {
	tests := []struct {
		name string
		b    Bucket
		want Costs
		ok   bool
	}{
		{name: "every counter", ok: true, want: Costs{Input: 4, Output: 40, CacheRead: 0.6, CacheWrite5m: 20, CacheWrite1h: 40},
			b: Bucket{Model: "claude-opus-5-5", Input: 1e6, Output: 2e6, CacheRead: 3e6, CacheWrite5m: 4e6, CacheWrite1h: 5e6}},
		{name: "small haiku turn", ok: true, want: Costs{Input: 3 * 0.1 / 1e6, Output: 12 * 0.5 / 1e6, CacheRead: 20000 * 0.01 / 1e6, CacheWrite1h: 5000 * 0.2 / 1e6},
			b: Bucket{Model: "claude-haiku-5-5", Input: 3, Output: 12, CacheRead: 20000, CacheWrite1h: 5000}},
		{name: "empty bucket", ok: true, b: Bucket{Model: "claude-fable-5-1"}},
		{name: "unpriced", b: Bucket{Model: "claude-unknown", Input: 100}},
	}
	near := func(a, b float64) bool { return math.Abs(a-b) <= 1e-12 }
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := CostByKind(tt.b)
			if ok != tt.ok || !near(got.Input, tt.want.Input) || !near(got.Output, tt.want.Output) || !near(got.CacheRead, tt.want.CacheRead) ||
				!near(got.CacheWrite5m, tt.want.CacheWrite5m) || !near(got.CacheWrite1h, tt.want.CacheWrite1h) {
				t.Errorf("CostByKind = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
			total, _ := Cost(tt.b)
			if !near(got.Total(), total) {
				t.Errorf("Total = %v; Cost = %v", got.Total(), total)
			}
		})
	}
}

func TestHasLongTier(t *testing.T) {
	for model, want := range map[string]bool{
		"claude-haiku-5-5": true, "claude-haiku-5-5-20261001": true,
		"claude-haiku-4-5": false, "claude-opus-5-5": false, "nope": false,
	} {
		if got := HasLongTier(model); got != want {
			t.Errorf("HasLongTier(%q) = %v; want %v", model, got, want)
		}
	}
}
