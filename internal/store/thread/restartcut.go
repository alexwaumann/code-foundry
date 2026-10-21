package thread

import (
	"context"
	"time"
)

// Turns a daemon stop cut (docs/notes/ember-fixes-2-wakes.md).
//
// A stop (or the daemon's death) leaves a busy thread error "interrupted" and its next
// message starts with the restart note (resumenote.go). Two refinements:
//
//   - A turn that had filed its final report (done, failed or blocked) after its last
//     message finished its work; only its last words were cut. It ends needs attention
//     "finished", with no resume note: shutdown (runner.reportedAtStop) for a clean
//     stop, whose settle wake the stop suppresses and the restart delivers; New
//     (reportedAtLoad) for a daemon that died, whose subscribers the restart tells the
//     same way (planRestartWakes, restartInput.reported).
//   - A thread whose own turn the stop cut gets the restart notice even with no
//     subscriptions of its own, when the turn was the user's (its last message is not a
//     wake) and no one else hears about it (no subscription fires about it): the turn
//     would otherwise sit cut until the user noticed (subscriptions_restart.go).

// reportCoversTurn reports whether rep is a final report (done, failed, blocked) filed
// at or after the last top-level user message in items: the turn it ended had done its
// work. False without a user message.
func reportCoversTurn(rep Report, items []Item) bool {
	if rep.Status == ReportNone || rep.Status == ReportProgress {
		return false
	}
	last, ok := lastUserMessage(items)
	return ok && !rep.At.Before(last.CreatedAt.Truncate(time.Millisecond))
}

// lastUserMessage is the last top-level user message in items.
func lastUserMessage(items []Item) (Item, bool) {
	for i := len(items) - 1; i >= 0; i-- {
		if it := items[i]; it.Kind == KindUserMessage && it.ParentToolUseID == "" {
			return it, true
		}
	}
	return Item{}, false
}

// reportedAtLoad reports whether row s, live when the daemon died and busy then (midTurn),
// had filed its final report after its last message: New loads it finished, not
// interrupted. Its items are read only when the report could qualify.
func reportedAtLoad(ctx context.Context, m *Manager, s Thread) bool {
	if s.Report.Status == ReportNone || s.Report.Status == ReportProgress || s.Status != StatusBusy {
		return false
	}
	items, err := loadItems(ctx, m.opts.DB, s.ID)
	if err != nil {
		m.log.Warn("read the items of a thread the daemon lost", "thread", s.ID, "err", err)
		return false
	}
	return reportCoversTurn(s.Report, items)
}
