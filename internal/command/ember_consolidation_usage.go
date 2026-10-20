package command

import (
	"fmt"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// EmberConsolidationView is what Ember's memory consolidations cost (ember.status's
// "consolidation"): the last call and the total since Ember's state began.
type EmberConsolidationView struct {
	LastAt           *time.Time `json:"lastAt,omitempty"`
	LastCostUSD      float64    `json:"lastCostUsd"`
	LastInputTokens  int64      `json:"lastInputTokens"`
	LastOutputTokens int64      `json:"lastOutputTokens"`
	Calls            int        `json:"calls"`
	TotalCostUSD     float64    `json:"totalCostUsd"`
	TotalInput       int64      `json:"totalInputTokens"`
	TotalOutput      int64      `json:"totalOutputTokens"`
}

// emberConsolidationView is s's consolidation usage; nil before any call reported one.
func emberConsolidationView(s ember.Status) *EmberConsolidationView {
	last, total := s.LastConsolidationUsage, s.ConsolidationUsageTotal
	if total.Calls == 0 {
		return nil
	}
	v := &EmberConsolidationView{
		LastCostUSD: last.CostUSD, LastInputTokens: last.InputTokens, LastOutputTokens: last.OutputTokens,
		Calls: total.Calls, TotalCostUSD: total.CostUSD, TotalInput: total.InputTokens, TotalOutput: total.OutputTokens,
	}
	if !last.At.IsZero() {
		at := last.At
		v.LastAt = &at
	}
	return v
}

// emberConsolidationLine is ember.status's line about it: "consolidation cost: last
// $0.12 (17.0K in, 800 out), $0.31 over 3 calls"; "" for none.
func emberConsolidationLine(v *EmberConsolidationView) string {
	if v == nil {
		return ""
	}
	calls := "calls"
	if v.Calls == 1 {
		calls = "call"
	}
	return fmt.Sprintf("consolidation cost: last %s (%s in, %s out), %s over %d %s\n", formatUSD(v.LastCostUSD),
		compactTokens(v.LastInputTokens), compactTokens(v.LastOutputTokens), formatUSD(v.TotalCostUSD), v.Calls, calls)
}
