package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
)

// fakeDetector reports whatever status the test sets and records what it was fed.
type fakeDetector struct {
	mu         sync.Mutex
	status     Status
	reason     string
	outputs    int
	transcript []string
}

func (d *fakeDetector) Output([]byte) { d.mu.Lock(); d.outputs++; d.mu.Unlock() }
func (d *fakeDetector) Transcript(l []byte) {
	d.mu.Lock()
	d.transcript = append(d.transcript, string(l))
	d.mu.Unlock()
}
func (d *fakeDetector) Tick(time.Time) {}
func (d *fakeDetector) Status() (Status, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.status, d.reason
}
func (d *fakeDetector) set(s Status, reason string) {
	d.mu.Lock()
	d.status, d.reason = s, reason
	d.mu.Unlock()
}

type env struct {
	t      *testing.T
	m      *Manager
	terms  *terminaltest.Fake
	repos  *repotest.Fake
	paths  ClaudePaths
	wt     string
	dbPath string
	bus    *bus.Bus
	events *bus.Subscription[Event]
	det    *fakeDetector

	mu    sync.Mutex
	named []string
	namer func(string) (string, error)
}

func newEnv(t *testing.T, mutate ...func(*Options)) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{t: t, bus: bus.New(), det: &fakeDetector{}}
	e.terms = terminaltest.New(nil)
	e.repos = repotest.New(nil)
	e.wt = filepath.Join(dir, "repo")
	if err := os.MkdirAll(e.wt, 0o755); err != nil {
		t.Fatal(err)
	}
	e.repos.Put(repo.Repo{ID: "r1", Path: e.wt, Name: "repo", Worktrees: []repo.Worktree{{RepoID: "r1", Path: e.wt, IsMain: true}}})
	e.paths = ClaudePaths{Dir: filepath.Join(dir, "claude"), Config: filepath.Join(dir, "claude.json")}
	e.dbPath = filepath.Join(dir, "cf.db")
	e.namer = func(msg string) (string, error) { return "named-" + strings.Fields(msg)[0], nil }
	e.events = bus.Subscribe[Event](e.bus, 1024)
	t.Cleanup(e.events.Close)
	e.open(mutate...)
	return e
}

func (e *env) open(mutate ...func(*Options)) {
	e.t.Helper()
	d, err := db.Open(context.Background(), e.dbPath)
	if err != nil {
		e.t.Fatal(err)
	}
	opts := Options{
		DB: d, Terminals: e.terms, Repos: e.repos, Bus: e.bus, Paths: e.paths,
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		NewDetector:    func(ScreenTextFn) StatusDetector { return e.det },
		Tick:           20 * time.Millisecond,
		StatusDebounce: 10 * time.Millisecond,
		StartTimeout:   5 * time.Second,
		CloseTimeout:   2 * time.Second,
		Namer: func(_ context.Context, msg string) (string, error) {
			e.mu.Lock()
			e.named = append(e.named, msg)
			fn := e.namer
			e.mu.Unlock()
			return fn(msg)
		},
	}
	for _, f := range mutate {
		f(&opts)
	}
	m, err := New(context.Background(), opts)
	if err != nil {
		e.t.Fatal(err)
	}
	e.m = m
	e.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := m.Shutdown(ctx); err != nil {
			e.t.Errorf("Shutdown: %v", err)
		}
		_ = d.Close()
	})
}

func (e *env) ctx() context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	e.t.Cleanup(cancel)
	return ctx
}

// waitFor polls the session until cond holds.
func (e *env) waitFor(id, what string, cond func(Session) bool) Session {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s, err := e.m.Get(context.Background(), id)
		if err == nil && cond(s) {
			return s
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("timed out waiting for %s; session = %+v (err %v)", what, s, err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *env) waitWritten(termID, want string) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(string(e.terms.Written(termID)), want) {
		if time.Now().After(deadline) {
			e.t.Fatalf("terminal %s never got %q; written %q", termID, want, e.terms.Written(termID))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *env) create(o CreateOptions) Session {
	e.t.Helper()
	if o.WorktreePath == "" && o.RepoID == "" {
		o.WorktreePath = e.wt
	}
	s, err := e.m.Create(e.ctx(), o)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func (e *env) connected(o CreateOptions) Session {
	e.t.Helper()
	s := e.create(o)
	if err := e.terms.SetAltScreen(s.TerminalID, true); err != nil {
		e.t.Fatal(err)
	}
	return e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
}

// writeTranscript appends lines to a Claude transcript for the worktree.
func (e *env) writeTranscript(cid string, lines ...string) {
	e.t.Helper()
	dir := e.paths.projectDir(e.wt)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		e.t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, cid+".jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	for _, l := range lines {
		_, _ = f.WriteString(l + "\n")
	}
}

func argOf(argv []string, flag string) string {
	if i := slices.Index(argv, flag); i >= 0 && i+1 < len(argv) {
		return argv[i+1]
	}
	return ""
}

func userLine(text string) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":%q}}`, text)
}

func TestCreateSpawnsClaudeAndConnectsOnAltScreen(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{WorktreePath: e.wt, Model: "opus", Effort: "high"})
	if s.State != StateStarting || s.RepoID != "r1" || s.WorktreePath != e.wt || s.TerminalID == "" {
		t.Fatalf("created = %+v", s)
	}
	spec, _ := e.terms.Spec(s.TerminalID)
	if spec.Argv[0] != "claude" || argOf(spec.Argv, "--model") != "opus" || argOf(spec.Argv, "--effort") != "high" {
		t.Errorf("argv = %q", spec.Argv)
	}
	if len(argOf(spec.Argv, "--session-id")) != 36 {
		t.Errorf("argv has no --session-id uuid: %q", spec.Argv)
	}
	if spec.Cwd != e.wt || spec.Labels["session"] != s.ID || spec.Labels["worktree"] != e.wt {
		t.Errorf("spec cwd=%q labels=%v", spec.Cwd, spec.Labels)
	}
	if spec.Env != nil {
		t.Errorf("spec env = %q, want none (the daemon env is scrubbed)", spec.Env)
	}
	cfg, err := os.ReadFile(e.paths.Config)
	if err != nil || !strings.Contains(string(cfg), realPath(e.wt)) || !strings.Contains(string(cfg), "hasTrustDialogAccepted") {
		t.Errorf("worktree not pre-trusted: %s (%v)", cfg, err)
	}
	_ = e.terms.SetAltScreen(s.TerminalID, true)
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
}

func TestConnectsOnTitleOrTimeout(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{})
	_ = e.terms.SetTitle(s.TerminalID, "✳ Claude Code")
	e.waitFor(s.ID, "connected via title", func(s Session) bool { return s.State == StateConnected })

	e2 := newEnv(t, func(o *Options) { o.StartTimeout = 50 * time.Millisecond })
	s2 := e2.create(CreateOptions{})
	e2.waitFor(s2.ID, "connected via timeout", func(s Session) bool { return s.State == StateConnected })
}

func TestCreateResolvesWorktree(t *testing.T) {
	e := newEnv(t)
	other := t.TempDir()
	tests := []struct {
		name    string
		o       CreateOptions
		wantErr error
	}{
		{"repo only uses main worktree", CreateOptions{RepoID: "r1"}, nil},
		{"unknown repo", CreateOptions{RepoID: "nope"}, ErrNotFound},
		{"unregistered path", CreateOptions{WorktreePath: other}, ErrFailedPrecondition},
		{"path not in repo", CreateOptions{RepoID: "r1", WorktreePath: other}, ErrFailedPrecondition},
		{"relative path", CreateOptions{WorktreePath: "repo"}, ErrInvalidArgument},
		{"nothing", CreateOptions{}, ErrInvalidArgument},
		{"bad effort", CreateOptions{RepoID: "r1", Effort: "huge"}, ErrInvalidArgument},
		{"bad model", CreateOptions{RepoID: "r1", Model: "-x"}, ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, err := e.m.Create(e.ctx(), tt.o)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err == nil && (s.WorktreePath != e.wt || s.RepoID != "r1") {
				t.Errorf("session = %+v", s)
			}
		})
	}
	e.terms.CreateErr = errors.New("boom")
	if _, err := e.m.Create(e.ctx(), CreateOptions{RepoID: "r1"}); err == nil {
		t.Fatal("spawn failure not reported")
	}
	if n := len(e.m.Snapshot().Sessions); n != 1 {
		t.Errorf("failed create left a row: %d sessions", n)
	}
}

func TestTrustDialogFallbackAnswersWithDownThenEnter(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.DisablePreTrust = true })
	s := e.create(CreateOptions{})
	id := s.TerminalID
	_ = e.terms.SetScreen(id, trustScreenNo)
	_ = e.terms.Emit(id, []byte("dialog"))
	e.waitWritten(id, keyDown)
	if strings.Contains(string(e.terms.Written(id)), keyEnter) {
		t.Fatal("pressed Enter while No was selected")
	}
	// Alt screen while the dialog is still showing must not connect.
	_ = e.terms.SetTitle(id, "x")
	time.Sleep(50 * time.Millisecond)
	if got, _ := e.m.Get(e.ctx(), s.ID); got.State != StateStarting {
		t.Fatalf("connected while the trust dialog was visible: %v", got.State)
	}
	_ = e.terms.SetScreen(id, trustScreenYes)
	_ = e.terms.Emit(id, []byte("rerender"))
	e.waitWritten(id, keyDown+keyEnter)
	_ = e.terms.SetScreen(id, promptScreen)
	_ = e.terms.SetAltScreen(id, true)
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
}

func TestExitWithoutCloseDisconnects(t *testing.T) {
	for _, tt := range []struct {
		code   int
		reason string
	}{{0, ReasonExited}, {1, ReasonCrashed}, {129, ReasonCrashed}} {
		t.Run(tt.reason, func(t *testing.T) {
			e := newEnv(t)
			s := e.connected(CreateOptions{})
			_ = e.terms.Exit(s.TerminalID, tt.code)
			got := e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
			if got.DisconnectReason != tt.reason || got.ExitCode != tt.code || got.TerminalID != "" {
				t.Errorf("session = %+v", got)
			}
			if _, err := e.terms.Get(e.ctx(), s.TerminalID); !errors.Is(err, terminal.ErrNotFound) {
				t.Errorf("terminal not removed: %v", err)
			}
		})
	}
}

func TestCloseIsGraceful(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	done := make(chan error, 1)
	go func() { done <- e.m.Close(e.ctx(), s.ID) }()
	e.waitFor(s.ID, "closing", func(s Session) bool { return s.State == StateClosing })
	e.waitWritten(s.TerminalID, keyEscape+keyCtrlC+keyCtrlC)
	select {
	case err := <-done:
		t.Fatalf("Close returned before exit: %v", err)
	default:
	}
	_ = e.terms.Exit(s.TerminalID, 0)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.State != StateDisconnected || got.DisconnectReason != ReasonClosed {
		t.Errorf("after close = %+v", got)
	}
	// Closing a disconnected session is a no-op.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Errorf("second close: %v", err)
	}
}

func TestCloseKillsAfterTimeout(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.CloseTimeout = 100 * time.Millisecond })
	s := e.connected(CreateOptions{})
	start := time.Now()
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.DisconnectReason != ReasonClosed || got.ExitCode != 129 {
		t.Errorf("after kill = %+v", got)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Errorf("close took %v", el)
	}
}

func TestTranscriptDiscoveryAndAutoNaming(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	if s.ClaudeSessionID != "" {
		t.Fatalf("claude session id known before the transcript: %q", s.ClaudeSessionID)
	}
	e.writeTranscript(cid, `{"type":"mode","mode":"normal"}`, userLine("pong please"))
	got := e.waitFor(s.ID, "named", func(s Session) bool { return s.Name != "" })
	if got.ClaudeSessionID != cid || got.Name != "named-pong" || !got.AutoNamed {
		t.Errorf("session = %+v", got)
	}
	e.writeTranscript(cid, userLine("second message"))
	time.Sleep(100 * time.Millisecond)
	e.mu.Lock()
	calls := slices.Clone(e.named)
	e.mu.Unlock()
	if len(calls) != 1 || calls[0] != "pong please" {
		t.Errorf("namer calls = %q, want one for the first message", calls)
	}
	e.det.mu.Lock()
	n := len(e.det.transcript)
	e.det.mu.Unlock()
	if n != 3 {
		t.Errorf("detector got %d transcript lines, want 3", n)
	}
	renamed, err := e.m.Rename(e.ctx(), s.ID, "  my name ")
	if err != nil || renamed.Name != "my name" || renamed.AutoNamed {
		t.Errorf("rename = %+v, %v", renamed, err)
	}
	if _, err := e.m.Rename(e.ctx(), s.ID, " "); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("empty rename err = %v", err)
	}
}

func TestExplicitNameOrRenameSkipsAutoNaming(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Name: "chosen"})
	spec, _ := e.terms.Spec(s.TerminalID)
	e.writeTranscript(argOf(spec.Argv, "--session-id"), userLine("hello there"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID != "" })
	time.Sleep(50 * time.Millisecond)
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.named) != 0 {
		t.Errorf("namer called for an explicitly named session: %q", e.named)
	}
}

func TestFollowsClearViaPidFile(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	term, _ := e.terms.Get(e.ctx(), s.TerminalID)
	_ = os.MkdirAll(filepath.Join(e.paths.Dir, "sessions"), 0o755)
	if err := os.WriteFile(e.paths.pidFile(term.Pid), []byte(fmt.Sprintf(`{"pid":%d,"sessionId":"rotated-id"}`, term.Pid)), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	e.writeTranscript("rotated-id", `{"type":"mode"}`)
	e.waitFor(s.ID, "rotated id", func(s Session) bool { return s.ClaudeSessionID == "rotated-id" })
}

func TestStatusFromDetectorIsPublished(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	e.det.set(StatusBusy, "esc to interrupt visible")
	_ = e.terms.Emit(s.TerminalID, []byte("working"))
	got := e.waitFor(s.ID, "busy", func(s Session) bool { return s.Status == StatusBusy })
	if got.StatusReason != "esc to interrupt visible" {
		t.Errorf("reason = %q", got.StatusReason)
	}
	e.det.set(StatusNeedsAttention, "permission prompt")
	e.waitFor(s.ID, "needs attention via tick", func(s Session) bool { return s.Status == StatusNeedsAttention })
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "status cleared", func(s Session) bool { return s.State == StateDisconnected && s.Status == StatusUnknown })
}

func TestReconnectResumesOrStartsFresh(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Model: "opus", Effort: "low"})
	if _, err := e.m.Reconnect(e.ctx(), s.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("reconnect while connected: %v", err)
	}
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	_ = e.terms.Exit(s.TerminalID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })

	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	spec2, _ := e.terms.Spec(r.TerminalID)
	if r.TerminalID == s.TerminalID || argOf(spec2.Argv, "--resume") != cid || argOf(spec2.Argv, "--model") != "opus" ||
		argOf(spec2.Argv, "--effort") != "low" || slices.Contains(spec2.Argv, "--session-id") {
		t.Errorf("reconnect argv = %q (terminal %s)", spec2.Argv, r.TerminalID)
	}
	if r.State != StateStarting || r.LastError != "" || r.DisconnectReason != "" {
		t.Errorf("reconnected = %+v", r)
	}
	_ = e.terms.SetAltScreen(r.TerminalID, true)
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })

	// A session that never got a message has nothing to resume.
	s2 := e.connected(CreateOptions{})
	_ = e.terms.Exit(s2.TerminalID, 0)
	e.waitFor(s2.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r2, err := e.m.Reconnect(e.ctx(), s2.ID)
	if err != nil {
		t.Fatal(err)
	}
	spec3, _ := e.terms.Spec(r2.TerminalID)
	if slices.Contains(spec3.Argv, "--resume") || argOf(spec3.Argv, "--session-id") == "" || !strings.Contains(r2.LastError, "started a new conversation") {
		t.Errorf("fresh reconnect argv=%q last_error=%q", spec3.Argv, r2.LastError)
	}
	if _, err := e.m.Reconnect(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
}

func TestFork(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Model: "sonnet", Name: "base"})
	if _, err := e.m.Fork(e.ctx(), s.ID, ""); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("fork without transcript: %v", err)
	}
	spec, _ := e.terms.Spec(s.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	fspec, _ := e.terms.Spec(f.TerminalID)
	if argOf(fspec.Argv, "--resume") != cid || !slices.Contains(fspec.Argv, "--fork-session") ||
		argOf(fspec.Argv, "--session-id") == cid || argOf(fspec.Argv, "--model") != "sonnet" {
		t.Errorf("fork argv = %q", fspec.Argv)
	}
	if f.ParentID != s.ID || f.Name != "base-fork" || f.ID == s.ID || f.WorktreePath != s.WorktreePath {
		t.Errorf("fork = %+v", f)
	}
}

func TestRemoveClosesThenForgets(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	done := make(chan error, 1)
	go func() { done <- e.m.Remove(e.ctx(), s.ID) }()
	e.waitWritten(s.TerminalID, keyEscape+keyCtrlC)
	_ = e.terms.Exit(s.TerminalID, 0)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Get(e.ctx(), s.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get after remove: %v", err)
	}
	var removed bool
	for !removed {
		select {
		case ev := <-e.events.C():
			if r, ok := ev.(Removed); ok && r.ID == s.ID {
				removed = true
			}
		case <-time.After(time.Second):
			t.Fatal("no Removed event")
		}
	}
	rows, _ := loadSessions(context.Background(), e.m.opts.DB)
	if len(rows) != 0 {
		t.Errorf("rows after remove: %+v", rows)
	}
}

func TestSessionsSurviveRestartAsDisconnected(t *testing.T) {
	e := newEnv(t)
	live := e.connected(CreateOptions{Name: "live"})
	spec, _ := e.terms.Spec(live.TerminalID)
	cid := argOf(spec.Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(live.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })

	// Clean shutdown: "daemon stopped".
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	e.open()
	got, err := e.m.Get(e.ctx(), live.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonStopped || got.ClaudeSessionID != cid ||
		got.Name != "live" || got.TerminalID != "" || got.WorktreePath != e.wt {
		t.Errorf("after restart = %+v", got)
	}
	// A row left live by a crash is repaired on load.
	got.State = StateConnected
	if err := saveSession(context.Background(), e.m.opts.DB, got); err != nil {
		t.Fatal(err)
	}
	e.open()
	if got, _ := e.m.Get(e.ctx(), live.ID); got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonRestarts {
		t.Errorf("after crash restart = %+v", got)
	}
	r, err := e.m.Reconnect(e.ctx(), live.ID)
	if err != nil {
		t.Fatal(err)
	}
	spec2, _ := e.terms.Spec(r.TerminalID)
	if argOf(spec2.Argv, "--resume") != cid {
		t.Errorf("reconnect after restart argv = %q", spec2.Argv)
	}
}

func TestInitialPromptIsTypedAfterConnect(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{InitialPrompt: "do the thing"})
	// Nothing is typed until the input box is on screen.
	time.Sleep(700 * time.Millisecond)
	if w := e.terms.Written(s.TerminalID); len(w) != 0 {
		t.Fatalf("typed %q before the prompt was drawn", w)
	}
	_ = e.terms.SetScreen(s.TerminalID, promptScreen)
	e.waitWritten(s.TerminalID, "do the thing"+keyEnter)
}

func TestEventsAndSnapshot(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	var states []State
	timeout := time.After(time.Second)
	for !slices.Contains(states, StateConnected) {
		select {
		case ev := <-e.events.C():
			if u, ok := ev.(Updated); ok && u.Session.ID == s.ID {
				states = append(states, u.Session.State)
			}
		case <-timeout:
			t.Fatalf("states seen: %v", states)
		}
	}
	if states[0] != StateStarting {
		t.Errorf("first state = %v", states[0])
	}
	snap := e.m.Snapshot()
	if len(snap.Sessions) != 1 || snap.Sessions[0].ID != s.ID {
		t.Errorf("snapshot = %+v", snap)
	}
}
