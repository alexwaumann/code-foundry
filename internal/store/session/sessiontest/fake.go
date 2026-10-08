// Package sessiontest provides an in-memory session.Store for tests of code that
// consumes sessions (API handlers, commands, the events stream). No processes are
// involved: tests drive state changes with Put.
package sessiontest

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// Fake implements session.Store. Every mutation publishes the same events as the real
// store on its bus.
type Fake struct {
	bus *bus.Bus
	// Now is the clock used for CreatedAt.
	Now func() time.Time
	// Err, when set, is returned by every mutating method.
	Err error

	mu    sync.Mutex
	next  int
	byID  map[string]session.Session
	snap  *session.Snapshot
	calls []string
}

var _ session.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, Now: time.Now, byID: map[string]session.Session{}, snap: &session.Snapshot{}}
}

// Bus returns the bus the fake publishes on.
func (f *Fake) Bus() *bus.Bus { return f.bus }

// Calls returns the recorded method calls, e.g. "Create /w opus high", "Close s-1".
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Put inserts or replaces a session and publishes Updated.
func (f *Fake) Put(s session.Session) {
	f.mu.Lock()
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
}

func (f *Fake) rebuild() {
	out := make([]session.Session, 0, len(f.byID))
	for _, s := range f.byID {
		out = append(out, s)
	}
	slices.SortFunc(out, func(a, b session.Session) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	f.snap = &session.Snapshot{Sessions: out}
}

func (f *Fake) record(call string) error {
	f.calls = append(f.calls, call)
	return f.Err
}

func (f *Fake) get(id string) (session.Session, error) {
	s, ok := f.byID[id]
	if !ok {
		return session.Session{}, fmt.Errorf("%w: %s", session.ErrNotFound, id)
	}
	return s, nil
}

// mutate applies fn to session id under the lock and publishes the result.
func (f *Fake) mutate(call, id string, fn func(*session.Session) error) (session.Session, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	s, err := f.get(id)
	if err == nil {
		err = fn(&s)
	}
	if err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	f.byID[id] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
	return s, nil
}

func (f *Fake) add(call string, s session.Session) (session.Session, error) {
	f.mu.Lock()
	if err := f.record(call); err != nil {
		f.mu.Unlock()
		return session.Session{}, err
	}
	f.next++
	s.ID = fmt.Sprintf("s-%d", f.next)
	s.TerminalID = fmt.Sprintf("t-%d", f.next)
	s.State = session.StateStarting
	s.CreatedAt = f.Now()
	s.LastActivityAt = s.CreatedAt
	f.byID[s.ID] = s
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Updated{Session: s})
	return s, nil
}

// Create records the call and adds a STARTING session ("s-N", terminal "t-N").
func (f *Fake) Create(_ context.Context, o session.CreateOptions) (session.Session, error) {
	return f.add(fmt.Sprintf("Create %s %s %s %s", o.RepoID, o.WorktreePath, o.Model, o.Effort), session.Session{
		RepoID: o.RepoID, WorktreePath: o.WorktreePath, Model: o.Model, Effort: o.Effort, Name: o.Name,
	})
}

// Fork adds a STARTING session with ParentID set.
func (f *Fake) Fork(_ context.Context, id, name string) (session.Session, error) {
	f.mu.Lock()
	parent, err := f.get(id)
	f.mu.Unlock()
	if err != nil {
		return session.Session{}, err
	}
	return f.add("Fork "+id, session.Session{
		RepoID: parent.RepoID, WorktreePath: parent.WorktreePath, Model: parent.Model, Effort: parent.Effort,
		Name: name, ParentID: id,
	})
}

// Get returns one session.
func (f *Fake) Get(_ context.Context, id string) (session.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.get(id)
}

// Rename sets the name and clears AutoNamed.
func (f *Fake) Rename(_ context.Context, id, name string) (session.Session, error) {
	return f.mutate("Rename "+id+" "+name, id, func(s *session.Session) error {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("%w: name is empty", session.ErrInvalidArgument)
		}
		s.Name, s.AutoNamed = strings.TrimSpace(name), false
		return nil
	})
}

// Close disconnects the session with reason "closed".
func (f *Fake) Close(_ context.Context, id string) error {
	_, err := f.mutate("Close "+id, id, func(s *session.Session) error {
		if s.State != session.StateDisconnected {
			s.State, s.DisconnectReason, s.TerminalID = session.StateDisconnected, session.ReasonClosed, ""
		}
		return nil
	})
	return err
}

// Reconnect requires DISCONNECTED and moves the session to STARTING.
func (f *Fake) Reconnect(_ context.Context, id string) (session.Session, error) {
	return f.mutate("Reconnect "+id, id, func(s *session.Session) error {
		if s.State != session.StateDisconnected {
			return fmt.Errorf("%w: session %s is %s", session.ErrFailedPrecondition, id, s.State)
		}
		s.State, s.DisconnectReason, s.TerminalID = session.StateStarting, "", "t-re-"+id
		return nil
	})
}

// Remove forgets a session and publishes Removed.
func (f *Fake) Remove(_ context.Context, id string) error {
	f.mu.Lock()
	if err := f.record("Remove " + id); err != nil {
		f.mu.Unlock()
		return err
	}
	if _, err := f.get(id); err != nil {
		f.mu.Unlock()
		return err
	}
	delete(f.byID, id)
	f.rebuild()
	f.mu.Unlock()
	bus.Publish[session.Event](f.bus, session.Removed{ID: id})
	return nil
}

// Snapshot returns the current snapshot.
func (f *Fake) Snapshot() *session.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}
