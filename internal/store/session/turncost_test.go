package session

import (
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestTurnCosts(t *testing.T) {
	type step struct {
		restart      bool
		total        float64
		out, turnOut int64
		want         float64
	}
	// Totals from a live haiku run (2.1.296): two turns, then --resume of the same
	// conversation, which Claude restored the totals for.
	tests := []struct {
		name  string
		seed  *TurnEnd
		steps []step
	}{
		{"one process", nil, []step{
			{total: 0.00205823, out: 44, turnOut: 44, want: 0.00205823},
			{total: 0.00271594, out: 85, turnOut: 41, want: 0.00065771},
		}},
		{"restored after a restart", nil, []step{
			{total: 0.00205823, out: 44, turnOut: 44, want: 0.00205823},
			{total: 0.00271594, out: 85, turnOut: 41, want: 0.00065771},
			{restart: true, total: 0.0030561, out: 90, turnOut: 5, want: 0.00034016},
			{total: 0.0040561, out: 120, turnOut: 30, want: 0.001},
		}},
		{"fresh after a restart", nil, []step{
			{total: 0.0027, out: 85, turnOut: 85, want: 0.0027},
			{restart: true, total: 0.0021, out: 46, turnOut: 46, want: 0.0021},
			{total: 0.0031, out: 60, turnOut: 14, want: 0.001},
		}},
		{"fresh and dearer than the previous process", nil, []step{
			{total: 0.001, out: 10, turnOut: 10, want: 0.001},
			{restart: true, total: 0.05, out: 900, turnOut: 900, want: 0.05},
		}},
		{"restored, seeded from the last turn end (reconnect)", &TurnEnd{CostUSD: 0.00271594, ProcessOutputTokens: 85}, []step{
			{total: 0.0030561, out: 90, turnOut: 5, want: 0.00034016},
		}},
		{"fresh, seeded from the last turn end", &TurnEnd{CostUSD: 0.00271594, ProcessOutputTokens: 85}, []step{
			{total: 0.0020, out: 40, turnOut: 40, want: 0.0020},
		}},
		{"no modelUsage: the total decides", &TurnEnd{CostUSD: 0.002}, []step{
			{total: 0.003, want: 0.001},
		}},
		{"an interrupt reports no total; the next turn carries its spend", nil, []step{
			{total: 0.002, out: 40, turnOut: 40, want: 0.002},
			{total: 0, want: 0},
			{total: 0.005, out: 90, turnOut: 20, want: 0.003},
		}},
		{"an interrupted first turn after a restart keeps the baseline open", nil, []step{
			{total: 0.002, out: 40, turnOut: 40, want: 0.002},
			{restart: true, total: 0, want: 0},
			{total: 0.003, out: 60, turnOut: 20, want: 0.001},
		}},
		{"the total going down within a process starts over", nil, []step{
			{total: 0.004, out: 40, turnOut: 40, want: 0.004},
			{total: 0.001, out: 10, turnOut: 10, want: 0.001},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c turnCosts
			c.resume(tt.seed)
			for i, s := range tt.steps {
				if s.restart {
					c.restart()
				}
				if got := c.turn(s.total, s.out, s.turnOut); math.Abs(got-s.want) > 1e-12 {
					t.Errorf("step %d: cost = %v, want %v", i, got, s.want)
				}
			}
		})
	}
}

func TestProjectTurnCostAndModel(t *testing.T) {
	log := newThreadLog("s", bus.New(), time.Now, nil)
	w := itemWriter{log: log, save: func(Item) {}}
	n := 0
	turn := func(p *projector, model, subModel string, total float64, out, turnOut int64) {
		n++
		lines := []string{
			fmt.Sprintf(`{"type":"assistant","message":{"id":"m%d","model":%q,"role":"assistant","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null}`, n, model),
		}
		if subModel != "" {
			lines = append(lines, fmt.Sprintf(`{"type":"assistant","message":{"id":"s%d","model":%q,"role":"assistant","content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"toolu_agent"}`, n, subModel))
		}
		lines = append(lines, fmt.Sprintf(`{"type":"result","subtype":"success","uuid":"r%d","total_cost_usd":%v,"usage":{"output_tokens":%d},"modelUsage":{"claude-haiku-5-5":{"outputTokens":%d,"costUSD":%v}}}`, n, total, turnOut, out, total))
		for _, l := range lines {
			p.event(claudestream.Parse([]byte(l)))
		}
	}
	check := func(id, model string, cost float64) {
		t.Helper()
		it, ok := log.get(id)
		if !ok || it.Turn == nil || it.Turn.TurnCostUSD == nil {
			t.Fatalf("%s: %+v", id, it)
		}
		if it.Turn.Model != model || math.Abs(*it.Turn.TurnCostUSD-cost) > 1e-12 {
			t.Errorf("%s: model %q cost %v, want %q %v", id, it.Turn.Model, *it.Turn.TurnCostUSD, model, cost)
		}
	}
	p := newProjector(w)
	turn(p, "claude-haiku-5-5", "claude-sonnet-5", 0.00205823, 44, 44)
	turn(p, "<synthetic>", "", 0.00271594, 85, 41)
	check("turn-r1", "claude-haiku-5-5", 0.00205823) // a subagent's model is not the turn's
	check("turn-r2", "", 0.00065771)                 // a synthetic error message names no model
	if it, _ := log.get("turn-r2"); it.Turn.ProcessOutputTokens != 85 {
		t.Errorf("process output tokens = %d", it.Turn.ProcessOutputTokens)
	}
	// An effort change's restart: Claude restored the totals.
	p.restart()
	turn(p, "claude-haiku-5-5", "", 0.0030561, 90, 5)
	check("turn-r3", "claude-haiku-5-5", 0.00034016)
	// A reconnect (a new runner on the same log): fresh totals this time.
	p = newProjector(w)
	turn(p, "claude-opus-4-8", "", 0.0021, 46, 46)
	check("turn-r4", "claude-opus-4-8", 0.0021)
}
