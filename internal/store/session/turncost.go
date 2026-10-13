package session

import (
	"bytes"
	"encoding/json"
)

// turnCosts gives each turn of a thread its own cost. Claude's result carries
// only running totals (total_cost_usd and modelUsage) for the process, so a turn's cost
// is the difference from the previous result of the same process. A process's first
// result is measured from what the process started with: zero for a new conversation;
// on --resume (an effort restart, a Reconnect, a fork, a daemon restart) Claude restores
// the totals of the last "cost-state" record in the resumed transcript (written when a
// process exits cleanly; a killed process writes none, so the restore can be older than
// the thread's last turn end) and keeps adding to them. The daemon reads that record at
// spawn (restoredTotals). When the first result does not fit it, or nothing could be
// read, the turn's cost is unknown: no number beats a wrong one.
type turnCosts struct {
	// cur is this process's totals at its last result.
	cur runningTotals
	// base is what this process started from; not known when the transcript could not
	// be read.
	base runningTotals
	// prev is the previous process's totals at its last result (this thread's last
	// turn end for a new runner), a check on a base of zero.
	prev runningTotals
}

// runningTotals are a process's totals: total_cost_usd and its modelUsage output tokens.
type runningTotals struct {
	known bool
	cost  float64
	out   int64
}

// start begins a new process that starts from base (restoredTotals).
func (c *turnCosts) start(base runningTotals) {
	if c.cur.known {
		c.prev = c.cur
	}
	c.cur, c.base = runningTotals{}, base
}

// seed records the previous process's totals from a thread's last turn end (a runner
// starting on an existing thread).
func (c *turnCosts) seed(t *TurnEnd) {
	if t != nil && t.CostUSD > 0 {
		c.prev = runningTotals{known: true, cost: t.CostUSD, out: t.ProcessOutputTokens}
	}
}

// turn records a result's totals and returns that turn's cost, nil when it cannot be
// told. total is total_cost_usd, out the process's output tokens (modelUsage, 0 when
// absent) and turnOut the turn's own (usage). A result without a total (an interrupt
// can report 0) is unknown and moves nothing: what it spent shows in the next turn's.
func (c *turnCosts) turn(total float64, out, turnOut int64) *float64 {
	if total <= 0 {
		return nil
	}
	from, ok := c.from(total, out, turnOut)
	c.cur = runningTotals{known: true, cost: total, out: out}
	if !ok {
		return nil
	}
	cost := total - from
	return &cost
}

// from is the total this result's turn is measured from.
func (c *turnCosts) from(total float64, out, turnOut int64) (float64, bool) {
	switch {
	case c.cur.known:
		// Within a process the totals only grow; a drop is a reset Claude did not say
		// when it happened.
		return c.cur.cost, total >= c.cur.cost
	case !c.base.known:
		return 0, false
	case total < c.base.cost || (out > 0 && out < c.base.out):
		// Claude did not restore what the transcript said.
		return 0, false
	case c.base.cost == 0 && c.prev.known && c.prev.out > 0 && out >= c.prev.out+turnOut && total >= c.prev.cost:
		// Nothing to restore by the transcript, yet the totals continue the previous
		// process's: Claude kept them somewhere the daemon does not read.
		return 0, false
	}
	return c.base.cost, true
}

// costStateMarker picks the transcript lines worth decoding.
var costStateMarker = []byte(`"type":"cost-state"`)

// restoredTotals is what a process started with l in cwd starts from: zero for a new
// conversation, the resumed transcript's last cost-state record on --resume (zero when
// it has none). Not known when the transcript cannot be read.
func restoredTotals(paths ClaudePaths, cwd string, l launch) runningTotals {
	if l.resume == "" {
		return runningTotals{known: true}
	}
	path, ok := paths.transcriptPath(cwd, l.resume)
	if !ok {
		return runningTotals{}
	}
	last := runningTotals{known: true}
	err := scanLines(path, 0, func(line []byte) {
		if !bytes.Contains(line, costStateMarker) {
			return
		}
		var rec struct {
			Type         string  `json:"type"`
			TotalCostUSD float64 `json:"totalCostUSD"`
			ModelUsage   map[string]struct {
				OutputTokens int64 `json:"outputTokens"`
			} `json:"modelUsage"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Type != "cost-state" {
			return
		}
		last = runningTotals{known: true, cost: rec.TotalCostUSD}
		for _, u := range rec.ModelUsage {
			last.out += u.OutputTokens
		}
	})
	if err != nil {
		return runningTotals{}
	}
	return last
}
