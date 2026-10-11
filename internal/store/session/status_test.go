package session

import (
	"context"
	"testing"
	"time"
)

func TestDisconnectedStatus(t *testing.T) {
	tests := []struct {
		name       string
		st         Status
		reason     string
		want       Status
		wantReason string
	}{
		{"busy is interrupted", StatusBusy, "working: Say hi", StatusError, ReasonInterrupted},
		{"busy without a reason is interrupted", StatusBusy, "", StatusError, ReasonInterrupted},
		{"a question is kept", StatusNeedsAttention, "question: Which color do you prefer?", StatusNeedsAttention, "question: Which color do you prefer?"},
		{"a permission prompt is kept", StatusNeedsAttention, "permission: Do you want to proceed?", StatusNeedsAttention, "permission: Do you want to proceed?"},
		{"a claude error stays attention", StatusNeedsAttention, "error: model_not_found", StatusNeedsAttention, "error: model_not_found"},
		{"idle is kept", StatusIdle, "at prompt", StatusIdle, "at prompt"},
		{"unknown is kept", StatusUnknown, "", StatusUnknown, ""},
		{"interrupted stays interrupted", StatusError, ReasonInterrupted, StatusError, ReasonInterrupted},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			st, reason := disconnectedStatus(tt.st, tt.reason)
			if st != tt.want || reason != tt.wantReason {
				t.Errorf("disconnectedStatus(%v, %q) = %v, %q; want %v, %q", tt.st, tt.reason, st, reason, tt.want, tt.wantReason)
			}
		})
	}
}

func TestSetStatusStampsOnlyChanges(t *testing.T) {
	t0, t1 := time.UnixMilli(1000), time.UnixMilli(2000)
	var s Session
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

// TestStatusSurvivesDisconnect covers every way a live process ends: the session keeps
// the status it had (busy becomes interrupted), persisted.
func TestStatusSurvivesDisconnect(t *testing.T) {
	type end func(e *env, s Session)
	exit := func(code int) end {
		return func(e *env, s Session) {
			_ = e.terms.Exit(s.TerminalID, code)
		}
	}
	closeIt := func(e *env, s Session) {
		done := make(chan error, 1)
		go func() { done <- e.m.Close(context.Background(), s.ID) }()
		e.waitWritten(s.TerminalID, keyEscape)
		// The close sequence's Escape interrupts the turn: by the time the process
		// exits the detector says idle. The status when the close began wins.
		e.det.set(StatusIdle, "at prompt")
		_ = e.terms.Exit(s.TerminalID, 0)
		if err := <-done; err != nil {
			e.t.Fatal(err)
		}
	}
	shutdown := func(e *env, s Session) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.m.Shutdown(ctx); err != nil {
			e.t.Fatal(err)
		}
		e.open()
	}
	tests := []struct {
		name       string
		st         Status
		reason     string
		end        end
		wantDisc   string
		want       Status
		wantReason string
	}{
		{"exit while busy", StatusBusy, "working", exit(0), ReasonExited, StatusError, ReasonInterrupted},
		{"crash while busy", StatusBusy, "running Bash", exit(1), ReasonCrashed, StatusError, ReasonInterrupted},
		{"crash at a question", StatusNeedsAttention, "question: Which color do you prefer?", exit(1), ReasonCrashed,
			StatusNeedsAttention, "question: Which color do you prefer?"},
		{"exit idle", StatusIdle, "at prompt", exit(0), ReasonExited, StatusIdle, "at prompt"},
		{"closed while busy", StatusBusy, "working", closeIt, ReasonClosed, StatusError, ReasonInterrupted},
		{"closed at a permission prompt", StatusNeedsAttention, "permission: Do you want to proceed?", closeIt, ReasonClosed,
			StatusNeedsAttention, "permission: Do you want to proceed?"},
		{"daemon stopped while busy", StatusBusy, "working", shutdown, ReasonDaemonStopped, StatusError, ReasonInterrupted},
		{"daemon stopped at a permission prompt", StatusNeedsAttention, "permission: Do you want to proceed?", shutdown, ReasonDaemonStopped,
			StatusNeedsAttention, "permission: Do you want to proceed?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.connected(CreateOptions{})
			e.det.set(tt.st, tt.reason)
			_ = e.terms.Emit(s.TerminalID, []byte("x"))
			e.waitFor(s.ID, "status published", func(s Session) bool { return s.Status == tt.st && s.StatusReason == tt.reason })
			before := time.Now()
			tt.end(e, s)
			got := e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
			if got.DisconnectReason != tt.wantDisc || got.Status != tt.want || got.StatusReason != tt.wantReason {
				t.Errorf("after %s: disconnect %q, status %v %q; want %q, %v %q", tt.name, got.DisconnectReason,
					got.Status, got.StatusReason, tt.wantDisc, tt.want, tt.wantReason)
			}
			if tt.want != tt.st && got.StatusChangedAt.Before(before.Truncate(time.Millisecond)) {
				t.Errorf("StatusChangedAt %v not restamped (end began %v)", got.StatusChangedAt, before)
			}
			// Persisted: the row reads back the same.
			rows, err := loadSessions(context.Background(), e.m.opts.DB)
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
		st         Status
		reason     string
		want       Status
		wantReason string
	}{
		{"busy", StatusBusy, "working", StatusError, ReasonInterrupted},
		{"question", StatusNeedsAttention, "question: Which color do you prefer?", StatusNeedsAttention, "question: Which color do you prefer?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			s := e.connected(CreateOptions{})
			e.det.set(tt.st, tt.reason)
			_ = e.terms.Emit(s.TerminalID, []byte("x"))
			e.waitFor(s.ID, "status published", func(s Session) bool { return s.Status == tt.st })
			rows, err := loadSessions(context.Background(), e.m.opts.DB)
			if err != nil || len(rows) != 1 || rows[0].Status != tt.st || rows[0].StatusReason != tt.reason || rows[0].StatusChangedAt.IsZero() {
				t.Fatalf("published status not persisted: %+v, %v", rows, err)
			}
			// What a crash leaves behind: the live row as last persisted.
			live := rows[0]
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := e.m.Shutdown(ctx); err != nil {
				t.Fatal(err)
			}
			if err := saveSession(context.Background(), e.m.opts.DB, live); err != nil {
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

// TestReconnectHandsStatusToTheDetector: the persisted status is cleared on reconnect;
// the new detector's first reading replaces it.
func TestReconnectHandsStatusToTheDetector(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	e.det.set(StatusNeedsAttention, "question: Which color do you prefer?")
	_ = e.terms.Emit(s.TerminalID, []byte("x"))
	e.waitFor(s.ID, "question", func(s Session) bool { return s.Status == StatusNeedsAttention })
	_ = e.terms.Exit(s.TerminalID, 1)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	e.det.set(StatusUnknown, "")
	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != StatusUnknown || r.StatusReason != "" {
		t.Errorf("reconnected status = %v %q, want unknown", r.Status, r.StatusReason)
	}
	e.det.set(StatusIdle, "at prompt")
	_ = e.terms.SetAltScreen(r.TerminalID, true)
	e.waitFor(s.ID, "detector reading", func(s Session) bool { return s.Status == StatusIdle && s.StatusReason == "at prompt" })
}
