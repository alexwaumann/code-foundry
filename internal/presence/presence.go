// Package presence is whether the user is looking at the app. The daemon derives it
// from the GUI clients holding an EventService.Watch stream (api.Clients is the one
// writer), and any store may read it or follow its changes with no new plumbing
// (docs/notes/alerts-foreground.md). Nothing about it is stored.
package presence

import "sync"

// Kind is how present the GUI is: none, background or foreground. It paces the GitHub
// poll (docs/notes/gh-poll-tiers.md). The order matters: a higher Kind is more present.
type Kind int

const (
	// None: no GUI client is connected (only the CLI, or nothing).
	None Kind = iota
	// Background: GUI clients are connected and every one reports hidden.
	Background
	// Foreground: at least one GUI client is visible.
	Foreground
)

func (k Kind) String() string {
	switch k {
	case None:
		return "none"
	case Background:
		return "background"
	case Foreground:
		return "foreground"
	}
	return "unknown"
}

// State is the daemon's presence at one moment.
type State struct {
	Kind Kind
	// Attended: some GUI client is both visible and focused (its window is key), so
	// the user is looking at the app right now. Attended implies Foreground.
	Attended bool
}

func (s State) String() string {
	if s.Attended {
		return s.Kind.String() + "+attended"
	}
	return s.Kind.String()
}

// Client is what one GUI client last reported about its window.
type Client struct {
	Visible bool
	Focused bool
}

// Of derives the state from the connected GUI clients: Foreground when any is visible,
// Background when some are connected but all are hidden, None without any. Attended
// when one client is visible and focused at once: a focused but hidden window, or the
// visible window of an app that is not active, is not attended.
func Of(clients []Client) State {
	if len(clients) == 0 {
		return State{Kind: None}
	}
	s := State{Kind: Background}
	for _, c := range clients {
		if c.Visible {
			s.Kind = Foreground
			if c.Focused {
				s.Attended = true
			}
		}
	}
	return s
}

// Tracker holds the current State and calls its subscribers on each change.
type Tracker struct {
	// notify serialises Set, so subscribers see the changes one at a time and in order.
	notify sync.Mutex
	// mu guards the fields below. It is never held while a subscriber runs, so a
	// subscriber, or code holding a lock a subscriber takes, may call Current.
	mu    sync.Mutex
	state State
	subs  []*subscriber
}

type subscriber struct{ fn func(from, to State) }

// New returns a tracker in State{Kind: None}.
func New() *Tracker { return &Tracker{} }

// Current returns the state now. Safe from any goroutine and under any lock: it never
// waits on a subscriber.
func (t *Tracker) Current() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

// Subscribe adds fn, called after each change with the old and the new state, in the
// order of subscription and one change at a time. fn runs on the writer's goroutine
// while the writer holds its own lock (api.Clients), so it must not call back into the
// writer; it may call Current, which already returns the new state. The returned
// function removes fn.
func (t *Tracker) Subscribe(fn func(from, to State)) (unsubscribe func()) {
	s := &subscriber{fn: fn}
	t.mu.Lock()
	t.subs = append(t.subs, s)
	t.mu.Unlock()
	return func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		for i, x := range t.subs {
			if x == s {
				// A fresh slice: a Set running now keeps the list it started with.
				t.subs = append(t.subs[:i:i], t.subs[i+1:]...)
				return
			}
		}
	}
}

// Set makes to the current state and, when it differs from the previous one, calls
// every subscriber with both. For the state's one writer (api.Clients).
func (t *Tracker) Set(to State) {
	t.notify.Lock()
	defer t.notify.Unlock()
	t.mu.Lock()
	from := t.state
	t.state = to
	subs := t.subs
	t.mu.Unlock()
	if from == to {
		return
	}
	for _, s := range subs {
		s.fn(from, to)
	}
}
