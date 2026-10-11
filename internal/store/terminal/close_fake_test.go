package terminal_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
)

// stubborn is a store whose Kill does nothing: the process never exits.
type stubborn struct{ *terminaltest.Fake }

func (stubborn) Kill(context.Context, string) error { return nil }

// removing is a store whose Kill exits the terminal and removes it straight away, as
// the daemon's shell reaper does with an exited shell.
type removing struct{ *terminaltest.Fake }

func (r removing) Kill(ctx context.Context, id string) error {
	if err := r.Fake.Kill(ctx, id); err != nil {
		return err
	}
	return r.Remove(ctx, id)
}

func TestKillAndRemove(t *testing.T) {
	tests := []struct {
		name     string
		store    func(*terminaltest.Fake) terminal.Store
		exited   bool // the terminal has exited before the call
		id       string
		timeout  time.Duration
		wantErr  error
		wantGone bool
	}{
		{name: "running", wantGone: true},
		{name: "exited", exited: true, wantGone: true},
		{name: "removed meanwhile", store: func(f *terminaltest.Fake) terminal.Store { return removing{f} }, wantGone: true},
		{name: "unknown", id: "nope", wantErr: terminal.ErrNotFound},
		{name: "never exits", store: func(f *terminaltest.Fake) terminal.Store { return stubborn{f} },
			timeout: 50 * time.Millisecond, wantErr: context.DeadlineExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := terminaltest.New(bus.New())
			var s terminal.Store = f
			if tt.store != nil {
				s = tt.store(f)
			}
			term, err := f.Create(t.Context(), terminal.Spec{Argv: []string{"sh"}})
			if err != nil {
				t.Fatal(err)
			}
			if tt.exited {
				if err := f.Exit(term.ID, 0); err != nil {
					t.Fatal(err)
				}
			}
			id := term.ID
			if tt.id != "" {
				id = tt.id
			}
			ctx := t.Context()
			if tt.timeout > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tt.timeout)
				defer cancel()
			}
			err = terminal.KillAndRemove(ctx, s, id)
			if !errors.Is(err, tt.wantErr) || (tt.wantErr == nil && err != nil) {
				t.Fatalf("KillAndRemove = %v, want %v", err, tt.wantErr)
			}
			_, gerr := f.Get(t.Context(), term.ID)
			if gone := errors.Is(gerr, terminal.ErrNotFound); gone != tt.wantGone {
				t.Errorf("terminal gone = %v, want %v", gone, tt.wantGone)
			}
		})
	}
}

func TestKillAndRemoveWhere(t *testing.T) {
	f := terminaltest.New(bus.New())
	var ids []string
	for _, l := range []map[string]string{{"x": "1"}, {"x": "2"}, {"x": "1"}} {
		term, err := f.Create(t.Context(), terminal.Spec{Argv: []string{"sh"}, Labels: l})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, term.ID)
	}
	n, err := terminal.KillAndRemoveWhere(t.Context(), f, func(t terminal.Terminal) bool { return t.Labels["x"] == "1" })
	if err != nil || n != 2 {
		t.Fatalf("KillAndRemoveWhere = %d, %v; want 2, nil", n, err)
	}
	var left []string
	for _, term := range f.List(t.Context()) {
		left = append(left, term.ID)
	}
	if !slices.Equal(left, ids[1:2]) {
		t.Errorf("left = %v, want %v", left, ids[1:2])
	}
}
