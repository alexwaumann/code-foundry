package thread

import (
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

func TestTurnCosts(t *testing.T) {
	type step struct {
		start        *runningTotals // a new process starting from this base first
		total        float64
		out, turnOut int64
		want         *float64 // nil: unknown
	}
	fresh := &runningTotals{known: true}
	base := func(cost float64, out int64) *runningTotals { return &runningTotals{known: true, cost: cost, out: out} }
	// Totals from live haiku runs (2.1.296) on one conversation: two turns (the first
	// carries the title call's tokens in modelUsage), a --resume after a clean exit, a
	// --resume that was then killed (no cost-state written), a --resume after it (Claude
	// restored the older record), a --fork-session of it (Claude restored the parent's).
	tests := []struct {
		name  string
		seed  *TurnEnd // the log's last turn end (a runner starting on an existing thread)
		base  runningTotals
		steps []step
	}{
		{"fresh process, two turns in a row", nil, *fresh, []step{
			{total: 0.00222269, out: 17, turnOut: 3, want: new(0.00222269)},
			{total: 0.00417179, out: 20, turnOut: 3, want: new(0.0019491)},
		}},
		{"resume restoring the totals (effort restart after a clean exit)", nil, *fresh, []step{
			{total: 0.00222269, out: 17, turnOut: 3, want: new(0.00222269)},
			{total: 0.00417179, out: 20, turnOut: 3, want: new(0.0019491)},
			{start: base(0.00417179, 20), total: 0.00487935, out: 23, turnOut: 3, want: new(0.00070756)},
			{total: 0.00528018, out: 26, turnOut: 3, want: new(0.00040083)},
		}},
		{"resume after a killed process: Claude restores the older record", &TurnEnd{CostUSD: 0.00528018, ProcessOutputTokens: 26},
			*base(0.00487935, 23), []step{
				{total: 0.00520246, out: 26, turnOut: 3, want: new(0.00032311)},
			}},
		{"fork: Claude restores the parent's totals, the fork's log is empty", nil, *base(0.00520246, 26), []step{
			{total: 0.00553038, out: 30, turnOut: 4, want: new(0.00032792)},
		}},
		{"resume with a fresh total (the transcript has no cost-state)", &TurnEnd{CostUSD: 0.0027, ProcessOutputTokens: 85}, *fresh, []step{
			{total: 0.0021, out: 17, turnOut: 3, want: new(0.0021)},
			{total: 0.0031, out: 30, turnOut: 13, want: new(0.001)},
		}},
		{"a turn with zero output tokens", nil, *base(0.004, 20), []step{
			{total: 0.0041, out: 20, want: new(0.0001)},
			{total: 0.0042, out: 20, want: new(0.0001)},
		}},
		{"no modelUsage: the totals alone", nil, *base(0.002, 0), []step{
			{total: 0.003, want: new(0.001)},
		}},
		{"restored less than the transcript says: unknown, then measured", nil, *base(0.004, 20), []step{
			{total: 0.002, out: 10, turnOut: 3, want: nil},
			{total: 0.003, out: 13, turnOut: 3, want: new(0.001)},
		}},
		{"fewer output tokens than the transcript's: unknown", nil, *base(0.001, 40), []step{
			{total: 0.002, out: 10, turnOut: 10, want: nil},
		}},
		{"transcript unreadable: unknown, then measured", nil, runningTotals{}, []step{
			{total: 0.005, out: 30, turnOut: 3, want: nil},
			{total: 0.006, out: 33, turnOut: 3, want: new(0.001)},
		}},
		{"nothing to restore, yet the totals continue the previous process's: unknown", &TurnEnd{CostUSD: 0.0027, ProcessOutputTokens: 85}, *fresh, []step{
			{total: 0.0031, out: 90, turnOut: 5, want: nil},
		}},
		{"an interrupt reports no total: unknown, the next turn carries its spend", nil, *fresh, []step{
			{total: 0.002, out: 40, turnOut: 40, want: new(0.002)},
			{total: 0, want: nil},
			{total: 0.005, out: 90, turnOut: 20, want: new(0.003)},
		}},
		{"an interrupted first turn after a restart keeps the base", nil, *fresh, []step{
			{total: 0.002, out: 40, turnOut: 40, want: new(0.002)},
			{start: base(0.002, 40), total: 0, want: nil},
			{total: 0.003, out: 60, turnOut: 20, want: new(0.001)},
		}},
		{"the total going down within a process: unknown, then measured from it", nil, *fresh, []step{
			{total: 0.004, out: 40, turnOut: 40, want: new(0.004)},
			{total: 0.001, out: 10, turnOut: 10, want: nil},
			{total: 0.0015, out: 15, turnOut: 5, want: new(0.0005)},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var c turnCosts
			c.seed(tt.seed)
			c.start(tt.base)
			for i, s := range tt.steps {
				if s.start != nil {
					c.start(*s.start)
				}
				got := c.turn(s.total, s.out, s.turnOut)
				switch {
				case (got == nil) != (s.want == nil):
					t.Errorf("step %d: cost = %v, want %v", i, show(got), show(s.want))
				case got != nil && math.Abs(*got-*s.want) > 1e-12:
					t.Errorf("step %d: cost = %v, want %v", i, *got, *s.want)
				}
			}
		})
	}
}

// TestTurnCostsBounded: whatever Claude reports, a known turn cost is between zero and
// the result's total.
func TestTurnCostsBounded(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		var c turnCosts
		c.seed(&TurnEnd{CostUSD: r.Float64() / 100, ProcessOutputTokens: r.Int64N(100)})
		c.start(runningTotals{known: r.IntN(4) > 0, cost: r.Float64() / 100, out: r.Int64N(100)})
		for range 6 {
			if r.IntN(4) == 0 {
				c.start(runningTotals{known: r.IntN(4) > 0, cost: r.Float64() / 100, out: r.Int64N(100)})
			}
			total := r.Float64()/50 - 0.002
			if got := c.turn(total, r.Int64N(200), r.Int64N(50)); got != nil && (*got < 0 || *got > total) {
				t.Fatalf("cost %v for a total of %v", *got, total)
			}
		}
	}
}

func show(v *float64) string {
	if v == nil {
		return "unknown"
	}
	return fmt.Sprint(*v)
}

func TestRestoredTotals(t *testing.T) {
	dir := t.TempDir()
	paths := ClaudePaths{Dir: dir}
	write := func(id string, lines ...string) {
		t.Helper()
		p := filepath.Join(dir, "projects", "-wt", id+".jsonl")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Captured (2.1.296), trimmed: written when a process exits cleanly.
	costState := func(total float64, out int64) string {
		return fmt.Sprintf(`{"type":"cost-state","sessionId":"b5e6","totalCostUSD":%v,"totalAPIDuration":2633,"startTime":1791786862643,`+
			`"modelUsage":{"claude-haiku-5-5":{"inputTokens":1176,"outputTokens":%d,"cacheReadInputTokens":24899,"costUSD":%v}},"hasUnknownModelCost":false}`, total, out, total)
	}
	write("two", userLine("one"), costState(0.00417179, 20), userLine("two"), costState(0.00487935, 23), userLine("killed"))
	write("none", userLine("hi"), `{"type":"user","message":{"role":"user","content":[{"type":"cost-state"}]}}`)
	for _, tt := range []struct {
		name string
		l    launch
		want runningTotals
	}{
		{"new conversation", launch{newID: "n"}, runningTotals{known: true}},
		{"the last record", launch{resume: "two"}, runningTotals{known: true, cost: 0.00487935, out: 23}},
		{"fork: the parent's", launch{resume: "two", fork: true, newID: "f"}, runningTotals{known: true, cost: 0.00487935, out: 23}},
		{"no record", launch{resume: "none"}, runningTotals{known: true}},
		{"no transcript", launch{resume: "gone"}, runningTotals{}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := restoredTotals(paths, "/wt", tt.l); got != tt.want {
				t.Errorf("restoredTotals = %+v, want %+v", got, tt.want)
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
	check := func(id, model string, cost *float64) {
		t.Helper()
		it, ok := log.get(id)
		if !ok || it.Turn == nil {
			t.Fatalf("%s: %+v", id, it)
		}
		got := it.Turn.TurnCostUSD
		if it.Turn.Model != model || (got == nil) != (cost == nil) || (got != nil && math.Abs(*got-*cost) > 1e-12) {
			t.Errorf("%s: model %q cost %s, want %q %s", id, it.Turn.Model, show(got), model, show(cost))
		}
	}
	p := newProjector(w, runningTotals{known: true})
	turn(p, "claude-haiku-5-5", "claude-sonnet-5", 0.00205823, 44, 44)
	turn(p, "<synthetic>", "", 0.00271594, 85, 41)
	check("turn-r1", "claude-haiku-5-5", new(0.00205823)) // a subagent's model is not the turn's
	check("turn-r2", "", new(0.00065771))                 // a synthetic error message names no model
	if it, _ := log.get("turn-r2"); it.Turn.ProcessOutputTokens != 85 {
		t.Errorf("process output tokens = %d", it.Turn.ProcessOutputTokens)
	}
	// An effort change's restart: Claude restored the totals the transcript records.
	p.restart(runningTotals{known: true, cost: 0.00271594, out: 85})
	turn(p, "claude-haiku-5-5", "", 0.0030561, 90, 5)
	check("turn-r3", "claude-haiku-5-5", new(0.00034016))
	// A reconnect (a new runner on the same log) whose transcript has no cost-state.
	p = newProjector(w, runningTotals{known: true})
	turn(p, "claude-opus-4-8", "", 0.0021, 46, 46)
	check("turn-r4", "claude-opus-4-8", new(0.0021))
	// A reconnect that could not read the transcript: unknown, not a guess.
	p = newProjector(w, runningTotals{})
	turn(p, "claude-opus-4-8", "", 0.0042, 60, 14)
	check("turn-r5", "claude-opus-4-8", nil)
}
