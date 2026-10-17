package thread

import (
	"errors"
	"slices"
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
		{name: "project thread", id: project.ID, target: RunInTarget{ProjectID: "r2"}, wantErr: ErrFailedPrecondition},
		{name: "no target", id: ws.ID, wantErr: ErrInvalidArgument},
		{name: "project not a member", id: ws.ID, target: RunInTarget{ProjectID: "r9"}, wantErr: ErrFailedPrecondition},
		{name: "path not a member", id: ws.ID, target: RunInTarget{WorktreePath: t.TempDir()}, wantErr: ErrFailedPrecondition},
		{name: "unknown thread", id: "s-nope", target: RunInTarget{ProjectID: "r2"}, wantErr: ErrNotFound},
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

// newWSPermissionEnv is newWSEnv whose fake replays write-allow: a thread sent a
// message waits on a permission request until the test answers it.
func newWSPermissionEnv(t *testing.T) *wsEnv {
	t.Helper()
	return newWSFixtureEnv(t, "write-allow")
}

// answer allows the thread's pending request.
func (e *env) answer(id string) {
	e.t.Helper()
	p := e.items(id).Pending
	if len(p) != 1 {
		e.t.Fatalf("pending = %+v", p)
	}
	if _, err := e.m.Respond(e.ctx(), id, p[0].RequestID, Decision{Allow: true}); err != nil {
		e.t.Fatal(err)
	}
}

// A live thread moves with set_cwd once it is idle at its prompt; the row's cwd changes
// when Claude accepts, and survives a restart.
func TestRunInMovesWhenIdle(t *testing.T) {
	e := newWSPermissionEnv(t)
	s := e.create(CreateOptions{WorkspaceID: "login", InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })

	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "api"}) // a project name works too
	if err != nil {
		t.Fatal(err)
	}
	if got.PendingWorktreePath != e.wt2 || got.WorktreePath != e.wt {
		t.Fatalf("queued = %+v", got)
	}
	time.Sleep(cdSettle + 200*time.Millisecond) // many ticks at the request
	if e.sentSetCwd(e.wt2) {
		t.Fatal("moved while a request was pending")
	}
	e.answer(s.ID)
	e.waitSent("set_cwd", isSetCwd(e.wt2))
	moved := e.waitFor(s.ID, "moved", func(s Thread) bool { return s.WorktreePath == e.wt2 })
	if moved.ProjectID != "r2" || moved.PendingWorktreePath != "" || moved.WorkspaceID != "w-login" {
		t.Errorf("moved = %+v", moved)
	}

	e.restart(e.withSource)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.WorktreePath != e.wt2 || got.ProjectID != "r2" {
		t.Errorf("after restart = %+v", got)
	}
}

// Asking for the member the thread is in cancels a queued move.
func TestRunInBackCancels(t *testing.T) {
	e := newWSPermissionEnv(t)
	s := e.create(CreateOptions{WorkspaceID: "login", InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "r2"}); err != nil {
		t.Fatal(err)
	}
	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{WorktreePath: e.wt})
	if err != nil || got.PendingWorktreePath != "" {
		t.Fatalf("cancel = %+v, %v", got, err)
	}
	e.answer(s.ID)
	e.waitItems(s.ID, "turn end", hasTurnEnd)
	time.Sleep(cdSettle + 300*time.Millisecond)
	if e.sentSetCwd(e.wt2) {
		t.Error("moved after the cancel")
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.WorktreePath != e.wt {
		t.Errorf("thread = %+v", got)
	}
}

// A disconnected thread moves at once and reconnects in the new member, with the old
// one as an --add-dir. A move still queued when the process exits is applied too.
func TestRunInWithoutAProcess(t *testing.T) {
	e := newWSPermissionEnv(t)
	s := e.create(CreateOptions{WorkspaceID: "login", InitialPrompt: "write"})
	e.waitFor(s.ID, "permission", func(s Thread) bool { return s.Status == StatusNeedsAttention })
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "r2"}); err != nil {
		t.Fatal(err)
	}
	e.exit(s.ID, 0)
	got := e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
	if got.WorktreePath != e.wt2 || got.ProjectID != "r2" || got.PendingWorktreePath != "" {
		t.Fatalf("after exit with a queued move = %+v", got)
	}

	got, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "r1"})
	if err != nil || got.WorktreePath != e.wt || got.ProjectID != "r1" || got.PendingWorktreePath != "" {
		t.Fatalf("disconnected move = %+v, %v", got, err)
	}
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	spec := e.spec(s.ID)
	if !samePath(spec.Cwd, e.wt) || !slices.Contains(addDirs(spec.Argv), e.wt2) {
		t.Errorf("reconnect cwd = %s argv = %q", spec.Cwd, spec.Argv)
	}
}
