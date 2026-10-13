package session

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// A thread without a project runs in Options.Home with no owner, and its home is
// pre-trusted like any cwd.
func TestCreateNoProject(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.DisablePreTrust = false })
	s, err := e.m.Create(e.ctx(), CreateOptions{NoProject: true, Model: "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	if s.RepoID != "" || s.WorkspaceID != "" || s.WorktreePath != e.home || s.CreatedWorktree || s.BaseRef != "" {
		t.Fatalf("created = %+v", s)
	}
	if spec := e.spec(s.ID); !samePath(spec.Cwd, e.home) {
		t.Errorf("cwd = %q, want %q", spec.Cwd, e.home)
	}
	cfg, err := os.ReadFile(e.paths.Config)
	if err != nil || !strings.Contains(string(cfg), `"`+realPath(e.home)+`"`) || !strings.Contains(string(cfg), "hasTrustDialogAccepted") {
		t.Errorf("home not pre-trusted: %s (%v)", cfg, err)
	}
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
}

func TestCreateNoProjectIsExclusive(t *testing.T) {
	e := newWSEnv(t)
	tests := []struct {
		name string
		o    CreateOptions
	}{
		{"repo", CreateOptions{RepoID: "r1"}},
		{"worktree", CreateOptions{WorktreePath: e.wt}},
		{"new worktree", CreateOptions{RepoID: "r1", NewWorktree: &NewWorktree{}}},
		{"new worktree alone", CreateOptions{NewWorktree: &NewWorktree{}}},
		{"workspace", CreateOptions{WorkspaceID: "login"}},
		{"new workspace", CreateOptions{NewWorkspace: &NewWorkspace{Repos: []string{"r1"}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := tt.o
			o.NoProject = true
			if _, err := e.m.Create(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("Create = %v, want %v", err, ErrInvalidArgument)
			}
		})
	}
	if n := len(e.m.Snapshot().Sessions); n != 0 {
		t.Errorf("refused creates left %d sessions", n)
	}
	if ws := e.ws.Snapshot().Workspaces; len(ws) != 1 {
		t.Errorf("refused creates made workspaces: %+v", ws)
	}
}

func TestRunInRefusesNoProjectThread(t *testing.T) {
	e := newWSEnv(t)
	s := e.connected(CreateOptions{NoProject: true})
	for _, target := range []RunInTarget{{RepoID: "r1"}, {WorktreePath: e.wt2}} {
		if _, err := e.m.RunIn(e.ctx(), s.ID, target); !errors.Is(err, ErrFailedPrecondition) {
			t.Errorf("RunIn %+v = %v, want %v", target, err, ErrFailedPrecondition)
		}
	}
	if got, _ := e.m.Get(e.ctx(), s.ID); got.WorktreePath != e.home || got.RepoID != "" || got.PendingWorktreePath != "" {
		t.Errorf("after refusals = %+v", got)
	}
}

// Fork, reconnect and a daemon restart keep the home cwd and the empty owner.
func TestNoProjectThreadSurvivesForkReconnectAndRestart(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{NoProject: true, Name: "scratch"})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscriptIn(e.home, cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })

	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.RepoID != "" || f.WorkspaceID != "" || f.WorktreePath != e.home || f.ParentID != s.ID {
		t.Errorf("fork = %+v", f)
	}
	if spec := e.spec(f.ID); !samePath(spec.Cwd, e.home) || argOf(spec.Argv, "--resume") != cid {
		t.Errorf("fork spawn cwd = %q argv = %q", spec.Cwd, spec.Argv)
	}

	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.RepoID != "" || r.WorkspaceID != "" || r.WorktreePath != e.home || r.LastError != "" {
		t.Errorf("reconnected = %+v", r)
	}
	if spec := e.spec(s.ID); !samePath(spec.Cwd, e.home) || argOf(spec.Argv, "--resume") != cid {
		t.Errorf("reconnect spawn cwd = %q argv = %q", spec.Cwd, spec.Argv)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	for _, id := range []string{s.ID, f.ID} {
		got, err := e.m.Get(e.ctx(), id)
		if err != nil || got.RepoID != "" || got.WorkspaceID != "" || got.WorktreePath != e.home {
			t.Errorf("after restart %s = %+v (%v)", id, got, err)
		}
	}
}

// A thread without a project resolves no file reference, even one with an empty-looking
// repo: every token becomes its relative path.
func TestNoProjectFileRefs(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{NoProject: true})
	roots := e.m.fileRefRoots(s)
	for _, repoID := range []string{"", "r1"} {
		if wt, ok := roots(repoID); ok {
			t.Errorf("roots(%q) = %q, true", repoID, wt)
		}
	}
	got, dropped := rewriteFileRefs("read @cf-file://r1/README.md and @cf-file:///x.go", roots)
	if want := "read @README.md and @cf-file:///x.go"; got != want || !slices.Equal(dropped, []string{"cf-file://r1/README.md"}) {
		t.Errorf("rewrite = %q dropped %q, want %q", got, dropped, want)
	}
}
