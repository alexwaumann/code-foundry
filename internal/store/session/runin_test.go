package session

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunInRefuses(t *testing.T) {
	e := newWSEnv(t)
	ws := e.connected(CreateOptions{WorkspaceID: "login"})
	project := e.connected(CreateOptions{})
	tests := []struct {
		name    string
		id      string
		target  RunInTarget
		wantErr error
	}{
		{name: "project thread", id: project.ID, target: RunInTarget{RepoID: "r2"}, wantErr: ErrFailedPrecondition},
		{name: "no target", id: ws.ID, wantErr: ErrInvalidArgument},
		{name: "repo not a member", id: ws.ID, target: RunInTarget{RepoID: "r9"}, wantErr: ErrFailedPrecondition},
		{name: "path not a member", id: ws.ID, target: RunInTarget{WorktreePath: t.TempDir()}, wantErr: ErrFailedPrecondition},
		{name: "unknown thread", id: "s-nope", target: RunInTarget{RepoID: "r2"}, wantErr: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := e.m.RunIn(e.ctx(), tt.id, tt.target); !errors.Is(err, tt.wantErr) {
				t.Errorf("RunIn = %v, want %v", err, tt.wantErr)
			}
		})
	}
	if got, _ := e.m.Get(e.ctx(), ws.ID); got.WorktreePath != e.wt || got.PendingWorktreePath != "" {
		t.Errorf("after refusals = %+v", got)
	}
}

// A live thread gets /cd typed once it is idle; the row's cwd changes when Enter is
// pressed, and survives a restart.
func TestRunInTypesCdWhenIdle(t *testing.T) {
	e := newWSEnv(t)
	s := e.connected(CreateOptions{WorkspaceID: "login"})
	e.det.set(StatusBusy, "working")

	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{RepoID: "api"}) // a repo name works too
	if err != nil {
		t.Fatal(err)
	}
	if got.PendingWorktreePath != e.wt2 || got.WorktreePath != e.wt {
		t.Fatalf("queued = %+v", got)
	}
	time.Sleep(100 * time.Millisecond) // several ticks while busy
	e.det.set(StatusNeedsAttention, "permission: Do you want to proceed?")
	time.Sleep(100 * time.Millisecond)
	if w := string(e.terms.Written(s.TerminalID)); strings.Contains(w, "/cd") {
		t.Fatalf("typed while not at the prompt: %q", w)
	}
	e.det.set(StatusIdle, "at prompt")
	e.waitWritten(s.TerminalID, "/cd "+e.wt2)
	moved := e.waitFor(s.ID, "moved", func(s Session) bool { return s.WorktreePath == e.wt2 })
	if moved.RepoID != "r2" || moved.PendingWorktreePath != "" || moved.WorkspaceID != "w-login" {
		t.Errorf("moved = %+v", moved)
	}
	if w := string(e.terms.Written(s.TerminalID)); w != "/cd "+e.wt2+keyEnter {
		t.Errorf("written = %q", w)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open(e.withSource)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.WorktreePath != e.wt2 || got.RepoID != "r2" {
		t.Errorf("after restart = %+v", got)
	}
}

// Asking for the member the thread is in cancels a queued move.
func TestRunInBackCancels(t *testing.T) {
	e := newWSEnv(t)
	s := e.connected(CreateOptions{WorkspaceID: "login"})
	e.det.set(StatusBusy, "working")
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{RepoID: "r2"}); err != nil {
		t.Fatal(err)
	}
	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{WorktreePath: e.wt})
	if err != nil || got.PendingWorktreePath != "" {
		t.Fatalf("cancel = %+v, %v", got, err)
	}
	e.det.set(StatusIdle, "at prompt")
	time.Sleep(150 * time.Millisecond)
	if w := e.terms.Written(s.TerminalID); len(w) != 0 {
		t.Errorf("written = %q", w)
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.WorktreePath != e.wt {
		t.Errorf("session = %+v", got)
	}
}

// A disconnected thread moves at once and reconnects in the new member, with the old
// one as an --add-dir. A move still queued when the process exits is applied too.
func TestRunInWithoutAProcess(t *testing.T) {
	e := newWSEnv(t)
	s := e.connected(CreateOptions{WorkspaceID: "login"})
	e.det.set(StatusBusy, "working")
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{RepoID: "r2"}); err != nil {
		t.Fatal(err)
	}
	_ = e.terms.Exit(s.TerminalID, 0)
	got := e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	if got.WorktreePath != e.wt2 || got.RepoID != "r2" || got.PendingWorktreePath != "" {
		t.Fatalf("after exit with a queued move = %+v", got)
	}

	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{RepoID: "r1"})
	if err != nil || got.WorktreePath != e.wt || got.RepoID != "r1" || got.PendingWorktreePath != "" {
		t.Fatalf("disconnected move = %+v, %v", got, err)
	}
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	spec := mustSpec(t, e.env, r)
	if spec.Cwd != e.wt || !strings.Contains(strings.Join(addDirs(spec.Argv), " "), e.wt2) {
		t.Errorf("reconnect cwd = %s argv = %q", spec.Cwd, spec.Argv)
	}
}
