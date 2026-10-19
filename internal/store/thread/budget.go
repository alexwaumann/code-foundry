package thread

import (
	"context"
	"fmt"
)

// The budget stop (docs/notes/agents-2-metadata.md). A thread with a budget (BudgetUSD
// > 0) is interrupted when its cost (UsageCost of its usage, the API's cost_usd)
// reaches the budget while Claude works: the runner checks after every usage publish
// (publishUsage, at most once per transcript poll with a new priced response). It
// interrupts the turn, sets NeedsAttention ReasonBudgetReached and appends a note.
//
// Once per budget value: the stop records the budget it fired for (BudgetHitUSD,
// persisted, so a daemon restart does not fire it again) and fires only while that
// differs from BudgetUSD. SetBudget re-arms it (BudgetHitUSD 0) when the new budget is
// above the cost. Messages can still be sent; a turn over the budget runs to its end
// unless the budget changes.

// ReasonBudgetReached is the StatusReason, with StatusNeedsAttention, of a thread the
// budget stop interrupted. It lasts until the next message or turn, or until seen once
// the interrupted turn ended (streamStatus).
const ReasonBudgetReached = "budget reached"

// budgetNoteText is the note the budget stop appends. Claude itself does not see it: the
// interrupt reaches it as Claude Code's own "The user doesn't want to proceed with this
// tool use" (docs/notes/orch-small-fixes.md), so the note says what really happened.
func budgetNoteText(budget float64) string {
	return "Code Foundry stopped this turn: the spending limit of " + FormatUSD(budget) +
		" was reached; nothing was rejected by the user. Raise it with `code-foundry thread budget`, then send a message to continue."
}

// crossBudget marks the budget stop as fired for thread id when its cost reached its
// budget and the stop has not fired for that budget, under m.mu (SetBudget may race).
// It returns the budget and the cost when it fired.
func (m *Manager) crossBudget(id string) (budget, cost float64, fired bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.BudgetUSD <= 0 || rec.s.BudgetHitUSD == rec.s.BudgetUSD {
		return 0, 0, false
	}
	cost = UsageCost(rec.s.Usage)
	if cost < rec.s.BudgetUSD {
		return 0, 0, false
	}
	rec.s.BudgetHitUSD = rec.s.BudgetUSD
	m.commitLocked(rec, true)
	return rec.s.BudgetUSD, cost, true
}

// checkBudget runs the budget stop after a usage publish: only on a connected thread
// whose Claude works (a turn, a compaction), never while it closes or restarts.
func (r *runner) checkBudget() {
	st := r.st
	if r.closing || r.state != StateConnected || st.restart != restartNone || !(st.sd.busy || st.sd.compacting) {
		return
	}
	budget, cost, fired := r.m.crossBudget(r.id)
	if !fired {
		return
	}
	r.log().info("budget reached; interrupting the turn", "budget_usd", budget, "cost_usd", cost)
	st.sd.budget, st.sd.budgetEnded = true, false
	st.proj.w.add(Item{ID: st.proj.nextID("note"), Kind: KindNote, Text: budgetNoteText(budget)})
	r.checkStatus()
	conn := st.conn
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), streamControlTimeout)
		defer cancel()
		if err := controlErr(conn.Interrupt(ctx)); err != nil {
			r.m.log.Warn("budget stop: interrupt", "thread", r.id, "err", fmt.Errorf("interrupt: %w", err))
		}
	}()
}
