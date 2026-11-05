package thread

import (
	"context"
	"fmt"
)

// Compact (docs/notes/compact-button.md): thread.compact, behind the composer's chip and
// the thread info card's row. It is a typed /compact, with three differences:
//
//   - Refused unless Claude is at its prompt. A typed /compact queues behind the turn, but
//     an action the user pressed must not, and a double press must not compact twice: the
//     runner decides, on its goroutine, so nothing slips between a check and the send.
//   - The item's SentBy is the thread itself: the user did not type it, so prompt history
//     leaves it out (prompts.go). Nothing shows SentBy, so the timeline is a typed
//     /compact's.
//   - Nothing goes before it. A resume note, a reseed's prefix or a changed app memory
//     would turn it into plain text for Claude to answer. They wait for the next message.

// compactCommand is what Claude gets.
const compactCommand = "/compact"

// Compact implements Store.
func (m *Manager) Compact(ctx context.Context, id string) (Item, error) {
	log, err := m.thread(ctx, id)
	if err != nil {
		return Item{}, err
	}
	t, err := m.Get(ctx, id)
	if err != nil {
		return Item{}, err
	}
	if t.setupUnfinished() {
		return Item{}, setupRefusal(t, "compacted")
	}
	if !log.hasUserMessage() {
		return Item{}, fmt.Errorf("%w: thread %s has no conversation to compact yet", ErrFailedPrecondition, id)
	}
	return m.Send(ctx, id, Message{Text: compactCommand, ByThreadID: id, compact: true})
}

// compactHold is why Claude cannot take a /compact now, as the rest of "thread s-1 …";
// "" when it is at its prompt. Runs on the runner goroutine.
func (st *streamState) compactHold() string {
	switch {
	case !st.initialized:
		return "is starting"
	case st.restart != restartNone || st.wantRestart:
		return "is restarting"
	case st.sd.compacting:
		return "is already compacting"
	case len(st.pending) > 0:
		return "is waiting for an answer"
	case st.sd.busy:
		return "is in the middle of a turn"
	}
	return ""
}

// compactRefusal is Compact's error for a thread held by hold (compactHold).
func compactRefusal(id, hold string) error {
	return fmt.Errorf("%w: thread %s %s; compact it once Claude is back at its prompt", ErrFailedPrecondition, id, hold)
}
