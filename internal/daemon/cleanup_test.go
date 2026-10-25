package daemon

import (
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

func TestCleanupHold(t *testing.T) {
	const wt = "/wt/cf-a"
	shell := func(state terminal.State, cwd, owner string) terminal.Terminal {
		l := map[string]string{termlabel.Kind: termlabel.KindShell}
		if owner != "" {
			l[termlabel.Worktree] = owner
		}
		return terminal.Terminal{ID: "t", State: state, Cwd: cwd, Labels: l}
	}
	tests := []struct {
		name      string
		path      string
		threads   []holder
		terminals []terminal.Terminal
		want      string
	}{
		{name: "nothing", path: wt, want: ""},
		{name: "a thread on it", path: wt, threads: []holder{{ID: "s1", Name: "fix-badge", Cwd: wt}}, want: "thread fix-badge is on it"},
		{name: "unnamed thread in a subdirectory", path: wt, threads: []holder{{ID: "s1", Cwd: wt + "/sub"}}, want: "a thread is on it"},
		{name: "thread in a sibling with a common prefix", path: wt, threads: []holder{{ID: "s1", Cwd: wt + "-other"}}, want: ""},
		{name: "running shell owned by it", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, "/elsewhere", wt)}, want: "a terminal is open in it"},
		{name: "running terminal inside it", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, wt+"/sub", "")}, want: "a terminal is open in it"},
		{name: "exited shell", path: wt, terminals: []terminal.Terminal{shell(terminal.StateExited, wt, wt)}, want: ""},
		{name: "shell elsewhere", path: wt, terminals: []terminal.Terminal{shell(terminal.StateRunning, "/wt/cf-b", "/wt/cf-b")}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanupHold(tt.path, tt.threads, tt.terminals); got != tt.want {
				t.Errorf("cleanupHold = %q, want %q", got, tt.want)
			}
		})
	}
}

// A worktree is abandoned once every thread that was on it is archived or removed.
func TestCleanupAbandoned(t *testing.T) {
	const wt = "/wt/cf-a"
	now := time.Date(2026, 10, 21, 4, 0, 0, 0, time.UTC)
	on := func(id, cwd string, archived bool) thread.Thread {
		s := thread.Thread{ID: id, WorktreePath: cwd}
		if archived {
			s.ArchivedAt = now
		}
		return s
	}
	gone := func(cwd string) thread.RemovedThread {
		return thread.RemovedThread{ID: "s-gone", WorktreePath: cwd, RemovedAt: now}
	}
	tests := []struct {
		name    string
		threads []thread.Thread
		removed []thread.RemovedThread
		want    bool
	}{
		{name: "no thread was on it (an orchestrator just made it)", want: false},
		{name: "a live thread", threads: []thread.Thread{on("s1", wt, false)}, want: false},
		{name: "its thread archived", threads: []thread.Thread{on("s1", wt, true)}, want: true},
		{name: "its thread archived, from a subdirectory", threads: []thread.Thread{on("s1", wt+"/web", true)}, want: true},
		{name: "its thread removed", removed: []thread.RemovedThread{gone(wt)}, want: true},
		{name: "one archived, one still on it", threads: []thread.Thread{on("s1", wt, true), on("s2", wt, false)}, want: false},
		{name: "removed, and a live one on it", threads: []thread.Thread{on("s2", wt+"/sub", false)}, removed: []thread.RemovedThread{gone(wt)}, want: false},
		{name: "archived thread in a sibling with a common prefix", threads: []thread.Thread{on("s1", wt+"-other", true)}, want: false},
		{name: "removed thread elsewhere", removed: []thread.RemovedThread{gone("/wt/cf-b")}, want: false},
		{name: "live thread elsewhere, archived one here", threads: []thread.Thread{on("s1", wt, true), on("s2", "/wt/cf-b", false)}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanupAbandoned(wt, &thread.Snapshot{Threads: tt.threads}, tt.removed); got != tt.want {
				t.Errorf("cleanupAbandoned = %v, want %v", got, tt.want)
			}
		})
	}
	if cleanupAbandoned(wt, nil, nil) {
		t.Error("nil snapshot")
	}
}

// The threads that hold a worktree (cleanup, workspace removal): every one but an archived
// one, whatever its process state.
func TestWorktreeThreads(t *testing.T) {
	now := time.Date(2026, 10, 15, 4, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		s    thread.Thread
		want bool
	}{
		{name: "running", s: thread.Thread{State: thread.StateConnected}, want: true},
		{name: "starting", s: thread.Thread{State: thread.StateStarting}, want: true},
		{name: "stopped at cache expiry", s: thread.Thread{State: thread.StateDisconnected, DisconnectReason: "idle"}, want: true},
		{name: "stopping", s: thread.Thread{State: thread.StateClosing}, want: true},
		{name: "snoozed (it comes back to the worktree)", s: thread.Thread{State: thread.StateDisconnected, SnoozedUntil: now}, want: true},
		{name: "archived", s: thread.Thread{State: thread.StateDisconnected, ArchivedAt: now}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.s.ID, tt.s.Name, tt.s.WorktreePath = "s1", "fix-badge", "/wt/cf-a"
			got := worktreeThreads(&thread.Snapshot{Threads: []thread.Thread{tt.s}})
			var want []holder
			if tt.want {
				want = []holder{{ID: "s1", Name: "fix-badge", Cwd: "/wt/cf-a"}}
			}
			if !slices.Equal(got, want) {
				t.Errorf("worktreeThreads = %+v, want %+v", got, want)
			}
		})
	}
	if worktreeThreads(nil) != nil {
		t.Error("nil snapshot")
	}
}
