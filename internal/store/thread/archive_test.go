package thread

import (
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

func TestArchive(t *testing.T) {
	tests := []struct {
		name string
		// setup returns the thread to archive.
		setup      func(e *env) Session
		wantReason string // DisconnectReason after the archive
	}{
		{name: "a connected thread is closed", wantReason: ReasonClosed, setup: func(e *env) Session {
			return e.connected(CreateOptions{Name: "live"})
		}},
		{name: "a pinned connected thread is closed and unpinned", wantReason: ReasonClosed, setup: func(e *env) Session {
			s := e.connected(CreateOptions{Name: "pinned"})
			if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "a disconnected thread is not closed again", wantReason: ReasonExited, setup: func(e *env) Session {
			s := e.connected(CreateOptions{Name: "gone"})
			e.exit(s.ID, 0)
			return e.waitFor(s.ID, "exited", func(s Session) bool { return s.State == StateDisconnected })
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := tt.setup(e)
			mine, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell(s.ID, "r1", e.wt)})
			if err != nil {
				t.Fatal(err)
			}
			other, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell("", "r1", e.wt)})
			if err != nil {
				t.Fatal(err)
			}

			before := time.Now()
			got, err := e.m.Archive(e.ctx(), s.ID, true)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != StateDisconnected || got.DisconnectReason != tt.wantReason || got.Pinned {
				t.Errorf("archived = state %s reason %q pinned %v; want disconnected %q unpinned", got.State, got.DisconnectReason, got.Pinned, tt.wantReason)
			}
			if got.ArchivedAt.Before(before) || got.ArchivedAt.After(time.Now()) {
				t.Errorf("ArchivedAt = %v, want between %v and now", got.ArchivedAt, before)
			}
			if snap, _ := e.m.Snapshot().Session(s.ID); !snap.ArchivedAt.Equal(got.ArchivedAt) {
				t.Errorf("snapshot ArchivedAt = %v, want %v", snap.ArchivedAt, got.ArchivedAt)
			}
			if _, err := e.terms.Get(e.ctx(), mine.ID); !errors.Is(err, terminal.ErrNotFound) {
				t.Errorf("the thread's shell after archive: %v, want gone", err)
			}
			if _, err := e.terms.Get(e.ctx(), other.ID); err != nil {
				t.Errorf("the worktree's shell after archive: %v, want kept", err)
			}

			// Archiving again keeps the first time.
			again, err := e.m.Archive(e.ctx(), s.ID, true)
			if err != nil || !again.ArchivedAt.Equal(got.ArchivedAt) {
				t.Errorf("archive again = %v, %v; want ArchivedAt kept at %v", again.ArchivedAt, err, got.ArchivedAt)
			}
		})
	}
}

func TestArchiveUnknown(t *testing.T) {
	e := newEnv(t)
	for _, archived := range []bool{true, false} {
		if _, err := e.m.Archive(e.ctx(), "s-nope", archived); !errors.Is(err, ErrNotFound) {
			t.Errorf("Archive(%v) unknown: %v", archived, err)
		}
	}
}

// archived returns a disconnected, archived thread.
func (e *env) archived() Session {
	e.t.Helper()
	s := e.connected(CreateOptions{Name: "archived"})
	got, err := e.m.Archive(e.ctx(), s.ID, true)
	if err != nil || got.ArchivedAt.IsZero() {
		e.t.Fatalf("Archive = %+v, %v", got, err)
	}
	return got
}

func TestUnarchive(t *testing.T) {
	tests := []struct {
		name string
		// act unarchives thread id one way and returns the thread afterwards.
		act       func(e *env, id string) Session
		wantState State
	}{
		{name: "archive false only clears it", wantState: StateDisconnected, act: func(e *env, id string) Session {
			s, err := e.m.Archive(e.ctx(), id, false)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "reconnect", wantState: StateConnected, act: func(e *env, id string) Session {
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "connected", func(s Session) bool { return s.State == StateConnected })
		}},
		{name: "pin", wantState: StateDisconnected, act: func(e *env, id string) Session {
			s, err := e.m.Pin(e.ctx(), id, true)
			if err != nil || !s.Pinned {
				e.t.Fatalf("Pin = %+v, %v", s, err)
			}
			return s
		}},
		{name: "send", wantState: StateConnected, act: func(e *env, id string) Session {
			// Archive only commits on a disconnected thread; a live archived one is
			// what a send would meet after a race, so mark it by hand.
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			e.waitFor(id, "connected", func(s Session) bool { return s.State == StateConnected && s.Status != StatusUnknown })
			e.m.mu.Lock()
			e.m.recs[id].s.ArchivedAt = time.Now()
			e.m.mu.Unlock()
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "again"}); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "unarchived", func(s Session) bool { return s.ArchivedAt.IsZero() })
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.archived()
			got := tt.act(e, s.ID)
			if !got.ArchivedAt.IsZero() || got.State != tt.wantState {
				t.Errorf("after %s: ArchivedAt %v state %s; want unarchived, %s", tt.name, got.ArchivedAt, got.State, tt.wantState)
			}
			// Persisted: a restart still has it unarchived.
			e.restart()
			if got, err := e.m.Get(e.ctx(), s.ID); err != nil || !got.ArchivedAt.IsZero() {
				t.Errorf("after restart = %v, %v; want unarchived", got.ArchivedAt, err)
			}
		})
	}
}

func TestUnpinDoesNotUnarchive(t *testing.T) {
	e := newEnv(t)
	s := e.archived()
	got, err := e.m.Pin(e.ctx(), s.ID, false)
	if err != nil || !got.ArchivedAt.Equal(s.ArchivedAt) {
		t.Errorf("Pin(false) = %v, %v; want still archived at %v", got.ArchivedAt, err, s.ArchivedAt)
	}
}

func TestArchivedAtPersistsAcrossRestart(t *testing.T) {
	e := newEnv(t)
	s := e.archived()
	e.restart()
	got, err := e.m.Get(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ArchivedAt.UnixMilli() != s.ArchivedAt.UnixMilli() || got.Pinned || got.State != StateDisconnected {
		t.Errorf("after restart = ArchivedAt %v pinned %v state %s; want %v, unpinned, disconnected",
			got.ArchivedAt, got.Pinned, got.State, s.ArchivedAt)
	}
}
