package thread

import (
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// saved is a disconnected thread saved for later.
func (e *env) saved() Thread {
	e.t.Helper()
	s := e.connected(CreateOptions{Name: "saved"})
	got, err := e.m.SaveForLater(e.ctx(), s.ID)
	if err != nil {
		e.t.Fatal(err)
	}
	return got
}

func TestSaveForLater(t *testing.T) {
	tests := []struct {
		name       string
		setup      func(e *env) Thread
		wantReason string // DisconnectReason after the save
	}{
		{name: "a connected thread is closed", wantReason: ReasonClosed, setup: func(e *env) Thread {
			return e.connected(CreateOptions{Name: "live"})
		}},
		{name: "a pinned thread is unpinned", wantReason: ReasonClosed, setup: func(e *env) Thread {
			s := e.connected(CreateOptions{Name: "pinned"})
			if _, err := e.m.Pin(e.ctx(), s.ID, true); err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "an archived thread is unarchived", wantReason: ReasonClosed, setup: func(e *env) Thread {
			return e.archived()
		}},
		{name: "a timed snooze is replaced", wantReason: ReasonClosed, setup: func(e *env) Thread {
			return e.snoozed()
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := tt.setup(e)
			shell, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell(s.ID, "r1", e.wt)})
			if err != nil {
				t.Fatal(err)
			}

			got, err := e.m.SaveForLater(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.State != StateDisconnected || got.DisconnectReason != tt.wantReason || got.Pinned || !got.ArchivedAt.IsZero() {
				t.Errorf("saved = state %s reason %q pinned %v archived %v; want disconnected %q, unpinned, not archived",
					got.State, got.DisconnectReason, got.Pinned, got.ArchivedAt, tt.wantReason)
			}
			if got.SavedAt.IsZero() || !got.SnoozedUntil.IsZero() || !got.Snoozed() {
				t.Errorf("saved = SavedAt %v SnoozedUntil %v; want SavedAt set and no wake time", got.SavedAt, got.SnoozedUntil)
			}
			if _, err := e.terms.Get(e.ctx(), shell.ID); !errors.Is(err, terminal.ErrNotFound) {
				t.Errorf("the thread's shell after saving: %v, want gone", err)
			}

			e.restart()
			if after, err := e.m.Get(e.ctx(), s.ID); err != nil || after.SavedAt.UnixMilli() != got.SavedAt.UnixMilli() || !after.SnoozedUntil.IsZero() {
				t.Errorf("after restart = SavedAt %v SnoozedUntil %v, %v; want %v, no wake time", after.SavedAt, after.SnoozedUntil, err, got.SavedAt)
			}
		})
	}
}

func TestSaveForLaterKeepsItsTime(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts(time.Hour))
	first := e.saved()
	clk.advance(time.Hour)
	again, err := e.m.SaveForLater(e.ctx(), first.ID)
	if err != nil || !again.SavedAt.Equal(first.SavedAt) {
		t.Errorf("saving again = %v, %v; want the first time %v", again.SavedAt, err, first.SavedAt)
	}
}

func TestSaveForLaterUnknown(t *testing.T) {
	e := newEnv(t)
	if _, err := e.m.SaveForLater(e.ctx(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("SaveForLater(unknown) = %v, want ErrNotFound", err)
	}
}

func TestSavedNeverWakes(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	s := e.saved()
	clk.advance(10 * 365 * 24 * time.Hour)
	e.m.wakeSnoozed()
	check := func(when string) {
		t.Helper()
		got, err := e.m.Get(e.ctx(), s.ID)
		if err != nil || got.SavedAt.IsZero() || got.StatusReason == ReasonSnoozeEnded || got.Status == StatusNeedsAttention {
			t.Errorf("%s = saved %v status %s %q, %v; want still saved, no attention", when, got.SavedAt, got.Status, got.StatusReason, err)
		}
	}
	check("after the check")
	e.restart(clk.opts())
	check("after a restart")
}

func TestSavedClearedBy(t *testing.T) {
	tests := []struct {
		name         string
		act          func(e *env, id string) Thread
		wantState    State
		wantArchived bool
		wantSnoozed  bool
	}{
		{name: "snooze with no time", wantState: StateDisconnected, act: func(e *env, id string) Thread {
			s, err := e.m.Snooze(e.ctx(), id, time.Time{})
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "a timed snooze", wantState: StateDisconnected, wantSnoozed: true, act: func(e *env, id string) Thread {
			s, err := e.m.Snooze(e.ctx(), id, time.Now().Add(time.Hour))
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "reconnect", wantState: StateConnected, act: func(e *env, id string) Thread {
			if _, err := e.m.Reconnect(e.ctx(), id); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "connected", func(s Thread) bool { return s.State == StateConnected })
		}},
		{name: "pin", wantState: StateDisconnected, act: func(e *env, id string) Thread {
			s, err := e.m.Pin(e.ctx(), id, true)
			if err != nil || !s.Pinned {
				e.t.Fatalf("Pin = %+v, %v", s, err)
			}
			return s
		}},
		{name: "archive", wantState: StateDisconnected, wantArchived: true, act: func(e *env, id string) Thread {
			s, err := e.m.Archive(e.ctx(), id, true)
			if err != nil {
				e.t.Fatal(err)
			}
			return s
		}},
		{name: "send", wantState: StateConnected, act: func(e *env, id string) Thread {
			if _, err := e.m.Send(e.ctx(), id, Message{Text: "again"}); err != nil {
				e.t.Fatal(err)
			}
			return e.waitFor(id, "unsaved and connected", func(s Thread) bool { return s.SavedAt.IsZero() && s.State == StateConnected })
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.saved()
			got := tt.act(e, s.ID)
			if !got.SavedAt.IsZero() || got.State != tt.wantState || got.ArchivedAt.IsZero() == tt.wantArchived || got.SnoozedUntil.IsZero() == tt.wantSnoozed {
				t.Errorf("after %s: SavedAt %v SnoozedUntil %v state %s archived %v; want not saved, %s, archived %v, timed %v",
					tt.name, got.SavedAt, got.SnoozedUntil, got.State, got.ArchivedAt, tt.wantState, tt.wantArchived, tt.wantSnoozed)
			}
			if got.StatusReason == ReasonSnoozeEnded {
				t.Errorf("after %s: status %s %q; ending a save must not ask for attention", tt.name, got.Status, got.StatusReason)
			}
			e.restart()
			if after, err := e.m.Get(e.ctx(), s.ID); err != nil || !after.SavedAt.IsZero() {
				t.Errorf("after restart = %v, %v; want not saved", after.SavedAt, err)
			}
		})
	}
}

func TestSaveClearsSnoozeEnded(t *testing.T) {
	clk := newTestClock()
	e := newEnv(t, clk.opts())
	s := e.wokenThread(clk)
	got, err := e.m.SaveForLater(e.ctx(), s.ID)
	if err != nil || got.Status != StatusIdle || got.StatusReason == ReasonSnoozeEnded {
		t.Errorf("saved a woken thread = %s %q, %v; want idle", got.Status, got.StatusReason, err)
	}
}

func TestSnoozedCoversBothForms(t *testing.T) {
	at := time.Unix(1, 0)
	tests := []struct {
		name string
		t    Thread
		want bool
	}{
		{name: "neither"},
		{name: "timed", t: Thread{SnoozedUntil: at}, want: true},
		{name: "saved", t: Thread{SavedAt: at}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.t.Snoozed(); got != tt.want {
				t.Errorf("Snoozed() = %v, want %v", got, tt.want)
			}
		})
	}
}
