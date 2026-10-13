package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

func TestRemoveTakesTheThreadsShellsCloseDoesNot(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	spawn := func(labels map[string]string) string {
		t.Helper()
		term, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: labels})
		if err != nil {
			t.Fatal(err)
		}
		return term.ID
	}
	terms := []struct {
		name     string
		labels   map[string]string
		wantGone bool
	}{
		{"the thread's shell", termlabel.Shell(s.ID, "r1", e.wt), true},
		{"another thread's shell", termlabel.Shell("other", "r1", e.wt), false},
		{"the worktree's shell", termlabel.Shell("", "r1", e.wt), false},
		{"not terminal.new's, same session label", map[string]string{termlabel.Session: s.ID}, false},
	}
	ids := make([]string, len(terms))
	for i, tt := range terms {
		ids[i] = spawn(tt.labels)
	}

	// Closing the thread leaves every shell running.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	for i, tt := range terms {
		if got, err := e.terms.Get(e.ctx(), ids[i]); err != nil || got.State != terminal.StateRunning {
			t.Errorf("after close, %s = %+v, %v; want running", tt.name, got, err)
		}
	}

	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	for i, tt := range terms {
		_, err := e.terms.Get(e.ctx(), ids[i])
		if gone := errors.Is(err, terminal.ErrNotFound); gone != tt.wantGone {
			t.Errorf("after remove, %s gone = %v, want %v", tt.name, gone, tt.wantGone)
		}
	}
}

// stubbornShells is a terminal store whose shells ignore Kill.
type stubbornShells struct{ *terminaltest.Fake }

func (s stubbornShells) Kill(ctx context.Context, id string) error {
	if t, err := s.Get(ctx, id); err == nil && termlabel.IsShell(t.Labels) {
		return nil
	}
	return s.Fake.Kill(ctx, id)
}

func TestRemoveFailsWhileAShellWillNotDie(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.Terminals = stubbornShells{o.Terminals.(*terminaltest.Fake)} })
	s := e.connected(CreateOptions{})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	shell, err := e.terms.Create(e.ctx(), terminal.Spec{Argv: []string{"zsh"}, Cwd: e.wt, Labels: termlabel.Shell(s.ID, "r1", e.wt)})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := e.m.Remove(ctx, s.ID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Remove = %v, want the deadline", err)
	}
	if _, err := e.m.Get(e.ctx(), s.ID); err != nil {
		t.Errorf("thread after a failed Remove: %v, want it kept", err)
	}
	if _, err := e.terms.Get(e.ctx(), shell.ID); err != nil {
		t.Errorf("shell after a failed Remove: %v, want it still there", err)
	}
}
