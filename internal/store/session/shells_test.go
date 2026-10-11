package session

import (
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
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
		{"not a shell, same session label", map[string]string{termlabel.Session: s.ID}, false},
	}
	ids := make([]string, len(terms))
	for i, tt := range terms {
		ids[i] = spawn(tt.labels)
	}

	// Closing the thread leaves every shell running.
	done := make(chan error, 1)
	go func() { done <- e.m.Close(e.ctx(), s.ID) }()
	e.waitWritten(s.TerminalID, keyEscape)
	_ = e.terms.Exit(s.TerminalID, 0)
	if err := <-done; err != nil {
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
