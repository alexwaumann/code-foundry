package ember

import (
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Unclosed tasks (docs/notes/ember-fixes-3-board.md): an open task that waits on Ember
// and on nothing else. Two kinds:
//
//   - a doing task whose worker reported and went idle. A done report is a claim, so the
//     store never closes the task (Ember checks the branch, then runs ember task done, or
//     blocks it), but no wake comes for that worker again;
//   - a parent whose pieces are all closed. The rollup leaves it to Ember (Rolled), which
//     checks the pieces together first.
//
// Either sat "in progress" until the user asked when Ember missed it, so the board says
// such a task waits on Ember, ember task done says so when it closes a parent's last
// piece, and every wake to Ember lists the ones it has not closed yet.

// UnclosedKind is why a task waits on Ember: its worker reported, or its pieces closed.
type UnclosedKind int

const (
	// NotUnclosed: the task does not wait on Ember alone.
	NotUnclosed UnclosedKind = iota
	// UnclosedReport: doing, its worker's report is in and the worker is idle.
	UnclosedReport
	// UnclosedPieces: a parent whose pieces are all done or cancelled, still open.
	UnclosedPieces
)

// Unclosed says whether t (a snapshot's task; tasks the board it is on) waits on Ember:
//
//   - UnclosedReport: t is doing, its worker's report is in (done, failed or blocked: a
//     failed or blocked one normally blocks the task at once, blockFailedLocked) and the
//     worker and its team are idle: nothing works or waits on the user. A snapshot leaves
//     out a report from before the task last changed (staleReport), so a task Ember
//     reopened is not unclosed by its old report. An archived worker counts as idle.
//   - UnclosedPieces: t is open and has subtasks, every one of them done or cancelled.
func Unclosed(t Task, tasks []Task) UnclosedKind {
	if !t.State.Open() {
		return NotUnclosed
	}
	pieces, open := 0, 0
	for _, c := range tasks {
		if c.ParentID == t.ID {
			pieces++
			if c.State.Open() {
				open++
			}
		}
	}
	if pieces > 0 {
		if open == 0 {
			return UnclosedPieces
		}
		return NotUnclosed
	}
	if t.State != StateDoing || t.Thread == nil || t.Thread.Removed {
		return NotUnclosed
	}
	switch t.Thread.Report.Status {
	case thread.ReportDone, thread.ReportFailed, thread.ReportBlocked:
	default:
		return NotUnclosed
	}
	if t.Thread.Working() || t.Thread.WaitsOnUser() {
		return NotUnclosed
	}
	return UnclosedReport
}

// UnclosedWords is how the board says that t waits on Ember: "unclosed: worker reported
// done, waiting for Ember to check", "unclosed: all its pieces are closed, waiting for
// Ember to close it"; "" when it does not.
func UnclosedWords(t Task, tasks []Task) string {
	switch Unclosed(t, tasks) {
	case UnclosedReport:
		return "unclosed: worker reported " + t.Thread.Report.Status.String() + ", waiting for Ember to check"
	case UnclosedPieces:
		return "unclosed: all its pieces are closed, waiting for Ember to close it"
	}
	return ""
}

// UnclosedNote is the paragraph a wake to Ember ends with while tasks are unclosed: one
// line per task (its worker and how long ago it reported, or that its pieces are
// closed); "" when none is. A task whose worker is one of the threads the wake is about
// (about) is left out: the wake itself reports it.
func UnclosedNote(tasks []Task, about []string, now time.Time) string {
	var lines []string
	for _, t := range tasks {
		line := "- " + t.ID + " " + strconv.Quote(t.Title) + " · "
		switch Unclosed(t, tasks) {
		case UnclosedReport:
			if slices.Contains(about, t.ThreadID) {
				continue
			}
			ago := Age(now.Sub(t.Thread.Report.At))
			if ago != "now" {
				ago += " ago"
			}
			line += "worker " + t.ThreadID + " reported " + t.Thread.Report.Status.String() + " " + ago + " and is idle"
		case UnclosedPieces:
			line += "all its pieces are closed"
		default:
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return ""
	}
	head := "[code-foundry ember] Unclosed on your board: open tasks no worker is on and no wake will come for. " +
		"Check each as on a wake, then close it (`code-foundry ember task done <id>`) or block it; if one stays open, say why."
	return head + "\n" + strings.Join(lines, "\n")
}

// ParentToClose is the parent of task id when id's closing left every piece of it
// closed and the parent open (UnclosedPieces); false otherwise.
func (s *Snapshot) ParentToClose(id string) (Task, bool) {
	t, ok := s.Task(id)
	if !ok || t.ParentID == "" {
		return Task{}, false
	}
	p, ok := s.Task(t.ParentID)
	if !ok || Unclosed(p, s.Tasks) != UnclosedPieces {
		return Task{}, false
	}
	return p, true
}

// wakeNote is the resident's wake note (thread.WakeNoteFunc): the unclosed tasks as the
// threads are now (not as last published: the wake may be about a change the store has
// not looked at yet).
func (s *Store) wakeNote(about []string) string {
	threads := s.opts.Threads.Snapshot()
	s.mu.Lock()
	tasks := s.derivedTasksLocked(threads)
	s.mu.Unlock()
	return UnclosedNote(tasks, about, s.opts.Now())
}
