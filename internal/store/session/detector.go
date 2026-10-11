package session

import "time"

// Status is what Claude is doing. Values mirror codefoundry.v1.SessionStatus, so a
// conversion is a cast.
type Status int

// Statuses.
const (
	StatusUnknown Status = iota
	StatusBusy
	StatusIdle
	// StatusNeedsAttention: Claude waits on the user (permission prompt, question,
	// dialog).
	StatusNeedsAttention
	// StatusError: the process ended while Claude was working (reason
	// ReasonInterrupted). Never reported by a detector; set by the store on a
	// disconnect (see disconnectedStatus).
	StatusError
)

func (s Status) String() string {
	switch s {
	case StatusBusy:
		return "busy"
	case StatusIdle:
		return "idle"
	case StatusNeedsAttention:
		return "needs attention"
	case StatusError:
		return "error"
	default:
		return "unknown"
	}
}

// ScreenTextFn returns the session terminal's current screen as plain text (active
// area, one line per row). A detector may call it from any of its methods: they all
// run on the session's runner goroutine, never on the terminal actor.
type ScreenTextFn func() (string, error)

// StatusDetector derives a session's Status from what the session store observes. The
// implementation lives in internal/claudestatus (step 2b). All methods are called from
// one goroutine (the session's runner), so implementations need no locking. None of
// them may block for long: the runner also drives the close sequence.
// A detector may additionally implement Input(data []byte), called with user input
// written to the session terminal, and Acknowledge(), called while someone is viewing
// the session's terminal (see runner.acknowledge); internal/claudestatus uses both to
// clear "finished".
type StatusDetector interface {
	// Output is called with each raw PTY chunk (from the terminal observer hook). The
	// slice is shared and read-only.
	Output(chunk []byte)
	// Transcript is called with each new JSONL line from the session's transcript file
	// (without the trailing newline).
	Transcript(line []byte)
	// Tick is called periodically (1s) so time-based transitions can fire.
	Tick(now time.Time)
	// Status returns the current status and a short human reason ("permission
	// prompt", "esc to interrupt visible").
	Status() (Status, string)
}

// DetectorFactory builds the detector for one connected terminal. The screen
// function is bound to that terminal.
type DetectorFactory func(screen ScreenTextFn) StatusDetector

// NewStubDetector is the default DetectorFactory until 2b's detector is wired: it
// always reports StatusUnknown.
func NewStubDetector(ScreenTextFn) StatusDetector { return stubDetector{} }

type stubDetector struct{}

func (stubDetector) Output([]byte)            {}
func (stubDetector) Transcript([]byte)        {}
func (stubDetector) Tick(time.Time)           {}
func (stubDetector) Status() (Status, string) { return StatusUnknown, "" }
