package daemon

import (
	"github.com/awaumann/code-foundry/internal/claudestatus"
	"github.com/awaumann/code-foundry/internal/store/session"
)

// newDetector adapts internal/claudestatus to the session store's detector interface.
// The two Status enums share values with codefoundry.v1.SessionStatus, so the
// conversion is a cast.
func newDetector(screen session.ScreenTextFn) session.StatusDetector {
	return detectorAdapter{claudestatus.New(screen)}
}

type detectorAdapter struct{ *claudestatus.Detector }

func (d detectorAdapter) Status() (session.Status, string) {
	st, reason := d.Detector.Status()
	return session.Status(st), reason
}

// The session store calls these optional methods when present (user input, and a
// viewer attached to the session's terminal); keep them reachable through the adapter.
var _ interface {
	Input([]byte)
	Acknowledge()
} = detectorAdapter{}
