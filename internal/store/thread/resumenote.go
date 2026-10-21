package thread

import (
	"encoding/json"
	"strings"
	"time"
)

// The resume note (docs/notes/orch-child-context.md). When something other than the
// user stops a thread's turn, Claude only sees Claude Code's own words for it: "[Request
// interrupted by user]", or for a tool call "The user doesn't want to proceed with this
// tool use... STOP", and reads it as a rejection, although its last tool call may have
// run (a commit and push did, E4 of the 2026-10-19 battle test). So the stop leaves a
// note pending on the thread, and the next user message Claude gets, whoever sends it
// (the user, another thread, a wake), starts with one line saying what really happened.
// The note is persisted (threads.resume_note, migration 0036), so a daemon restart keeps
// it, shown on that message's item (Item.Note), and cleared once the message went out
// (runner.sendMessage). A newer stop replaces a pending note.
//
// Causes: the budget stop (budget.go); an interrupt another thread asked for
// (Store.Interrupt with by, the CLI's thread interrupt inside a thread) while the
// thread was mid-turn; the daemon stopping (shutdown) or dying (New) mid-turn; the
// thread's own process dying mid-turn with no one asking (maybeExited: crashed). The
// user's own interrupt (the GUI's button, the CLI outside a thread) leaves none:
// "interrupted by user" is the truth then.

// ResumeCause is what stopped the turn a ResumeNote is about.
type ResumeCause string

// Resume causes.
const (
	ResumeNone      ResumeCause = ""
	ResumeBudget    ResumeCause = "budget"
	ResumeInterrupt ResumeCause = "interrupt"
	ResumeRestart   ResumeCause = "restart"
	// ResumeCrash: the thread's process died mid-turn on its own (status reason
	// ReasonCrashed): no one stopped it.
	ResumeCrash ResumeCause = "crash"
)

// resumeNotePrefix starts every resume note line, as "[code-foundry wake] " starts a
// wake's header.
const resumeNotePrefix = "[code-foundry] "

// ResumeNote is a thread's pending resume note; the zero value is none.
type ResumeNote struct {
	Cause ResumeCause `json:"cause"`
	// BudgetUSD (ResumeBudget) is the limit the stop fired at.
	BudgetUSD float64 `json:"budget_usd,omitempty"`
	// By and ByName (ResumeInterrupt) are the interrupting thread's id and its name at
	// the time ("" when unnamed or gone).
	By     string `json:"by,omitempty"`
	ByName string `json:"by_name,omitempty"`
	// At is when the turn was stopped.
	At time.Time `json:"at"`
}

// Pending reports whether n is a note to send.
func (n ResumeNote) Pending() bool { return n.Cause != ResumeNone }

// Text is the line Claude gets before the message; budget is the thread's budget now
// (the budget note says when it changed). "" for no note or an unknown cause.
func (n ResumeNote) Text(budget float64) string {
	const check = "your last tool call may have run partially, so check its effects before repeating it."
	tail := ", not rejected by anyone; " + check
	var why string
	switch n.Cause {
	case ResumeBudget:
		why = "was stopped by Code Foundry at its " + FormatUSD(n.BudgetUSD) + " spending limit"
		switch {
		case budget == 0:
			why += " (now no limit)"
		case budget != n.BudgetUSD:
			why += " (now " + FormatUSD(budget) + ")"
		}
	case ResumeInterrupt:
		who := n.By
		if n.ByName != "" && n.ByName != n.By {
			who = `"` + n.ByName + `" (` + n.By + `)`
		}
		why = "was interrupted by thread " + who + " through Code Foundry"
	case ResumeRestart:
		why = "was stopped because the Code Foundry app restarted"
	case ResumeCrash:
		why, tail = "ended because its process died (not stopped by anyone)", "; "+check
	default:
		return ""
	}
	return resumeNotePrefix + "Your previous turn " + why + tail
}

// resumeNoteJSON is the resume_note column: "" for none.
func resumeNoteJSON(n ResumeNote) string {
	if !n.Pending() {
		return ""
	}
	b, err := json.Marshal(n)
	if err != nil {
		return "" // a ResumeNote always marshals
	}
	return string(b)
}

// parseResumeNote reads the resume_note column; empty or malformed (hand-edited) is none.
func parseResumeNote(col string) ResumeNote {
	var n ResumeNote
	if col == "" || json.Unmarshal([]byte(col), &n) != nil {
		return ResumeNote{}
	}
	return n
}

// resumeNote is the note line a message to thread id starts with now, and the note it
// was made from (for clearResumeNote once it went out); "" when none is pending.
func (m *Manager) resumeNote(id string) (string, ResumeNote) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || !rec.s.ResumeNote.Pending() {
		return "", ResumeNote{}
	}
	return rec.s.ResumeNote.Text(rec.s.BudgetUSD), rec.s.ResumeNote
}

// setResumeNoteLocked makes n thread rec's pending note (a newer stop replaces an older
// one); the caller commits. Under m.mu.
func setResumeNoteLocked(rec *record, n ResumeNote) {
	rec.s.ResumeNote = n
}

// clearResumeNote clears thread id's pending note once a message carrying it went out,
// unless a newer stop replaced it meanwhile.
func (m *Manager) clearResumeNote(id string, sent ResumeNote) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || !rec.s.ResumeNote.Pending() || !rec.s.ResumeNote.At.Equal(sent.At) || rec.s.ResumeNote.Cause != sent.Cause {
		return
	}
	rec.s.ResumeNote = ResumeNote{}
	m.commitLocked(rec, true)
}

// noteInterrupt leaves an interrupt note on thread id after thread by interrupted its
// turn: only when by is another thread and id was mid-turn (busy, or asking within a
// turn) when the interrupt went out.
func (m *Manager) noteInterrupt(id, by string, midTurn bool) {
	if by == "" || by == id || !midTurn {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	name := ""
	if b, ok := m.recs[by]; ok {
		name = b.s.Name
	}
	setResumeNoteLocked(rec, ResumeNote{Cause: ResumeInterrupt, By: by, ByName: name, At: m.opts.Now()})
	m.commitLocked(rec, true)
	m.log.Info("interrupt note pending", "thread", id, "by", by)
}

// midTurn reports whether s's published status says a turn is running: busy, or a
// request pending (a request is asked within a turn; the reason says so on a row
// loaded from the database too).
func midTurn(s Thread) bool {
	return s.Status == StatusBusy || s.PendingRequestID != "" ||
		(s.Status == StatusNeedsAttention && (strings.HasPrefix(s.StatusReason, "permission: ") || strings.HasPrefix(s.StatusReason, "question: ")))
}
