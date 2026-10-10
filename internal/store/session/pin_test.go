package session

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPinPersistsAcrossRestart(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{RepoID: "r1", Name: "driver"})
	if s.Pinned {
		t.Fatalf("new thread pinned: %+v", s)
	}
	got, err := e.m.Pin(e.ctx(), s.ID, true)
	if err != nil || !got.Pinned {
		t.Fatalf("Pin = %+v, %v", got, err)
	}
	if snap := e.m.Snapshot(); len(snap.Sessions) != 1 || !snap.Sessions[0].Pinned {
		t.Errorf("snapshot after Pin = %+v", snap.Sessions)
	}
	// Pinning again is a no-op.
	if got, err := e.m.Pin(e.ctx(), s.ID, true); err != nil || !got.Pinned {
		t.Errorf("Pin again = %+v, %v", got, err)
	}
	if _, err := e.m.Pin(e.ctx(), "s-nope", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("Pin unknown: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	got, err = e.m.Get(e.ctx(), s.ID)
	if err != nil || !got.Pinned || got.State != StateDisconnected {
		t.Fatalf("after restart = %+v, %v", got, err)
	}
	// A disconnected thread can be unpinned too.
	if got, err := e.m.Pin(e.ctx(), s.ID, false); err != nil || got.Pinned {
		t.Fatalf("Unpin = %+v, %v", got, err)
	}
}
