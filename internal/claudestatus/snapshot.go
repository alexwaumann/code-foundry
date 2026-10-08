package claudestatus

import (
	"maps"
	"slices"
	"time"
)

// Snapshot is the Detector's state with the raw signals behind it, for debugging and
// for a details view. It is a copy.
type Snapshot struct {
	Status Status
	Reason string
	Since  time.Time // when Status last changed

	// Output stream.
	Title          string
	TitleKind      string // none, idle, spinner, other
	TitleChangedAt time.Time
	LastOutputAt   time.Time
	RecentChunks   int // output chunks in the last second
	AltScreen      bool
	BracketedPaste bool
	Notification   string // last OSC 9/99/777 notification text
	NotificationAt time.Time
	BellAt         time.Time
	Progress       bool   // OSC 9;4 progress active
	ProgramStatus  string // OSC 7501 state[/kind]

	// Screen (last read).
	Screen       ScreenInfo
	ScreenReadAt time.Time
	ScreenErr    string

	// Transcript.
	TurnActive     bool
	TurnStartedAt  time.Time
	TurnEndedAt    time.Time
	PendingTools   []string
	LastStopReason string
	APIError       string

	// Seen/unseen bookkeeping.
	AcknowledgedAt time.Time
	LastWorkAt     time.Time
	BusyEndedAt    time.Time
}

// Snapshot returns the current state and signals.
func (d *Detector) Snapshot() Snapshot {
	d.mu.Lock()
	defer d.mu.Unlock()
	s := Snapshot{
		Status:         d.status,
		Reason:         d.reason,
		Since:          d.since,
		Title:          d.title,
		TitleKind:      d.tKind.String(),
		TitleChangedAt: d.titleAt,
		LastOutputAt:   d.lastOutputAt,
		RecentChunks:   d.recentChunks(d.lastOutputAt),
		AltScreen:      d.altScreen,
		BracketedPaste: d.bracketedPaste,
		Notification:   d.notifyText,
		NotificationAt: d.notifyAt,
		BellAt:         d.bellAt,
		Progress:       d.progressActive,
		Screen:         d.info,
		ScreenReadAt:   d.screenAt,
		TurnActive:     d.turnActive,
		TurnStartedAt:  d.turnStartAt,
		TurnEndedAt:    d.turnEndAt,
		LastStopReason: d.stopReason,
		APIError:       d.apiError,
		AcknowledgedAt: d.ackAt,
		LastWorkAt:     d.workAt,
		BusyEndedAt:    d.busyEndAt,
	}
	if d.psState != "" {
		s.ProgramStatus = d.psState
		if d.psKind != "" {
			s.ProgramStatus += "/" + d.psKind
		}
	}
	if d.screenErr != nil {
		s.ScreenErr = d.screenErr.Error()
	}
	if len(d.pending) > 0 {
		s.PendingTools = slices.Sorted(maps.Values(d.pending))
	}
	return s
}
