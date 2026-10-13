package session

import (
	"strconv"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// streamStatus is a thread's status: it follows the stream, never a screen (decision 8
// of the rendered threads handoff).
//
//   - Unknown "starting" until the initialize handshake succeeds.
//   - Busy "working" from a send (or a turn Claude starts itself: a background task's
//     notification) until the result that leaves no queued turn; "compacting" while
//     compacting.
//   - NeedsAttention "permission: <tool> <what>" or "question: <question>" while a
//     can_use_tool request is pending (the oldest first), whatever else is going on.
//   - After a turn: NeedsAttention "finished" until seen (Acknowledge: a viewer is
//     watching the items), "error: <code>" when the turn failed, then Idle "at
//     prompt". An interrupted turn is seen: the user stopped it.
//
// The runner feeds it; all methods run on the runner goroutine. The GUI classifies the
// reasons by prefix ("permission:", "question:", "finished", "error:"): keep them.
type streamStatus struct {
	started    bool
	busy       bool
	compacting bool
	pending    []pendingReason
	unseen     bool
	turnError  string
}

type pendingReason struct{ id, reason string }

// Status returns the current status and its reason.
func (d *streamStatus) Status() (Status, string) {
	switch {
	case !d.started:
		return StatusUnknown, "starting"
	case len(d.pending) > 0:
		return StatusNeedsAttention, d.pending[0].reason
	case d.compacting:
		return StatusBusy, "compacting"
	case d.busy:
		return StatusBusy, "working"
	case d.unseen && d.turnError != "":
		return StatusNeedsAttention, "error: " + d.turnError
	case d.unseen:
		return StatusNeedsAttention, "finished"
	}
	return StatusIdle, "at prompt"
}

// Acknowledge clears "finished" (and a turn error): the user has seen it.
func (d *streamStatus) Acknowledge() { d.unseen, d.turnError = false, "" }

// AtPrompt: idle with nothing pending, so a RunIn move may happen (runin.go).
func (d *streamStatus) AtPrompt() bool {
	return d.started && !d.busy && !d.compacting && len(d.pending) == 0
}

func (d *streamStatus) initialized() { d.started = true }

// sent: a user message went to Claude.
func (d *streamStatus) sent() { d.busy = true }

// event follows the stream.
func (d *streamStatus) event(ev claudestream.Event) {
	switch e := ev.(type) {
	case *claudestream.Status:
		if e.Status != nil {
			switch *e.Status {
			case "requesting":
				d.busy = true
			case "compacting":
				d.compacting = true
			}
		} else {
			// status null ends the announced phase (a compaction's carries
			// compact_result success|failed); busy itself ends with the result.
			d.compacting = false
		}
	case *claudestream.CommandLifecycle:
		if e.State == "started" {
			d.busy = true
		}
	case *claudestream.Result:
		if e.QueuedTurnCount > 0 {
			return
		}
		d.busy, d.compacting = false, false
		switch {
		case e.Interrupted():
			d.unseen, d.turnError = false, ""
		case e.IsError:
			d.unseen, d.turnError = true, resultErrorCode(e)
		default:
			d.unseen, d.turnError = true, ""
		}
	}
}

func resultErrorCode(r *claudestream.Result) string {
	if r.APIErrorStatus != nil && *r.APIErrorStatus != 0 {
		return strconv.Itoa(*r.APIErrorStatus)
	}
	if r.Subtype != "" && r.Subtype != "success" {
		return r.Subtype
	}
	return "error"
}

// ask adds a pending request; its reason is what the status says while it is the
// oldest one.
func (d *streamStatus) ask(id string, it Item) {
	reason := "permission: " + requestSummary(it)
	if it.Kind == KindQuestion {
		reason = "question: " + requestSummary(it)
	}
	d.pending = append(d.pending, pendingReason{id: id, reason: reason})
}

// resolved removes a request (answered, withdrawn, or the process ended).
func (d *streamStatus) resolved(id string) {
	for i, p := range d.pending {
		if p.id == id {
			d.pending = append(d.pending[:i:i], d.pending[i+1:]...)
			return
		}
	}
}
