package gh

import "time"

// Presence is whether anyone is looking at the GUI, which paces the poll (nextInterval).
// The daemon derives it from the GUI clients connected to EventService.Watch; the store
// reads it through Options.Presence and never keeps it.
type Presence int

const (
	// PresenceNone: no GUI client is connected (only the CLI, or nothing).
	PresenceNone Presence = iota
	// PresenceBackground: GUI clients are connected and every one reports hidden.
	PresenceBackground
	// PresenceForeground: at least one GUI client is visible.
	PresenceForeground
)

func (p Presence) String() string {
	switch p {
	case PresenceNone:
		return "none"
	case PresenceBackground:
		return "background"
	case PresenceForeground:
		return "foreground"
	}
	return "unknown"
}

// tierInterval is the shortest poll interval presence p allows.
func tierInterval(p Presence) time.Duration {
	switch p {
	case PresenceForeground:
		return 0
	case PresenceBackground:
		return DefaultBackgroundInterval
	}
	return DefaultNoGUIInterval
}

// nextInterval is the time from the end of one poll to the start of the next: the
// configured interval (a floor every tier respects), stretched to the presence tier's
// interval, and to idleInterval when nothing is tracked or watched.
func nextInterval(cfg Config, p Presence, idle bool, idleInterval time.Duration) time.Duration {
	d := max(cfg.PollInterval, tierInterval(p))
	if idle {
		d = max(d, idleInterval)
	}
	return d
}

// presence returns the current presence; foreground without Options.Presence. Never
// call it with s.mu held: the daemon's registry calls PresenceChanged with its own lock
// held, and PresenceChanged takes s.mu.
func (s *Store) presence() Presence {
	if s.opts.Presence == nil {
		return PresenceForeground
	}
	return s.opts.Presence()
}

// PresenceChanged tells the store that presence went from one value to another. It
// logs the new tier. When presence rose (a GUI connected, or a window became visible)
// the next poll moves to one new-tier interval after the last poll, which is right away
// (within pollDebounce) when the last poll is older than that, so a client returning
// after a long background stretch sees fresh data at once while one flipping windows
// does not cause extra polls. A fall changes nothing until the next poll schedules
// the one after it.
func (s *Store) PresenceChanged(from, to Presence) {
	if from == to {
		return
	}
	cfg := s.config()
	now := s.opts.Now()
	s.mu.Lock()
	idle := len(s.tracked) == 0 && len(s.watches) == 0 && len(s.prWatches) == 0
	interval := nextInterval(cfg, to, idle, s.opts.IdleInterval)
	soon := false
	if to > from {
		due := s.lastPoll.Add(interval)
		if at := now.Add(pollDebounce); !due.After(at) {
			due, soon = at, true
		}
		if s.pollNext.After(due) {
			s.pollNext = due
		}
	}
	next := s.pollNext.Sub(now)
	s.mu.Unlock()
	s.log.Info("gh poll tier", "from", from.String(), "to", to.String(), "interval", interval.String(),
		"poll_soon", soon, "next_in", max(0, next).Round(time.Second).String())
	if to > from {
		s.nudge()
	}
}

// pollSoon brings the next poll to within pollDebounce and wakes the worker: after a
// write, the dashboards and branch lists are likely to move.
func (s *Store) pollSoon() {
	s.mu.Lock()
	s.pollSoonLocked(s.opts.Now())
	s.mu.Unlock()
	s.nudge()
}
