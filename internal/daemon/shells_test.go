package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/termlabel"
)

func TestShellReaper(t *testing.T) {
	const (
		wt    = "/src/app/.worktrees/feat"
		other = "/src/app"
	)
	claude := map[string]string{termlabel.Session: "s1", termlabel.Worktree: wt}
	tests := []struct {
		name string
		// labels of the terminal under test, and whether it has exited before the
		// reaper starts.
		labels       map[string]string
		exitedBefore bool
		// act runs after the reaper started.
		act      func(f *terminaltest.Fake, b *bus.Bus, id string)
		wantGone bool
	}{
		{name: "a shell that exits is removed", labels: termlabel.Shell("", "r1", wt),
			act: func(f *terminaltest.Fake, _ *bus.Bus, id string) { _ = f.Exit(id, 0) }, wantGone: true},
		{name: "a thread's shell that exits is removed", labels: termlabel.Shell("s1", "r1", wt),
			act: func(f *terminaltest.Fake, _ *bus.Bus, id string) { _ = f.Exit(id, 1) }, wantGone: true},
		{name: "a shell that exited before the start is swept", labels: termlabel.Shell("", "r1", wt), exitedBefore: true, wantGone: true},
		{name: "a Claude terminal that exits stays", labels: claude,
			act: func(f *terminaltest.Fake, _ *bus.Bus, id string) { _ = f.Exit(id, 0) }},
		{name: "an unlabelled terminal that exits stays",
			act: func(f *terminaltest.Fake, _ *bus.Bus, id string) { _ = f.Exit(id, 0) }},
		{name: "removing its worktree kills and removes a shell", labels: termlabel.Shell("", "r1", wt),
			act: worktreeRemoved(wt), wantGone: true},
		{name: "removing its worktree kills and removes a thread's shell", labels: termlabel.Shell("s1", "r1", wt),
			act: worktreeRemoved(wt), wantGone: true},
		{name: "removing another worktree leaves a shell", labels: termlabel.Shell("", "r1", other),
			act: worktreeRemoved(wt)},
		{name: "removing its worktree leaves a Claude terminal", labels: claude, act: worktreeRemoved(wt)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			f := terminaltest.New(b)
			term, err := f.Create(t.Context(), terminal.Spec{Argv: []string{"zsh"}, Labels: tt.labels})
			if err != nil {
				t.Fatal(err)
			}
			if tt.exitedBefore {
				_ = f.Exit(term.ID, 0)
			}
			stop, err := startShellReaper(t.Context(), slog.New(slog.NewTextHandler(io.Discard, nil)), f, b)
			if err != nil {
				t.Fatal(err)
			}
			defer stop()
			if tt.act != nil {
				tt.act(f, b, term.ID)
			}
			gone := func() bool {
				_, err := f.Get(context.Background(), term.ID)
				return errors.Is(err, terminal.ErrNotFound)
			}
			if tt.wantGone {
				deadline := time.Now().Add(5 * time.Second)
				for !gone() && time.Now().Before(deadline) {
					time.Sleep(5 * time.Millisecond)
				}
			} else {
				time.Sleep(50 * time.Millisecond) // a removal that should not happen has had its chance
			}
			if gone() != tt.wantGone {
				t.Errorf("terminal gone = %v, want %v", gone(), tt.wantGone)
			}
		})
	}
}

func worktreeRemoved(path string) func(*terminaltest.Fake, *bus.Bus, string) {
	return func(_ *terminaltest.Fake, b *bus.Bus, _ string) {
		bus.Publish[repo.Event](b, repo.WorktreeRemoved{RepoID: "r1", Path: path})
	}
}
