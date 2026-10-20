package ember

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// env is a Store on a real database and the thread store's fake, in a test directory,
// with settings it sets, a fake consolidation and a fixed clock.
type env struct {
	t       *testing.T
	s       *Store
	threads *threadtest.Fake
	bus     *bus.Bus
	dir     string
	opts    Options

	mu        sync.Mutex
	cfg       Config
	now       time.Time
	prompts   []string
	answer    string
	answerErr error
	skillDirs []string
}

type projectsFake struct{ snap *project.Snapshot }

func (p projectsFake) Snapshot() *project.Snapshot { return p.snap }

func newEnv(t *testing.T, mods ...func(*env)) *env {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	database, err := db.Open(ctx, filepath.Join(root, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	b := bus.New()
	e := &env{t: t, threads: threadtest.New(b), bus: b, dir: filepath.Join(root, "residents", "ember"),
		now: now, answer: "# Memory\n\n- consolidated\n", cfg: defaultConfig}
	e.threads.Now = e.clock
	e.opts = Options{
		DB: database, Bus: b, Log: slog.New(slog.DiscardHandler), Threads: e.threads, Config: e.config, Dir: e.dir,
		Projects: projectsFake{&project.Snapshot{Projects: []project.Project{{ID: "p-1", Name: "app", Path: "/u/app", DefaultBranch: "main", Git: true}}}},
		Now:      e.clock, Location: utc, CheckInterval: time.Hour,
		Consolidate: func(_ context.Context, model, prompt string) (string, error) {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.prompts = append(e.prompts, model+"\n"+prompt)
			return e.answer, e.answerErr
		},
		InstallSkill: func(dir string) error {
			e.mu.Lock()
			defer e.mu.Unlock()
			e.skillDirs = append(e.skillDirs, dir)
			return os.MkdirAll(filepath.Join(dir, ".claude", "skills", "code-foundry-ember"), 0o700)
		},
	}
	for _, m := range mods {
		m(e)
	}
	e.s, err = New(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.s.Close)
	return e
}

func (e *env) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now
}

func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	e.now = e.now.Add(d)
	e.mu.Unlock()
}

// defaultConfig is the settings' defaults.
var defaultConfig = Config{
	Model: "claude-opus-4-8[1m]", Effort: "high", WorkerModels: []string{"claude-opus-4-7[1m]", "claude-opus-4-8[1m]"},
	WorkerEffort: "high", EpochContextTokens: 400000, EpochMaxHours: 24,
}

func (e *env) config() Config {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.cfg
	c.WorkerModels = slices.Clone(c.WorkerModels)
	return c
}

// set changes the settings and waits until the store applied them.
func (e *env) set(change func(*Config)) {
	e.t.Helper()
	e.mu.Lock()
	change(&e.cfg)
	want := e.cfg
	e.mu.Unlock()
	e.s.ConfigChanged()
	e.await("settings applied", func(*Snapshot) bool {
		e.s.mu.Lock()
		defer e.s.mu.Unlock()
		return e.s.applied && reflect.DeepEqual(e.s.cfg, want)
	})
}

func on(c *Config) { c.Enabled = true }

// await waits for cond on the store's snapshot.
func (e *env) await(what string, cond func(*Snapshot) bool) *Snapshot {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if snap := e.s.Snapshot(); cond(snap) {
			return snap
		}
		time.Sleep(5 * time.Millisecond)
	}
	e.t.Fatalf("timed out waiting for %s; snapshot %+v", what, e.s.Snapshot().Status)
	return nil
}

func (e *env) resident() thread.Thread {
	e.t.Helper()
	t, ok := residentOf(e.threads.Snapshot())
	if !ok {
		e.t.Fatal("no resident thread")
	}
	return t
}

func (e *env) calls(prefix string) []string {
	var out []string
	for _, c := range e.threads.Calls() {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// Off at start: no resident, but its rules and the worker hook are set; enabling makes
// the resident, seeded, in its home.
func TestEnable(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if st := e.s.Snapshot().Status; st.Enabled || st.ThreadID != "" {
		t.Fatalf("status = %+v", st)
	}
	if got := e.calls("EnsureResident"); len(got) != 0 {
		t.Fatalf("calls = %q", got)
	}
	if tools := e.threads.ResidentTools(Name); !slices.Contains(tools.Allow, "Bash(code-foundry ember:*)") || !slices.Contains(tools.Allow, "Bash(git fetch:*)") || !slices.Contains(tools.Deny, "Edit") {
		t.Errorf("tools = %+v", tools)
	}
	e.set(on)
	st := e.await("the resident", func(s *Snapshot) bool { return s.Status.ThreadID != "" }).Status
	r := e.resident()
	if !st.Enabled || st.Epoch != 1 || st.EpochContextTokens != 400000 || r.Name != DisplayName || r.WorktreePath != e.dir ||
		r.Model != "claude-opus-4-8[1m]" || r.Effort != "high" || r.PermissionMode != thread.PermissionAuto {
		t.Errorf("status %+v, resident %+v", st, r)
	}
	if !strings.HasPrefix(r.SystemPromptAppend, "# You are Ember") || !strings.Contains(r.SystemPromptAppend, "# Soul") {
		t.Errorf("system prompt = %q", r.SystemPromptAppend)
	}
	if want := []string{filepath.Join(e.dir, "skills"), filepath.Join(e.dir, "seed")}; !slices.Equal(r.SpawnAddDirs, want) {
		t.Errorf("add dirs = %q", r.SpawnAddDirs)
	}
	for _, f := range []string{soulFile, memoryFile, "seed/BOARD.md", "seed/PROJECTS.md", "seed/RECENT.md"} {
		if _, err := os.Stat(filepath.Join(e.dir, f)); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(e.dir, "seed", "PROJECTS.md")); !strings.Contains(string(b), "**app** (`p-1`)") {
		t.Errorf("PROJECTS.md = %q", b)
	}
	if len(e.skillDirs) != 1 || e.skillDirs[0] != filepath.Join(e.dir, "skills") {
		t.Errorf("skill installed in %q", e.skillDirs)
	}

	// The model and effort apply to it at once.
	e.set(func(c *Config) { c.Model, c.Effort = "claude-haiku-5-5[1m]", "medium" })
	if r := e.resident(); r.Model != "claude-haiku-5-5[1m]" || r.Effort != "medium" {
		t.Errorf("after the change: %s %s", r.Model, r.Effort)
	}

	// Off: its timers go; a running process stops; the thread stays.
	e.threads.Put(func() thread.Thread { r := e.resident(); r.State = thread.StateConnected; return r }())
	e.set(func(c *Config) { c.Enabled = false })
	e.await("off", func(s *Snapshot) bool { return !s.Status.Enabled && s.Status.ThreadID == r.ID })
	deadline := time.Now().Add(5 * time.Second)
	for len(e.calls("Close")) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := e.calls("Close"); len(got) != 1 {
		t.Errorf("Close calls = %q", got)
	}
	if got := e.calls("Unsubscribe"); len(got) != 1 {
		t.Errorf("Unsubscribe calls = %q", got)
	}

	// On again: the same thread, not a second one.
	e.set(on)
	if got := e.calls("EnsureResident"); len(got) != 1 {
		t.Errorf("EnsureResident calls = %q", got)
	}
}

// A resident made without Ember's seed (by hand) is seeded when Ember is enabled.
func TestEnableSeedsAnUnseededResident(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if _, _, err := e.threads.EnsureResident(context.Background(), Name, thread.ResidentOptions{Cwd: "/x"}); err != nil {
		t.Fatal(err)
	}
	e.set(on)
	if got := e.calls("Reseed"); len(got) != 1 {
		t.Fatalf("Reseed calls = %q", got)
	}
	if r := e.resident(); !strings.HasPrefix(r.SeedPrefix, SeedHeader) || r.Epoch != 2 {
		t.Errorf("resident = %+v", r)
	}
}

func TestEpochDue(t *testing.T) {
	started := now.Add(-2 * time.Hour)
	cfg := Config{EpochContextTokens: 400000, EpochMaxHours: 24}
	quiet := thread.Thread{ID: "s-e", State: thread.StateConnected, Status: thread.StatusIdle, LastResultAt: now.Add(-time.Minute), ContextTokens: 500000}
	tests := []struct {
		name string
		t    func(thread.Thread) thread.Thread
		at   time.Time
		want string
	}{
		{"context past the limit", nil, now, "context"},
		{"under the limit", func(t thread.Thread) thread.Thread { t.ContextTokens = 1000; return t }, now, ""},
		{"too old", func(t thread.Thread) thread.Thread { t.ContextTokens = 1000; return t }, started.Add(25 * time.Hour), "age"},
		{"attention, finished", func(t thread.Thread) thread.Thread { t.Status = thread.StatusNeedsAttention; return t }, now, "context"},
		{"busy", func(t thread.Thread) thread.Thread { t.Status = thread.StatusBusy; return t }, now, ""},
		{"starting", func(t thread.Thread) thread.Thread { t.State = thread.StateStarting; return t }, now, ""},
		{"a pending request", func(t thread.Thread) thread.Thread { t.PendingRequestID = "r"; return t }, now, ""},
		{"a reseed waits", func(t thread.Thread) thread.Thread { t.ReseedPending = true; return t }, now, ""},
		{"a seed waits", func(t thread.Thread) thread.Thread { t.SeedPrefix, t.FreshStart = "x", true; return t }, now, ""},
		{"a wake pending", func(t thread.Thread) thread.Thread { t.WakePending = true; return t }, now, ""},
		{"no turn this epoch", func(t thread.Thread) thread.Thread { t.LastResultAt = started.Add(-time.Minute); return t }, now, ""},
		{"never a turn", func(t thread.Thread) thread.Thread { t.LastResultAt = time.Time{}; return t }, now, ""},
		{"stopped after a turn", func(t thread.Thread) thread.Thread { t.State = thread.StateDisconnected; return t }, now, "context"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := quiet
			if tt.t != nil {
				th = tt.t(th)
			}
			if got := epochDue(th, cfg, started, tt.at); got != tt.want {
				t.Errorf("epochDue = %q, want %q", got, tt.want)
			}
		})
	}
}

// Past the context limit after a turn, the store consolidates the memory, rebuilds the
// seed with the conversation, and reseeds: a new epoch.
func TestAutomaticEpoch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.set(func(c *Config) { c.Enabled, c.EpochContextTokens = true, 20000 })
	r := e.resident()
	e.advance(time.Minute)
	e.threads.PutItems(r.ID,
		thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "Add a README line", CreatedAt: e.clock()},
		thread.Item{ID: "a1", Kind: thread.KindAssistantText, Text: "On it.", CreatedAt: e.clock()},
		thread.Item{ID: "w1", Kind: thread.KindUserMessage, Origin: thread.OriginWake, Text: "[code-foundry wake] …", CreatedAt: e.clock()},
		thread.Item{ID: "a2", Kind: thread.KindAssistantText, Text: "Done: the line is in.", CreatedAt: e.clock()},
	)
	if _, err := e.s.AddTask(context.Background(), NewTask{Title: "README line"}); err != nil {
		t.Fatal(err)
	}
	r.State, r.Status, r.ContextTokens, r.LastResultAt = thread.StateConnected, thread.StatusIdle, 25000, e.clock()
	e.threads.Put(r)
	st := e.await("the new epoch", func(s *Snapshot) bool { return s.Status.Epoch == 2 && !s.Status.Consolidating }).Status
	if st.LastConsolidationError != "" || !st.EpochStartedAt.Equal(e.clock()) {
		t.Errorf("status = %+v", st)
	}
	e.mu.Lock()
	prompts := slices.Clone(e.prompts)
	e.mu.Unlock()
	if len(prompts) != 1 || !strings.HasPrefix(prompts[0], "claude-opus-4-8[1m]\n") ||
		!strings.Contains(prompts[0], "### 2026-10-20 14:06 · user\nAdd a README line") ||
		!strings.Contains(prompts[0], "[todo] README line") || strings.Contains(prompts[0], "code-foundry wake") {
		t.Errorf("consolidation prompts = %q", prompts)
	}
	if b, _ := os.ReadFile(filepath.Join(e.dir, memoryFile)); string(b) != "# Memory\n\n- consolidated\n" {
		t.Errorf("MEMORY.md = %q", b)
	}
	got := e.resident()
	for _, w := range []string{SeedHeader, "- consolidated", "t-", "README line", "**app**", "Add a README line",
		"### 2026-10-20 14:06 · Ember\nOn it.\n\n### 2026-10-20 14:06 · Ember\nDone: the line is in."} {
		if !strings.Contains(got.SeedPrefix, w) {
			t.Errorf("seed prefix lacks %q", w)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(e.dir, consolDir)); len(entries) != 2 {
		t.Errorf("consolidation files = %v", entries)
	}
	// It does not fire again for the same epoch.
	e.threads.Put(e.resident())
	time.Sleep(50 * time.Millisecond)
	if got := e.calls("Reseed"); len(got) != 1 {
		t.Errorf("Reseed calls = %q", got)
	}
}

// A consolidation that fails or answers badly keeps MEMORY.md; the reseed still goes.
func TestConsolidationKeepsMemory(t *testing.T) {
	for _, tc := range []struct {
		name, answer string
		err          error
	}{{"an error", "", errors.New("rate limited")}, {"no heading", "Here is the memory:\n- x", nil}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			e.set(on)
			r := e.resident()
			e.advance(time.Minute)
			e.threads.PutItems(r.ID, thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi", CreatedAt: e.clock()})
			e.mu.Lock()
			e.answer, e.answerErr = tc.answer, tc.err
			e.mu.Unlock()
			before, _ := os.ReadFile(filepath.Join(e.dir, memoryFile))
			st, err := e.s.Reseed(context.Background())
			if err != nil || st.Epoch != 2 || st.LastConsolidationError == "" {
				t.Fatalf("Reseed = %+v, %v", st, err)
			}
			if after, _ := os.ReadFile(filepath.Join(e.dir, memoryFile)); string(after) != string(before) {
				t.Errorf("MEMORY.md changed to %q", after)
			}
		})
	}
}

func TestReseedRefusals(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if _, err := e.s.Reseed(context.Background()); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("off: err = %v", err)
	}
	e.set(on)
	// Nothing to consolidate: no claude call, but a new epoch.
	st, err := e.s.Reseed(context.Background())
	if err != nil || st.Epoch != 2 || len(e.prompts) != 0 {
		t.Errorf("Reseed = %+v, %v, prompts %d", st, err, len(e.prompts))
	}
}

func TestVisibleMessages(t *testing.T) {
	at := func(m int) time.Time { return today.Add(time.Duration(m) * time.Minute) }
	items := []thread.Item{
		{Kind: thread.KindUserMessage, Text: "old", CreatedAt: at(0)},
		{Kind: thread.KindUserMessage, Text: "plan it", CreatedAt: at(2)},
		{Kind: thread.KindThinking, Text: "hmm", CreatedAt: at(2)},
		{Kind: thread.KindAssistantText, Text: "First.", CreatedAt: at(3)},
		{Kind: thread.KindToolCall, CreatedAt: at(3)},
		{Kind: thread.KindAssistantText, Text: "Second.", CreatedAt: at(4)},
		{Kind: thread.KindAssistantText, Text: "subagent", ParentToolUseID: "tu", CreatedAt: at(4)},
		{Kind: thread.KindUserMessage, Origin: thread.OriginWake, Text: "[code-foundry wake]", CreatedAt: at(5)},
		{Kind: thread.KindAssistantText, Text: "Worker done.", CreatedAt: at(6)},
		{Kind: thread.KindAssistantText, Text: "streaming", Streaming: true, CreatedAt: at(7)},
	}
	got := visibleMessages(items, at(1))
	want := []Message{{At: at(2), User: true, Text: "plan it"}, {At: at(3), Text: "First.\n\nSecond."}, {At: at(6), Text: "Worker done."}}
	if !slices.Equal(got, want) {
		t.Errorf("visibleMessages = %+v\nwant %+v", got, want)
	}
}

// Threads Ember and its descendants create without a model alternate between the
// worker models at the worker effort; an explicit model wins; other threads are left
// alone. The rotation survives a restart.
func TestWorkerDefaults(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.set(func(c *Config) {
		c.Enabled, c.WorkerModels, c.WorkerEffort = true, []string{"claude-opus-4-7[1m]", "claude-sonnet-5[1m]"}, "xhigh"
	})
	r := e.resident()
	ctx := context.Background()
	create := func(o thread.CreateOptions) thread.Thread {
		t.Helper()
		s, err := e.threads.Create(ctx, o)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	w1 := create(thread.CreateOptions{CreatedBy: r.ID, Model: "claude-sonnet-5[1m]", Effort: "medium", ModelDefaulted: true, EffortDefaulted: true})
	lead := create(thread.CreateOptions{CreatedBy: r.ID})
	w3 := create(thread.CreateOptions{CreatedBy: lead.ID})
	explicit := create(thread.CreateOptions{CreatedBy: r.ID, Model: "claude-haiku-5-5[1m]", Effort: "low"})
	user := create(thread.CreateOptions{Model: "claude-sonnet-5[1m]", ModelDefaulted: true})
	other := create(thread.CreateOptions{CreatedBy: user.ID, Model: "claude-sonnet-5[1m]", ModelDefaulted: true})
	for _, c := range []struct {
		name          string
		got           thread.Thread
		model, effort string
	}{
		{"first worker", w1, "claude-opus-4-7[1m]", "xhigh"},
		{"a lead", lead, "claude-sonnet-5[1m]", "xhigh"},
		{"the lead's worker", w3, "claude-opus-4-7[1m]", "xhigh"},
		{"explicit", explicit, "claude-haiku-5-5[1m]", "low"},
		{"the user's", user, "claude-sonnet-5[1m]", ""},
		{"another thread's child", other, "claude-sonnet-5[1m]", ""},
	} {
		if c.got.Model != c.model || c.got.Effort != c.effort {
			t.Errorf("%s: %s %s, want %s %s", c.name, c.got.Model, c.got.Effort, c.model, c.effort)
		}
	}
	if st := loadState(e.s.log, e.dir); st.WorkerNext != 3 {
		t.Errorf("persisted worker counter = %d", st.WorkerNext)
	}
}

func TestTasks(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	ctx := context.Background()
	worker, err := e.threads.Create(ctx, thread.CreateOptions{Name: "worker"})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := e.s.AddTask(ctx, NewTask{Title: " Ship docs ", Detail: "all of them"})
	if err != nil || parent.State != StateTodo || parent.Title != "Ship docs" || !strings.HasPrefix(parent.ID, "t-") || len(parent.ID) != 10 {
		t.Fatalf("AddTask = %+v, %v", parent, err)
	}
	child, err := e.s.AddTask(ctx, NewTask{Title: "README", ParentID: parent.ID, ThreadID: worker.ID, State: StateDoing})
	if err != nil || child.Thread == nil || child.Thread.Name != "worker" || child.Position <= parent.Position {
		t.Fatalf("child = %+v, %v", child, err)
	}
	for _, bad := range []struct {
		name string
		n    NewTask
		want error
	}{
		{"no title", NewTask{}, ErrInvalidArgument},
		{"two lines", NewTask{Title: "a\nb"}, ErrInvalidArgument},
		{"a grandchild", NewTask{Title: "x", ParentID: child.ID}, ErrInvalidArgument},
		{"no such parent", NewTask{Title: "x", ParentID: "t-ffffffff"}, ErrNotFound},
		{"no such thread", NewTask{Title: "x", ThreadID: "s-nope"}, ErrInvalidArgument},
	} {
		if _, err := e.s.AddTask(ctx, bad.n); !errors.Is(err, bad.want) {
			t.Errorf("%s: err = %v", bad.name, err)
		}
	}

	// A done report does not finish the task; a failed one blocks it.
	e.advance(time.Minute)
	if _, err := e.threads.Report(ctx, worker.ID, thread.Report{Status: thread.ReportDone, Summary: "pushed"}); err != nil {
		t.Fatal(err)
	}
	e.await("the report", func(s *Snapshot) bool {
		c, _ := s.Task(child.ID)
		return c.Thread != nil && c.Thread.Report.Status == thread.ReportDone
	})
	if c, _ := e.s.Snapshot().Task(child.ID); c.State != StateDoing {
		t.Errorf("after a done report: %s", c.State)
	}
	e.advance(time.Minute)
	if _, err := e.threads.Report(ctx, worker.ID, thread.Report{Status: thread.ReportFailed, Summary: "tests fail"}); err != nil {
		t.Fatal(err)
	}
	c := func() Task {
		s := e.await("blocked", func(s *Snapshot) bool { c, _ := s.Task(child.ID); return c.State == StateBlocked })
		c, _ := s.Task(child.ID)
		return c
	}()
	if c.Outcome != "tests fail" {
		t.Errorf("blocked outcome = %q", c.Outcome)
	}
	// Ember puts it back to doing: the same report does not block it again.
	doing := StateDoing
	e.advance(time.Minute)
	if _, err := e.s.UpdateTask(ctx, child.ID, TaskUpdate{State: &doing}); err != nil {
		t.Fatal(err)
	}
	e.threads.Put(func() thread.Thread { w, _ := e.threads.Snapshot().Thread(worker.ID); return w }())
	time.Sleep(20 * time.Millisecond)
	if c, _ := e.s.Snapshot().Task(child.ID); c.State != StateDoing {
		t.Errorf("re-blocked: %s", c.State)
	}

	// Done stamps done_at; leaving done clears it.
	done, outcome := StateDone, "merged"
	got, err := e.s.UpdateTask(ctx, child.ID, TaskUpdate{State: &done, Outcome: &outcome})
	if err != nil || got.DoneAt.IsZero() || got.Outcome != "merged" {
		t.Errorf("done = %+v, %v", got, err)
	}
	todo := StateTodo
	if got, _ := e.s.UpdateTask(ctx, child.ID, TaskUpdate{State: &todo}); !got.DoneAt.IsZero() {
		t.Errorf("reopened keeps done_at")
	}
	if _, err := e.s.UpdateTask(ctx, "t-00000000", TaskUpdate{State: &todo}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown task err = %v", err)
	}

	// A removed worker keeps the task; the board says so.
	if err := e.threads.Remove(ctx, worker.ID); err != nil {
		t.Fatal(err)
	}
	e.await("removed", func(s *Snapshot) bool { c, _ := s.Task(child.ID); return c.Thread != nil && c.Thread.Removed })
	if st := e.s.Snapshot().Status.Counts; st.Todo != 2 {
		t.Errorf("counts = %+v", st)
	}

	// Persisted, in board order.
	e.s.Close()
	again, err := New(ctx, e.opts)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if ids := again.TaskIDs(); !slices.Equal(ids, []string{parent.ID, child.ID}) {
		t.Errorf("after a restart: %q", ids)
	}
	if c, _ := again.Snapshot().Task(child.ID); c.Detail != "" || c.ParentID != parent.ID || c.ThreadID != worker.ID {
		t.Errorf("reloaded = %+v", c)
	}
}
