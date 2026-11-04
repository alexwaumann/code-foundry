package search

import (
	"slices"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Activity is what the app shows of agent searches outside the dialog: the sidebar's
// search row (docs/notes/search-sidebar-row.md). It is published on the bus, whole, when
// it changes.
type Activity struct {
	// Running is how many agent searches run now, RunningID the newest of them.
	Running   int
	RunningID string
	// UnseenID is the unseen finished agent search that finished last ("" for none),
	// UnseenStatus how it ended and UnseenHits its hits, as List counts them.
	UnseenID     string
	UnseenStatus Status
	UnseenHits   int
}

// Activity is the state now.
func (s *Store) Activity() Activity {
	var a Activity
	var running, unseen *Entry
	var hits []Hit
	s.mu.Lock()
	for _, e := range s.entries {
		switch {
		case e.Mode != ModeAgent:
		case e.Status == StatusRunning:
			a.Running++
			if running == nil || newestFirst(*e, *running) < 0 {
				running = e
			}
		case e.Unseen && e.Status.Ended():
			if unseen == nil || finishedLast(*e, *unseen) < 0 {
				unseen = e
			}
		}
	}
	if running != nil {
		a.RunningID = running.ID
	}
	if unseen != nil {
		a.UnseenID, a.UnseenStatus = unseen.ID, unseen.Status
		hits = slices.Clone(unseen.Hits)
	}
	s.mu.Unlock()
	if len(hits) > 0 {
		a.UnseenHits = len(liveHits(s.opts.Threads.Snapshot(), hits))
	}
	return a
}

// finishedLast orders the entry that finished last first; a tie goes to the newer search.
func finishedLast(a, b Entry) int {
	if c := b.FinishedAt.Compare(a.FinishedAt); c != 0 {
		return c
	}
	return newestFirst(a, b)
}

// publishActivity publishes the Activity when it differs from the last one published.
// The read and the send are one step under activityMu, so two changes at once cannot
// leave the older state as the last one sent.
func (s *Store) publishActivity() {
	s.activityMu.Lock()
	defer s.activityMu.Unlock()
	a := s.Activity()
	if a == s.activity {
		return
	}
	s.activity = a
	bus.Publish(s.opts.Bus, a)
}
