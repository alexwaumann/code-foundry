package thread

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDisconnectedStatus(t *testing.T) {
	tests := []struct {
		name       string
		st         Status
		reason     string
		crashed    bool
		want       Status
		wantReason string
	}{
		{"busy is interrupted", StatusBusy, "working: Say hi", false, StatusError, ReasonInterrupted},
		{"busy without a reason is interrupted", StatusBusy, "", false, StatusError, ReasonInterrupted},
		{"busy whose process died on its own crashed", StatusBusy, "working", true, StatusError, ReasonCrashed},
		{"a question is kept", StatusNeedsAttention, "question: Which color do you prefer?", false, StatusNeedsAttention, "question: Which color do you prefer?"},
		{"a question is kept on a crash", StatusNeedsAttention, "question: Which color do you prefer?", true, StatusNeedsAttention, "question: Which color do you prefer?"},
		{"a permission prompt is kept", StatusNeedsAttention, "permission: Do you want to proceed?", false, StatusNeedsAttention, "permission: Do you want to proceed?"},
		{"a claude error stays attention", StatusNeedsAttention, "error: model_not_found", false, StatusNeedsAttention, "error: model_not_found"},
		{"idle is kept", StatusIdle, "at prompt", false, StatusIdle, "at prompt"},
		{"idle is kept on a crash", StatusIdle, "at prompt", true, StatusIdle, "at prompt"},
		{"unknown is kept", StatusUnknown, "", false, StatusUnknown, ""},
		{"interrupted stays interrupted", StatusError, ReasonInterrupted, false, StatusError, ReasonInterrupted},
		{"crashed stays crashed", StatusError, ReasonCrashed, false, StatusError, ReasonCrashed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, reason := disconnectedStatus(tt.st, tt.reason, tt.crashed)
			if st != tt.want || reason != tt.wantReason {
				t.Errorf("disconnectedStatus(%v, %q) = %v, %q; want %v, %q", tt.st, tt.reason, st, reason, tt.want, tt.wantReason)
			}
		})
	}
}

func TestSetStatusStampsOnlyChanges(t *testing.T) {
	t0, t1 := time.UnixMilli(1000), time.UnixMilli(2000)
	var s Thread
	if !s.setStatus(StatusBusy, "working", t0) || s.StatusChangedAt != t0 {
		t.Fatalf("first set: %+v", s)
	}
	if s.setStatus(StatusBusy, "working", t1) || s.StatusChangedAt != t0 {
		t.Errorf("same status restamped: %+v", s)
	}
	if !s.setStatus(StatusBusy, "running Bash", t1) || s.StatusChangedAt != t1 {
		t.Errorf("reason change not stamped: %+v", s)
	}
}

// hangFixture is a capture whose turn never ends: a thread sent a message stays busy.
func hangFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hang.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// statusSetup starts a thread and waits until it shows a status.
type statusSetup struct {
	fixture string // a capture name, or "" for hangFixture
	prompt  string
	st      Status
	reason  string
}

var (
	busySetup       = statusSetup{prompt: "go", st: StatusBusy, reason: "working"}
	questionSetup   = statusSetup{fixture: "ask", prompt: "ask me", st: StatusNeedsAttention, reason: "question: Which color do you prefer?"}
	permissionSetup = statusSetup{fixture: "write-allow", prompt: "write", st: StatusNeedsAttention, reason: "permission: Write hello.txt"}
	idleSetup       = statusSetup{fixture: "text-table", st: StatusIdle, reason: "at prompt"}
	finishedSetup   = statusSetup{fixture: "text-table", prompt: "a table", st: StatusNeedsAttention, reason: "finished"}
)

func (ss statusSetup) start(t *testing.T) (*env, Thread) {
	t.Helper()
	path := hangFixture(t)
	if ss.fixture != "" {
		path = fixturePath(ss.fixture)
	}
	e := newFixtureEnvAt(t, path, nil)
	s := e.create(CreateOptions{InitialPrompt: ss.prompt})
	s = e.waitFor(s.ID, "status published", func(s Thread) bool {
		return s.State == StateConnected && s.Status == ss.st && s.StatusReason == ss.reason
	})
	return e, s
}

// TestStatusSurvivesDisconnect covers every way a live process ends: the thread keeps
// the status it had, persisted. A turn that was running is interrupted, and so is one
// waiting on a request: the request dies with the process. One whose process died on
// its own (no close, no daemon stop) crashed.
func TestStatusSurvivesDisconnect(t *testing.T) {
	type end func(e *env, s Thread)
	exit := func(code int) end {
		return func(e *env, s Thread) { e.exit(s.ID, code) }
	}
	closeIt := func(e *env, s Thread) {
		if err := e.m.Close(context.Background(), s.ID); err != nil {
			e.t.Fatal(err)
		}
	}
	shutdown := func(e *env, _ Thread) { e.restart() }
	tests := []struct {
		name       string
		setup      statusSetup
		end        end
		wantDisc   string
		want       Status
		wantReason string
	}{
		{"exit while busy", busySetup, exit(0), ReasonExited, StatusError, ReasonCrashed},
		{"crash while busy", busySetup, exit(1), ReasonCrashed, StatusError, ReasonCrashed},
		{"crash at a question", questionSetup, exit(1), ReasonCrashed, StatusError, ReasonCrashed},
		{"exit idle", idleSetup, exit(0), ReasonExited, StatusIdle, "at prompt"},
		{"exit after an unseen turn", finishedSetup, exit(0), ReasonExited, StatusNeedsAttention, "finished"},
		{"closed while busy", busySetup, closeIt, ReasonClosed, StatusError, ReasonInterrupted},
		{"closed at a permission prompt", permissionSetup, closeIt, ReasonClosed, StatusError, ReasonInterrupted},
		{"daemon stopped while busy", busySetup, shutdown, ReasonDaemonStopped, StatusError, ReasonInterrupted},
		{"daemon stopped after an unseen turn", finishedSetup, shutdown, ReasonDaemonStopped, StatusNeedsAttention, "finished"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := tt.setup.start(t)
			before := time.Now()
			tt.end(e, s)
			got := e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
			if got.DisconnectReason != tt.wantDisc || got.Status != tt.want || got.StatusReason != tt.wantReason {
				t.Errorf("after %s: disconnect %q, status %v %q; want %q, %v %q", tt.name, got.DisconnectReason,
					got.Status, got.StatusReason, tt.wantDisc, tt.want, tt.wantReason)
			}
			if tt.want != tt.setup.st && got.StatusChangedAt.Before(before.Truncate(time.Millisecond)) {
				t.Errorf("StatusChangedAt %v not restamped (end began %v)", got.StatusChangedAt, before)
			}
			// Persisted: the row reads back the same.
			rows, err := loadThreads(context.Background(), e.m.opts.DB)
			if err != nil || len(rows) != 1 {
				t.Fatalf("load = %v, %v", rows, err)
			}
			if r := rows[0]; r.Status != got.Status || r.StatusReason != got.StatusReason || !r.StatusChangedAt.Equal(got.StatusChangedAt.Truncate(time.Millisecond)) {
				t.Errorf("persisted %v %q %v; snapshot %v %q %v", r.Status, r.StatusReason, r.StatusChangedAt, got.Status, got.StatusReason, got.StatusChangedAt)
			}
		})
	}
}

// TestStatusAfterDaemonCrash: every published status is persisted, so a row the daemon
// left live is loaded with it, busy becoming interrupted.
func TestStatusAfterDaemonCrash(t *testing.T) {
	tests := []struct {
		name       string
		setup      statusSetup
		want       Status
		wantReason string
	}{
		{"busy", busySetup, StatusError, ReasonInterrupted},
		{"question", questionSetup, StatusNeedsAttention, "question: Which color do you prefer?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, s := tt.setup.start(t)
			rows, err := loadThreads(context.Background(), e.m.opts.DB)
			if err != nil || len(rows) != 1 || rows[0].Status != tt.setup.st || rows[0].StatusReason != tt.setup.reason || rows[0].StatusChangedAt.IsZero() {
				t.Fatalf("published status not persisted: %+v, %v", rows, err)
			}
			// What a crash leaves behind: the live row as last persisted.
			live := rows[0]
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := e.m.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			if err := saveThread(context.Background(), e.m.opts.DB, live); err != nil {
				t.Fatal(err)
			}
			e.open()
			got, _ := e.m.Get(e.ctx(), s.ID)
			if got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonRestarts || got.Status != tt.want || got.StatusReason != tt.wantReason {
				t.Errorf("after crash restart = %v %q %v %q", got.State, got.DisconnectReason, got.Status, got.StatusReason)
			}
		})
	}
}

// TestReconnectResetsTheStatus: the persisted status is cleared on reconnect; the new
// process's stream replaces it.
func TestReconnectResetsTheStatus(t *testing.T) {
	e, s := questionSetup.start(t)
	e.exit(s.ID, 1)
	e.waitFor(s.ID, "disconnected", func(s Thread) bool { return s.State == StateDisconnected })
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != StatusUnknown || r.StatusReason != "" {
		t.Errorf("reconnected status = %v %q, want unknown", r.Status, r.StatusReason)
	}
	e.waitFor(s.ID, "the stream's reading", func(s Thread) bool { return s.Status == StatusIdle && s.StatusReason == "at prompt" })
}
