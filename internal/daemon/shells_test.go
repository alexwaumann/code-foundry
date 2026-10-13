package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestShellReaper(t *testing.T) {
	gone := "/cf-test/src/app/.worktrees/feat" // does not exist: a real removal
	// Owner labels without the shell kind: not terminal.new's, so never reaped.
	owned := map[string]string{termlabel.Session: "s1", termlabel.Worktree: gone}
	worktreeRemoved := func(path string) func(dir string) any {
		return func(dir string) any {
			if path == "%dir" {
				path = dir
			}
			return repo.WorktreeRemoved{RepoID: "r1", Path: path}
		}
	}
	event := func(ev any) func(string) any { return func(string) any { return ev } }
	tests := []struct {
		name string
		// labels of the terminal under test ("%dir": a worktree directory that exists),
		// and whether it has exited before the reaper starts.
		labels       map[string]string
		exitedBefore bool
		// After the reaper started: exit the terminal, or publish event(dir). Neither:
		// the next sweep decides.
		exit     bool
		event    func(dir string) any
		wantGone bool
	}{
		{name: "a shell that exits is removed", labels: termlabel.Shell("", "r1", "%dir"), exit: true, wantGone: true},
		{name: "a thread's shell that exits is removed", labels: termlabel.Shell("s1", "r1", "%dir"), exit: true, wantGone: true},
		{name: "a shell that exited before the start is swept", labels: termlabel.Shell("", "r1", "%dir"), exitedBefore: true, wantGone: true},
		{name: "an owned non-shell terminal that exits stays", labels: owned, exit: true},
		{name: "an unlabelled terminal that exits stays", exit: true},
		{name: "removing its worktree kills and removes a shell", labels: termlabel.Shell("", "r1", gone),
			event: worktreeRemoved(gone), wantGone: true},
		{name: "removing its worktree kills and removes a thread's shell", labels: termlabel.Shell("s1", "r1", gone),
			event: worktreeRemoved(gone), wantGone: true},
		{name: "a removal event while the directory exists (failed refresh) leaves the shell", labels: termlabel.Shell("", "r1", "%dir"),
			event: worktreeRemoved("%dir")},
		{name: "removing another worktree leaves a shell", labels: termlabel.Shell("", "r1", "%dir"), event: worktreeRemoved(gone)},
		{name: "removing its worktree leaves an owned non-shell terminal", labels: owned, event: worktreeRemoved(gone)},
		{name: "unregistering its project kills and removes a shell", labels: termlabel.Shell("s1", "r1", "%dir"),
			event: event(repo.RepoRemoved{ID: "r1"}), wantGone: true},
		{name: "unregistering another project leaves a shell", labels: termlabel.Shell("", "r1", "%dir"), event: event(repo.RepoRemoved{ID: "r2"})},
		{name: "removing its thread kills and removes a shell", labels: termlabel.Shell("s1", "r1", "%dir"),
			event: event(session.Removed{ID: "s1"}), wantGone: true},
		{name: "removing another thread leaves a shell", labels: termlabel.Shell("s1", "r1", "%dir"), event: event(session.Removed{ID: "s2"})},
		{name: "removing its thread leaves an owned non-shell terminal", labels: owned, event: event(session.Removed{ID: "s1"})},
		{name: "the sweep removes a shell whose worktree is gone (missed event)", labels: termlabel.Shell("", "r1", gone), wantGone: true},
		{name: "the sweep removes a shell of an unregistered project", labels: termlabel.Shell("", "r9", "%dir"), wantGone: true},
		{name: "the sweep removes a shell of a removed thread", labels: termlabel.Shell("s9", "r1", "%dir"), wantGone: true},
		{name: "the sweep leaves a live shell", labels: termlabel.Shell("s1", "r1", "%dir")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			var labels map[string]string
			for k, v := range tt.labels {
				if labels == nil {
					labels = map[string]string{}
				}
				if v == "%dir" {
					v = dir
				}
				labels[k] = v
			}
			b := bus.New()
			f := terminaltest.New(b)
			term, err := f.Create(t.Context(), terminal.Spec{Argv: []string{"zsh"}, Labels: labels})
			if err != nil {
				t.Fatal(err)
			}
			if tt.exitedBefore {
				_ = f.Exit(term.ID, 0)
			}
			sweep := time.Hour
			if !tt.exit && tt.event == nil {
				sweep = 20 * time.Millisecond
			}
			stop, err := startShellReaper(t.Context(), shellReaperOptions{
				Log: discard, Terminals: f, Bus: b, SweepEvery: sweep,
				RepoExists:    func(id string) bool { return id == "r1" || id == "r2" },
				SessionExists: func(id string) bool { return id == "s1" || id == "s2" },
			})
			if err != nil {
				t.Fatal(err)
			}
			defer stop()
			if tt.exit {
				_ = f.Exit(term.ID, 0)
			}
			if tt.event != nil {
				switch e := tt.event(dir).(type) {
				case repo.Event:
					bus.Publish(b, e)
				case session.Event:
					bus.Publish(b, e)
				}
			}
			isGone := func() bool {
				_, err := f.Get(context.Background(), term.ID)
				return errors.Is(err, terminal.ErrNotFound)
			}
			if tt.wantGone {
				deadline := time.Now().Add(5 * time.Second)
				for !isGone() && time.Now().Before(deadline) {
					time.Sleep(5 * time.Millisecond)
				}
			} else {
				time.Sleep(80 * time.Millisecond) // a removal that should not happen has had its chance
			}
			if isGone() != tt.wantGone {
				t.Errorf("terminal gone = %v, want %v", isGone(), tt.wantGone)
			}
		})
	}
}

// stubborn is a store whose Kill does nothing: the process never exits.
type stubborn struct {
	*terminaltest.Fake
	kills atomic.Int32
}

func (s *stubborn) Kill(context.Context, string) error {
	s.kills.Add(1)
	return nil
}

func TestShellReaperStopsDuringACleanup(t *testing.T) {
	b := bus.New()
	f := &stubborn{Fake: terminaltest.New(b)}
	gone := "/cf-test/gone"
	term, err := f.Create(t.Context(), terminal.Spec{Argv: []string{"zsh"}, Labels: termlabel.Shell("", "r1", gone)})
	if err != nil {
		t.Fatal(err)
	}
	stop, err := startShellReaper(t.Context(), shellReaperOptions{Log: discard, Terminals: f, Bus: b, SweepEvery: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	bus.Publish[repo.Event](b, repo.WorktreeRemoved{RepoID: "r1", Path: gone})
	deadline := time.Now().Add(5 * time.Second)
	for f.kills.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if f.kills.Load() == 0 {
		t.Fatal("the cleanup never killed the shell")
	}
	// The cleanup is waiting for an exit that never comes; stop must not wait for it.
	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop blocked on the cleanup in flight")
	}
	if _, err := f.Get(t.Context(), term.ID); err != nil {
		t.Errorf("shell after stop: %v, want it still there (never exited)", err)
	}
}
