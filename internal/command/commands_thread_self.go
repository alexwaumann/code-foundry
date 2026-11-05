package command

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A thread putting itself away (docs/notes/self-put-away.md). Mid-turn, thread.archive
// and thread.snooze on the thread the CLI runs in wait for the turn's end: closing
// Claude at once would kill the very Bash call that asked, and the request with it.
// The daemon decides (it knows whether a turn runs); these say who asks and what came of it.

// whenTurnEnds is what a deferred put-away's message ends with.
const whenTurnEnds = "when this turn ends"

// askingThread is the thread a CLI call runs in ($CODE_FOUNDRY_THREAD; ActiveView is empty
// only there), "" for the user's own terminal or the GUI.
func askingThread(c Context) string {
	if c.ActiveView != "" {
		return ""
	}
	return c.CallerThreadID
}

// waitsForTurn reports whether this call is s putting itself away mid-turn, which waits
// for the turn's end and so cuts nothing of s off.
func waitsForTurn(c Context, s *v1.Thread) bool {
	return askingThread(c) == s.GetId() && midTurn(s) != ""
}

// Deferred is the --json answer of thread.archive and thread.snooze when the thread
// asked it of itself mid-turn: nothing happened yet.
type Deferred struct {
	Deferred bool   `json:"deferred"`
	ID       string `json:"id"`
	// Action is what the turn's end does: archive, snooze or save.
	Action string `json:"action"`
	// Until is a snooze's wake time (RFC 3339).
	Until string `json:"until,omitempty"`
}

// deferredResult is the answer of a put-away that waits for the turn's end; what says what
// will happen, without when.
func deferredResult(action, what string, s *v1.Thread, until string) Result {
	return Result{Message: what + " " + whenTurnEnds, JSON: Deferred{Deferred: true, ID: s.GetId(), Action: action, Until: until}}
}
