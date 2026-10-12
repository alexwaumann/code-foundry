package session

// turnCosts gives each turn of a rendered thread its own cost. Claude's result carries
// only running totals (total_cost_usd and modelUsage) for the process, so a turn's cost
// is the difference from the previous result of the same process. Across a restart
// (Reconnect, an effort change, a daemon restart) it depends on Claude: a --resume of
// the conversation it last ran in that folder restores that conversation's totals and
// keeps adding to them; otherwise they start from zero. Which one happened shows in
// the first result: restored, its output tokens are the previous process's plus this
// turn's; fresh, just this turn's (plus a subagent's, which only a subagent that wrote
// more than the whole previous process could confuse).
type turnCosts struct {
	cur, prev runningTotals
}

// runningTotals are a process's totals at its last result.
type runningTotals struct {
	known bool
	cost  float64
	out   int64
}

// restart starts a new process: its first result is measured against the old one's.
func (c *turnCosts) restart() {
	if c.cur.known {
		c.prev = c.cur
	}
	c.cur = runningTotals{}
}

// resume seeds the previous process's totals from a thread's last turn end (a runner
// starting on an existing thread).
func (c *turnCosts) resume(t *TurnEnd) {
	if t != nil && t.CostUSD > 0 {
		c.prev = runningTotals{known: true, cost: t.CostUSD, out: t.ProcessOutputTokens}
	}
}

// turn records a result's totals and returns that turn's cost. total is
// total_cost_usd, out the process's output tokens (modelUsage, 0 when absent) and
// turnOut the turn's own (usage). A result without a total (an interrupt can report
// 0) costs nothing here; what it spent shows in the next turn's.
func (c *turnCosts) turn(total float64, out, turnOut int64) float64 {
	if total <= 0 {
		return 0
	}
	base := 0.0
	switch {
	case c.cur.known && total >= c.cur.cost:
		base = c.cur.cost
	case c.cur.known:
		// The total went down within a process: Claude reset it.
	case c.prev.known && c.carriedOver(total, out, turnOut):
		base = c.prev.cost
	}
	c.cur = runningTotals{known: true, cost: total, out: out}
	return max(0, total-base)
}

// carriedOver reports whether a new process's first result continues the previous
// process's totals.
func (c *turnCosts) carriedOver(total float64, out, turnOut int64) bool {
	if out > 0 && c.prev.out > 0 {
		return out >= c.prev.out+turnOut
	}
	return total > c.prev.cost
}
