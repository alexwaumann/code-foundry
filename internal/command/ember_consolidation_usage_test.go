package command

import (
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

func TestEmberConsolidationLine(t *testing.T) {
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		s    ember.Status
		want string
	}{
		{"none yet", ember.Status{}, ""},
		{"one call", ember.Status{
			LastConsolidationUsage:  ember.ConsolidationUsage{At: at, Calls: 1, InputTokens: 17010, OutputTokens: 800, CostUSD: 0.1234},
			ConsolidationUsageTotal: ember.ConsolidationUsage{At: at, Calls: 1, InputTokens: 17010, OutputTokens: 800, CostUSD: 0.1234},
		}, "consolidation cost: last $0.12 (17.0K in, 800 out), $0.12 over 1 call\n"},
		{"several", ember.Status{
			LastConsolidationUsage:  ember.ConsolidationUsage{At: at, Calls: 1, InputTokens: 900, OutputTokens: 50, CostUSD: 0.004},
			ConsolidationUsageTotal: ember.ConsolidationUsage{At: at, Calls: 3, InputTokens: 40000, OutputTokens: 2000, CostUSD: 0.31},
		}, "consolidation cost: last $0.0040 (900 in, 50 out), $0.31 over 3 calls\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := emberConsolidationView(tt.s)
			if got := emberConsolidationLine(v); got != tt.want {
				t.Errorf("line = %q, want %q", got, tt.want)
			}
			if v != nil && (v.LastAt == nil || !v.LastAt.Equal(at)) {
				t.Errorf("view = %+v", v)
			}
		})
	}
}
