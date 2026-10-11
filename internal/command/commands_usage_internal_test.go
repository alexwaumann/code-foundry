package command

import (
	"math"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestFormatTokens(t *testing.T) {
	for n, want := range map[int64]string{
		0: "0", 812: "812", 999: "999", 1_000: "1K", 41_234: "41.2K", 999_949: "999.9K",
		1_000_000: "1M", 12_345_678: "12.3M", 1_050_000_000: "1.05B",
	} {
		if got := formatTokens(n); got != want {
			t.Errorf("formatTokens(%d) = %q; want %q", n, got, want)
		}
	}
}

func TestFormatUSD(t *testing.T) {
	for v, want := range map[float64]string{
		0: "$0.00", 0.0015: "$0.0015", 0.01: "$0.01", 45.678: "$45.68", 1234.5: "$1234.50",
	} {
		if got := formatUSD(v); got != want {
			t.Errorf("formatUSD(%v) = %q; want %q", v, got, want)
		}
	}
}

func TestGroupInt(t *testing.T) {
	for n, want := range map[int64]string{0: "0", 999: "999", 1000: "1,000", 1234567: "1,234,567", -1234: "-1,234"} {
		if got := groupInt(n); got != want {
			t.Errorf("groupInt(%d) = %q; want %q", n, got, want)
		}
	}
}

func TestSummarizeUsage(t *testing.T) {
	b := func(day, model, tier string, req, in, out int64, cost float64, unpriced bool) *v1.UsageBucket {
		return &v1.UsageBucket{Day: day, Model: model, Tier: tier, Requests: req, Input: in, Output: out,
			CacheRead: 10, CacheWrite_5M: 1, CacheWrite_1H: 2, CostUsd: cost, Unpriced: unpriced}
	}
	tests := []struct {
		name     string
		in       []*v1.UsageBucket
		models   []string
		total    UsageModel
		shares   []float64
		unpriced []bool
	}{
		{name: "none", total: UsageModel{Model: "TOTAL"}},
		{name: "rows by cost, tiers and days folded into the model",
			in: []*v1.UsageBucket{
				b("2026-10-09", "claude-haiku-5-5", "", 1, 5, 5, 1, false),
				b("2026-10-08", "claude-opus-5-5", "", 2, 1, 1, 2, false),
				b("2026-10-09", "claude-haiku-5-5", "long", 1, 5, 5, 1, false),
				b("2026-10-09", "claude-opus-5-5", "", 1, 1, 1, 4, false),
			},
			models: []string{"claude-opus-5-5", "claude-haiku-5-5"},
			total:  UsageModel{Model: "TOTAL", Requests: 5, Input: 12, Output: 12, CacheRead: 40, CacheWrite5m: 4, CacheWrite1h: 8, Tokens: 76, CostUSD: 8, Share: 1},
			shares: []float64{0.75, 0.25}, unpriced: []bool{false, false}},
		{name: "unpriced model has no share and sorts by tokens",
			in: []*v1.UsageBucket{
				b("2026-10-09", "claude-next", "", 1, 1000, 0, 0, true),
				b("2026-10-09", "claude-opus-5-5", "", 1, 1, 1, 2, false),
			},
			models: []string{"claude-opus-5-5", "claude-next"},
			total:  UsageModel{Model: "TOTAL", Requests: 2, Input: 1001, Output: 1, CacheRead: 20, CacheWrite5m: 2, CacheWrite1h: 4, Tokens: 1028, CostUSD: 2, Share: 1, Unpriced: true},
			shares: []float64{1, 0}, unpriced: []bool{false, true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rep := summarizeUsage(tt.in)
			if rep.Total != tt.total {
				t.Errorf("total = %+v; want %+v", rep.Total, tt.total)
			}
			if len(rep.Models) != len(tt.models) || len(rep.Buckets) != len(tt.in) {
				t.Fatalf("models = %+v, %d buckets", rep.Models, len(rep.Buckets))
			}
			for i, m := range rep.Models {
				if m.Model != tt.models[i] || math.Abs(m.Share-tt.shares[i]) > 1e-9 || m.Unpriced != tt.unpriced[i] {
					t.Errorf("row %d = %+v; want %s share %v unpriced %v", i, m, tt.models[i], tt.shares[i], tt.unpriced[i])
				}
			}
			for i := 1; i < len(rep.Buckets); i++ {
				if rep.Buckets[i-1].Day > rep.Buckets[i].Day {
					t.Errorf("buckets not sorted by day: %+v", rep.Buckets)
				}
			}
		})
	}
}

func TestRenderUsage(t *testing.T) {
	rep := summarizeUsage([]*v1.UsageBucket{
		{Day: "2026-10-10", Model: "claude-haiku-5-5", Requests: 2, Input: 12, Output: 340, CacheRead: 30_100, CacheWrite_1H: 11_400, CostUsd: 0.0026,
			CacheSavingsUsd: 30_100 * (0.1 - 0.01) / 1e6},
		{Day: "2026-10-10", Model: "claude-next", Requests: 1, Input: 5, CostUsd: 0, Unpriced: true},
	})
	want := `Thread s-1 (demo): 3 requests · 41.9K tokens · $0.0026 + unpriced

MODEL             REQUESTS  TOKENS  COST     SHARE
claude-haiku-5-5  2         41.9K   $0.0026  100%
claude-next       1         5       —        —
TOTAL             3         41.9K   $0.0026  100%

Input 17 · Output 340 · Cache read 30,100 · Cache write 5m 0 · Cache write 1h 11,400
Cache savings $0.0027
`
	if got := renderUsage("Thread s-1 (demo)", rep); got != want {
		t.Errorf("renderUsage =\n%s\nwant\n%s", got, want)
	}
	if got := renderUsage("All threads (0)", summarizeUsage(nil)); got != "All threads (0): 0 requests · 0 tokens · $0.00\nNo usage yet.\n" {
		t.Errorf("empty = %q", got)
	}
}

func TestRenderRuns(t *testing.T) {
	runs := usageRuns([]*v1.AgentRun{
		{Id: "a1", Description: "say ok", AgentType: "general-purpose", Model: "haiku", Status: v1.AgentRunStatus_AGENT_RUN_STATUS_CLOSED,
			SpawnDepth: 1, CostUsd: 0.0012, Usage: []*v1.UsageBucket{{Model: "claude-haiku-5-5", Requests: 2, Input: 10, Output: 20, CacheRead: 29_970}}},
		{Id: "a2", Background: true, Status: v1.AgentRunStatus_AGENT_RUN_STATUS_OPEN, SpawnDepth: 2, Unpriced: true,
			Usage: []*v1.UsageBucket{{Model: "claude-next", Requests: 1, Input: 5, Unpriced: true}}},
	})
	if runs[0].Requests != 2 || runs[0].Tokens != 30_000 || runs[0].Status != "closed" || runs[1].Status != "open" || runs[1].SpawnDepth != 2 {
		t.Errorf("usageRuns = %+v", runs)
	}
	want := `
2 agent runs (1 open), included above:

STATUS  RUN              TYPE             MODEL      REQUESTS  TOKENS  COST
closed  say ok           general-purpose  haiku      2         30K     $0.0012
open    a2 (background)  —                inherited  1         5       $0.00 + unpriced
`
	if got := renderRuns(runs); got != want {
		t.Errorf("renderRuns =\n%s\nwant\n%s", got, want)
	}
	if renderRuns(nil) != "" {
		t.Error("no runs should render nothing")
	}
}
