package thread

import (
	"context"
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// A created thread's turn ends in a report whether or not it filed one
// (docs/notes/wake-final-message.md). Its last message reaches its creator whole in a wake,
// so asking it to summarise itself again in `thread report` bought a second copy, and every
// turn that skipped it read as a stale or missing report. The rows that read reports
// (`thread reports`, Ember's board, the lead hold) still need a word for "this turn ended",
// so the daemon files ReportFinished, with the head of the message as its summary. An
// explicit report for the turn stays: blocked and failed say what prose cannot be read for.

// final reports whether s closes a task: done, failed, blocked, not the daemon's finished.
func (s ReportStatus) final() bool {
	return s == ReportDone || s == ReportFailed || s == ReportBlocked
}

// recordTurnReport files ReportFinished for the created thread whose turn e ended, unless
// the turn was cut (an error, an interrupt) or it reported in that turn.
func (r *runner) recordTurnReport(e *claudestream.Result) {
	if e.IsError || e.Interrupted() {
		return
	}
	s, ok := r.m.Snapshot().Thread(r.id)
	if !ok || s.CreatedBy == "" {
		return
	}
	items, err := r.m.Items(context.Background(), r.id)
	if err != nil {
		r.log().warn("turn report: read the thread's items", "err", err)
		return
	}
	started, _, text := lastTurn(items.Items)
	r.m.update(r.id, true, func(rec *record) { rec.s.Report = turnReport(rec.s.Report, started, text, r.m.opts.Now()) })
}

// turnReport is the report a thread has after a turn that started at started and said text
// last: rep while the thread filed it in that turn, else ReportFinished at now. The daemon's
// own always moves on: a turn Claude starts itself (a background end) has no user message,
// so the last one's time says nothing about it.
func turnReport(rep Report, started time.Time, text string, now time.Time) Report {
	if rep.Status != ReportNone && rep.Status != ReportFinished && !rep.At.Before(started.Truncate(time.Millisecond)) {
		return rep
	}
	return Report{Status: ReportFinished, Summary: oneLine(text, MaxReportSummaryRunes), At: now.Round(0).Truncate(time.Millisecond)}
}
