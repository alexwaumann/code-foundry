package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
)

// env is a Manager whose claude is the fake (fakeclaude_test.go) replaying a captured
// stream, with a fake repo store (r1 at wt) and a fake terminal store for the shells.
type env struct {
	t      *testing.T
	m      *Manager
	terms  *terminaltest.Fake
	repos  *repotest.Fake
	paths  ClaudePaths
	wt     string
	home   string // Options.Home: the cwd of a thread without a project
	dbPath string
	bus    *bus.Bus
	events *bus.Subscription[Event]

	// log and argv are the fake's stdin log and latest argv; spawns is the directory of
	// its per-process records (fakeclaude_test.go).
	log, argv, spawns string
	// mutate points claude at the fake; open applies it before its own mutators.
	mutate func(*Options)

	mu    sync.Mutex
	named []string
	namer func(string) (string, error)
}

// newEnv is newFixtureEnv with the text-table capture: every message gets one turn
// that ends in a result.
func newEnv(t *testing.T, mutate ...func(*Options)) *env {
	t.Helper()
	return newFixtureEnvAt(t, fixturePath("text-table"), nil, mutate...)
}

// newFixtureEnv is an env whose fake replays the capture fixture (claudestream/testdata).
func newFixtureEnv(t *testing.T, fixture string, mutate ...func(*Options)) *env {
	t.Helper()
	return newFixtureEnvAt(t, fixturePath(fixture), nil, mutate...)
}

// newFixtureEnvAt replays the capture at path (absolute); vars are added to the fake's
// environment (its knobs, fakeclaude_test.go).
func newFixtureEnvAt(t *testing.T, path string, vars []string, mutate ...func(*Options)) *env {
	t.Helper()
	dir := t.TempDir()
	e := &env{t: t, bus: bus.New(), log: filepath.Join(dir, "stdin.log"), argv: filepath.Join(dir, "argv.json"),
		spawns: filepath.Join(dir, "spawns")}
	if err := os.MkdirAll(e.spawns, 0o755); err != nil {
		t.Fatal(err)
	}
	e.mutate = func(o *Options) {
		o.Claude = os.Args[0]
		o.Env = append([]string{fakeClaudeEnv + "=" + path, "CF_FAKE_CLAUDE_LOG=" + e.log, "CF_FAKE_CLAUDE_ARGV=" + e.argv,
			"CF_FAKE_CLAUDE_SPAWN=" + e.spawns}, vars...)
		o.DisablePreTrust = true
	}
	e.terms = terminaltest.New(nil)
	e.repos = repotest.New(nil)
	// claude starts in the worktrees Create makes: they must exist.
	e.repos.WorktreeRoot, e.repos.MakeDirs = filepath.Join(dir, "worktrees"), true
	e.wt = filepath.Join(dir, "repo")
	if err := os.MkdirAll(e.wt, 0o755); err != nil {
		t.Fatal(err)
	}
	e.repos.Put(repo.Repo{ID: "r1", Path: e.wt, Name: "repo", Git: true, Worktrees: []repo.Worktree{{RepoID: "r1", Path: e.wt, IsMain: true}}})
	e.home = filepath.Join(dir, "home")
	if err := os.MkdirAll(e.home, 0o755); err != nil {
		t.Fatal(err)
	}
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
		DB: d, Terminals: e.terms, Repos: e.repos, Bus: e.bus, Paths: e.paths, Home: e.home,
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
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
	e.mutate(&opts)
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

// restart shuts the Manager down (live threads disconnect "daemon stopped") and opens
// a new one on the same database.
func (e *env) restart(mutate ...func(*Options)) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.m.Shutdown(ctx); err != nil {
		e.t.Fatal(err)
	}
	e.open(mutate...)
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

func (e *env) create(o CreateOptions) Session {
	e.t.Helper()
	if o.WorktreePath == "" && o.RepoID == "" && !o.NoProject {
		o.WorktreePath = e.wt
	}
	s, err := e.m.Create(e.ctx(), o)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

// connected creates a thread and waits until Claude answered the handshake and the
// status says so (the first reading is published after a debounce when no prompt was
// sent), so no update from the start is still on its way.
func (e *env) connected(o CreateOptions) Session {
	e.t.Helper()
	s := e.create(o)
	return e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected && s.Status != StatusUnknown })
}

// pid is the process id of the thread's running claude.
func (e *env) pid(id string) int {
	e.t.Helper()
	e.m.mu.Lock()
	defer e.m.mu.Unlock()
	rec, ok := e.m.recs[id]
	if !ok || rec.run == nil {
		e.t.Fatalf("thread %s has no process", id)
	}
	return rec.run.pid()
}

// spec is what the thread's running claude recorded about itself: argv, cwd, env.
func (e *env) spec(id string) fakeSpawn {
	e.t.Helper()
	path := filepath.Join(e.spawns, strconv.Itoa(e.pid(id))+".json")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if b, err := os.ReadFile(path); err == nil {
			var sp fakeSpawn
			if err := json.Unmarshal(b, &sp); err != nil {
				e.t.Fatal(err)
			}
			return sp
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("claude of %s never recorded its spawn", id)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// exit ends the thread's claude on its own: code 0 (/exit), 1 (a crash), or -1 (killed
// by a signal).
func (e *env) exit(id string, code int) {
	e.t.Helper()
	sig := syscall.SIGKILL
	switch code {
	case 0:
		sig = syscall.SIGUSR1
	case 1:
		sig = syscall.SIGUSR2
	}
	if sig != syscall.SIGKILL {
		// The fake handles SIGUSR1/2 once it has started (its spawn record is written
		// after signal.Notify); Go ignores them before that.
		e.spec(id)
	}
	if err := syscall.Kill(e.pid(id), sig); err != nil {
		e.t.Fatal(err)
	}
}

// sent returns what the daemon wrote to the fake's stdin, decoded.
func (e *env) sent() []map[string]any {
	data, _ := os.ReadFile(e.log)
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil {
			out = append(out, m)
		}
	}
	return out
}

// waitSent waits for a stdin line satisfying cond.
func (e *env) waitSent(what string, cond func(map[string]any) bool) map[string]any {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, m := range e.sent() {
			if cond(m) {
				return m
			}
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("never sent %s; sent %v", what, e.sent())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// sentSetCwd reports whether a set_cwd to path was sent.
func (e *env) sentSetCwd(path string) bool {
	return slices.ContainsFunc(e.sent(), isSetCwd(path))
}

func isSetCwd(path string) func(map[string]any) bool {
	return func(m map[string]any) bool {
		r, _ := m["request"].(map[string]any)
		return r["subtype"] == "set_cwd" && r["path"] == path
	}
}

func (e *env) items(id string) ItemsSnapshot {
	e.t.Helper()
	snap, err := e.m.Items(e.ctx(), id)
	if err != nil {
		e.t.Fatal(err)
	}
	return snap
}

// waitItems waits until the thread's items satisfy cond.
func (e *env) waitItems(id, what string, cond func([]Item) bool) []Item {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		items := e.items(id).Items
		if cond(items) {
			return items
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("timed out waiting for %s; items:\n%s", what, describeItems(items))
		}
		time.Sleep(5 * time.Millisecond)
	}
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

// sentinelLink is a pr-link record of a URL no fixture has. Once a session links it,
// every transcript line written before it has been read: a barrier for tests that
// assert something was not published.
const sentinelLink = `{"type":"pr-link","sessionId":"x","prNumber":999,"prUrl":"https://github.com/o/sentinel/pull/999","prRepository":"o/sentinel","timestamp":"2026-10-10T00:00:00Z"}`

func linkedSentinel(s Session) bool {
	return slices.ContainsFunc(s.LinkedPullRequests, func(l LinkedPullRequest) bool { return l.Number == 999 })
}

func userLine(text string) string {
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":%q}}`, text)
}

func TestCreateSpawnsClaude(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.DisablePreTrust = false })
	s := e.create(CreateOptions{WorktreePath: e.wt, Model: "opus", Effort: "high"})
	if s.State != StateStarting || s.RepoID != "r1" || s.WorktreePath != e.wt {
		t.Fatalf("created = %+v", s)
	}
	spec := e.spec(s.ID)
	if spec.Argv[0] != os.Args[0] || argOf(spec.Argv, "--model") != "opus" || argOf(spec.Argv, "--effort") != "high" {
		t.Errorf("argv = %q", spec.Argv)
	}
	if len(argOf(spec.Argv, "--session-id")) != 36 {
		t.Errorf("argv has no --session-id uuid: %q", spec.Argv)
	}
	if !samePath(spec.Cwd, e.wt) {
		t.Errorf("cwd = %q, want %q", spec.Cwd, e.wt)
	}
	cfg, err := os.ReadFile(e.paths.Config)
	if err != nil || !strings.Contains(string(cfg), realPath(e.wt)) || !strings.Contains(string(cfg), "hasTrustDialogAccepted") {
		t.Errorf("worktree not pre-trusted: %s (%v)", cfg, err)
	}
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })
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
	missing := filepath.Join(t.TempDir(), "no-such-claude")
	bad := newEnv(t, func(o *Options) { o.Claude = missing })
	if _, err := bad.m.Create(bad.ctx(), CreateOptions{RepoID: "r1"}); err == nil {
		t.Fatal("spawn failure not reported")
	}
	if n := len(bad.m.Snapshot().Sessions); n != 0 {
		t.Errorf("failed create left a row: %d sessions", n)
	}
}

func TestExitWithoutCloseDisconnects(t *testing.T) {
	for _, tt := range []struct {
		code   int
		reason string
	}{{0, ReasonExited}, {1, ReasonCrashed}, {-1, ReasonCrashed}} {
		t.Run(fmt.Sprint(tt.code), func(t *testing.T) {
			e := newEnv(t)
			s := e.connected(CreateOptions{})
			e.exit(s.ID, tt.code)
			got := e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
			if got.DisconnectReason != tt.reason || got.ExitCode != tt.code {
				t.Errorf("session = %+v", got)
			}
			if tt.code == 1 && !strings.Contains(got.LastError, "fake claude: exit 1") {
				t.Errorf("last error %q, want the stderr line", got.LastError)
			}
		})
	}
}

// Close closes Claude's stdin and waits for it to exit; a thread that is gone is a
// no-op.
func TestCloseIsGraceful(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.State != StateDisconnected || got.DisconnectReason != ReasonClosed || got.ExitCode != 0 {
		t.Errorf("after close = %+v", got)
	}
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Errorf("second close: %v", err)
	}
}

// A claude that outlives its closed stdin is terminated after CloseTimeout.
func TestCloseTerminatesAfterTimeout(t *testing.T) {
	e := newFixtureEnvAt(t, fixturePath("text-table"), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=1m"},
		func(o *Options) { o.CloseTimeout = 100 * time.Millisecond })
	s := e.connected(CreateOptions{})
	start := time.Now()
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.DisconnectReason != ReasonClosed || got.ExitCode != -1 {
		t.Errorf("after terminate = %+v", got)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Errorf("close took %v", el)
	}
}

func TestTranscriptDiscoveryAndAutoNaming(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
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
	e.writeTranscript(argOf(e.spec(s.ID).Argv, "--session-id"), userLine("hello there"))
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
	pid := e.pid(s.ID)
	_ = os.MkdirAll(filepath.Join(e.paths.Dir, "sessions"), 0o755)
	if err := os.WriteFile(e.paths.pidFile(pid), []byte(fmt.Sprintf(`{"pid":%d,"sessionId":"rotated-id"}`, pid)), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	e.writeTranscript("rotated-id", `{"type":"mode"}`)
	e.waitFor(s.ID, "rotated id", func(s Session) bool { return s.ClaudeSessionID == "rotated-id" })
}

func TestReconnectResumesOrStartsFresh(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Model: "opus", Effort: "low"})
	if _, err := e.m.Reconnect(e.ctx(), s.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("reconnect while connected: %v", err)
	}
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	e.exit(s.ID, 0)
	e.waitFor(s.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })

	r, err := e.m.Reconnect(e.ctx(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	argv := e.spec(s.ID).Argv
	if argOf(argv, "--resume") != cid || argOf(argv, "--model") != "opus" ||
		argOf(argv, "--effort") != "low" || slices.Contains(argv, "--session-id") {
		t.Errorf("reconnect argv = %q", argv)
	}
	if r.State != StateStarting || r.LastError != "" || r.DisconnectReason != "" {
		t.Errorf("reconnected = %+v", r)
	}
	e.waitFor(s.ID, "connected", func(s Session) bool { return s.State == StateConnected })

	// A session that never got a message has nothing to resume.
	s2 := e.connected(CreateOptions{})
	e.exit(s2.ID, 0)
	e.waitFor(s2.ID, "disconnected", func(s Session) bool { return s.State == StateDisconnected })
	r2, err := e.m.Reconnect(e.ctx(), s2.ID)
	if err != nil {
		t.Fatal(err)
	}
	argv = e.spec(s2.ID).Argv
	if slices.Contains(argv, "--resume") || argOf(argv, "--session-id") == "" || !strings.Contains(r2.LastError, "started a new conversation") {
		t.Errorf("fresh reconnect argv=%q last_error=%q", argv, r2.LastError)
	}
	if _, err := e.m.Reconnect(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
}

func TestFork(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{Model: "sonnet", Name: "Base work"})
	if _, err := e.m.Fork(e.ctx(), s.ID, ""); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("fork without transcript: %v", err)
	}
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	fargv := e.spec(f.ID).Argv
	if argOf(fargv, "--resume") != cid || !slices.Contains(fargv, "--fork-session") ||
		argOf(fargv, "--session-id") == cid || argOf(fargv, "--model") != "sonnet" {
		t.Errorf("fork argv = %q", fargv)
	}
	if f.ParentID != s.ID || f.Name != "Base work (fork)" || f.AutoNamed || f.ID == s.ID || f.WorktreePath != s.WorktreePath {
		t.Errorf("fork = %+v", f)
	}
	e.waitFor(f.ID, "fork connected", func(s Session) bool { return s.State == StateConnected })
	if _, err := e.m.Items(e.ctx(), f.ID); err != nil {
		t.Errorf("fork items: %v", err)
	}
}

func TestRemoveClosesThenForgets(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{})
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
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
	cid := argOf(e.spec(live.ID).Argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(live.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })

	// Clean shutdown: "daemon stopped".
	e.restart()
	got, err := e.m.Get(e.ctx(), live.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonStopped || got.ClaudeSessionID != cid ||
		got.Name != "live" || got.WorktreePath != e.wt {
		t.Errorf("after restart = %+v", got)
	}
	// A row left live by a crash is repaired on load.
	got.State = StateConnected
	if err := saveSession(context.Background(), e.m.opts.DB, got); err != nil {
		t.Fatal(err)
	}
	e.restart()
	if got, _ := e.m.Get(e.ctx(), live.ID); got.State != StateDisconnected || got.DisconnectReason != ReasonDaemonRestarts {
		t.Errorf("after crash restart = %+v", got)
	}
	if _, err := e.m.Reconnect(e.ctx(), live.ID); err != nil {
		t.Fatal(err)
	}
	if argv := e.spec(live.ID).Argv; argOf(argv, "--resume") != cid {
		t.Errorf("reconnect after restart argv = %q", argv)
	}
}

func TestPermissionModeIsKeptForReconnectAndFork(t *testing.T) {
	e := newEnv(t)
	s := e.connected(CreateOptions{PermissionMode: PermissionAcceptEdits, InitialPrompt: "hi"})
	argv := e.spec(s.ID).Argv
	if argOf(argv, "--permission-mode") != "acceptEdits" {
		t.Errorf("create argv = %q", argv)
	}
	cid := argOf(argv, "--session-id")
	e.writeTranscript(cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Session) bool { return s.ClaudeSessionID == cid })
	e.restart()
	got, _ := e.m.Get(e.ctx(), s.ID)
	if got.PermissionMode != PermissionAcceptEdits {
		t.Fatalf("after restart = %+v", got)
	}
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	argv = e.spec(s.ID).Argv
	if argOf(argv, "--resume") != cid || argOf(argv, "--permission-mode") != "acceptEdits" || slices.Contains(argv, "hi") {
		t.Errorf("reconnect argv = %q", argv)
	}
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	argv = e.spec(f.ID).Argv
	if f.PermissionMode != PermissionAcceptEdits || argOf(argv, "--permission-mode") != "acceptEdits" || slices.Contains(argv, "hi") {
		t.Errorf("fork = %+v argv = %q", f, argv)
	}
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
