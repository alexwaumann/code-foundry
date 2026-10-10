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

	mu     sync.Mutex
	next   int
	staged int
	byID   map[string]session.Session
	snap   *session.Snapshot
	calls  []string
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

// Create records the call and adds a STARTING session ("s-N", terminal "t-N"). With
// NewWorktree the session's worktree is /worktrees/cf-<N> (CreatedWorktree, BaseRef as
// requested). WorkspaceID is copied as is. With NewWorkspace the session belongs to
// workspace "w-new" and runs in /worktrees/<repo>, repo being RepoID or the first repo.
// The call reads "Create <repo> <path> <model> <effort>", then " perm=<n>",
// " new-worktree=<base>", " workspace=<id>", " new-workspace=<a,b>", " prompt=<text>"
// and " attachments=<a,b>" when set.
func (f *Fake) Create(_ context.Context, o session.CreateOptions) (session.Session, error) {
	call := fmt.Sprintf("Create %s %s %s %s", o.RepoID, o.WorktreePath, o.Model, o.Effort)
	s := session.Session{
		RepoID: o.RepoID, WorktreePath: o.WorktreePath, Model: o.Model, Effort: o.Effort, Name: o.Name,
		PermissionMode: o.PermissionMode,
	}
	if o.PermissionMode != session.PermissionDefault {
		call += fmt.Sprintf(" perm=%d", o.PermissionMode)
	}
	if o.NewWorktree != nil {
		call += " new-worktree=" + o.NewWorktree.BaseRef
		f.mu.Lock()
		s.WorktreePath = fmt.Sprintf("/worktrees/cf-%d", f.next+1)
		f.mu.Unlock()
		s.CreatedWorktree, s.BaseRef = true, o.NewWorktree.BaseRef
	}
	if o.WorkspaceID != "" {
		call += " workspace=" + o.WorkspaceID
		s.WorkspaceID = o.WorkspaceID
	}
	if nw := o.NewWorkspace; nw != nil && len(nw.Repos) > 0 {
		call += " new-workspace=" + strings.Join(nw.Repos, ",")
		s.RepoID = o.RepoID
		if s.RepoID == "" {
			s.RepoID = nw.Repos[0]
		}
		s.WorkspaceID, s.WorktreePath, s.CreatedWorktree, s.BaseRef = "w-new", "/worktrees/"+s.RepoID, true, nw.BaseRef
	}
	if o.InitialPrompt != "" {
		call += " prompt=" + o.InitialPrompt
	}
	if len(o.Attachments) > 0 {
		call += " attachments=" + strings.Join(o.Attachments, ",")
	}
	return f.add(call, s)
}

// StageAttachment records "StageAttachment <name> <mime> <len>" and returns
// /attachments/<N>-<name>.
func (f *Fake) StageAttachment(_ context.Context, name, mimeType string, data []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record(fmt.Sprintf("StageAttachment %s %s %d", name, mimeType, len(data))); err != nil {
		return "", err
	}
	f.staged++
	return fmt.Sprintf("/attachments/%d-%s", f.staged, name), nil
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
		Name: name, ParentID: id, PermissionMode: parent.PermissionMode, WorkspaceID: parent.WorkspaceID,
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

// RunIn records "RunIn <id> <repo> <path>". It requires a workspace thread. A
// disconnected session moves at once to the path (else /worktrees/<repo>); a live one
// gets it as PendingWorktreePath.
func (f *Fake) RunIn(_ context.Context, id string, t session.RunInTarget) (session.Session, error) {
	return f.mutate("RunIn "+id+" "+t.RepoID+" "+t.WorktreePath, id, func(s *session.Session) error {
		if s.WorkspaceID == "" {
			return fmt.Errorf("%w: thread %s does not belong to a workspace", session.ErrFailedPrecondition, id)
		}
		path := t.WorktreePath
		if path == "" {
			path = "/worktrees/" + t.RepoID
		}
		if s.State == session.StateDisconnected {
			s.WorktreePath, s.RepoID = path, t.RepoID
		} else {
			s.PendingWorktreePath = path
		}
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
