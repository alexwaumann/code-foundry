package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream/fakeclaude"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// fakeClaudeBin is cmd/fakeclaude, built once per test run (a separate binary: see
// internal/store/thread/fakeclaude_test.go).
var fakeClaudeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakeclaude")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fakeClaudeBin = filepath.Join(dir, "claude")
	build := exec.Command("go", "build", "-o", fakeClaudeBin, "github.com/alexwaumann/code-foundry/cmd/fakeclaude")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "build cmd/fakeclaude:", err)
		os.Exit(2)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// fakeThreads is the thread store as the search store sees it.
type fakeThreads struct {
	mu      sync.Mutex
	threads []thread.Thread
	// verify answers VerifyQuote; nil accepts every quote as item #4 of the thread.
	verify  func(threadID, item, quote string) (thread.QuotedItem, error)
	created []thread.CreateOptions
}

func (f *fakeThreads) Snapshot() *thread.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &thread.Snapshot{Threads: slices.Clone(f.threads)}
}

func (f *fakeThreads) VerifyQuote(_ context.Context, threadID, item, quote string) (thread.QuotedItem, error) {
	if f.verify != nil {
		return f.verify(threadID, item, quote)
	}
	t, ok := f.Snapshot().Thread(threadID)
	if !ok {
		return thread.QuotedItem{}, fmt.Errorf("%w: no thread %q", thread.ErrNotFound, threadID)
	}
	return thread.QuotedItem{Thread: t, ItemID: threadID + "-item-" + strings.TrimPrefix(item, "#"), Ordinal: 4, Kind: thread.KindAssistantText,
		Speaker: thread.SpeakerAssistant, CreatedAt: time.UnixMilli(1000), Quote: quote}, nil
}

func (f *fakeThreads) Create(_ context.Context, o thread.CreateOptions) (thread.Thread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, o)
	return thread.Thread{ID: "s-promoted"}, nil
}

func (f *fakeThreads) remove(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.threads = slices.DeleteFunc(f.threads, func(t thread.Thread) bool { return t.ID == id })
}

type harness struct {
	s       *Store
	threads *fakeThreads
	dir     string
	claude  string // Claude's config dir
	spawns  string // CF_FAKE_CLAUDE_SPAWN
	log     string // CF_FAKE_CLAUDE_LOG
	bus     *bus.Bus
}

// newHarness opens a store over a test database whose runs replay fixture (a file in
// testdata) with env added.
func newHarness(t *testing.T, fixture string, o Options, env ...string) *harness {
	t.Helper()
	tmp := t.TempDir()
	h := &harness{dir: filepath.Join(tmp, "search"), claude: filepath.Join(tmp, "claude"), spawns: filepath.Join(tmp, "spawns"),
		log: filepath.Join(tmp, "stdin.log"), bus: bus.New(),
		threads: &fakeThreads{threads: []thread.Thread{{ID: "s-aaa", Name: "Poller design"}, {ID: "s-bbb", Name: "Other"}}}}
	if err := os.MkdirAll(h.spawns, 0o700); err != nil {
		t.Fatal(err)
	}
	abs, _ := filepath.Abs(filepath.Join("testdata", fixture))
	o.DB, o.Threads, o.Bus, o.Claude, o.ClaudeDir, o.Dir = dbtest.Open(t), h.threads, h.bus, fakeClaudeBin, h.claude, h.dir
	o.Env = append([]string{fakeclaude.Env + "=" + abs, "CF_FAKE_CLAUDE_SPAWN=" + h.spawns, "CF_FAKE_CLAUDE_LOG=" + h.log}, env...)
	o.UtilityModel = func() string { return "claude-sonnet-5-5" }
	o.KillGrace = 200 * time.Millisecond
	if o.StartTimeout == 0 {
		o.StartTimeout = 10 * time.Second
	}
	s, err := New(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	h.s = s
	return h
}

func (h *harness) wait(t *testing.T, id string) Entry {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	e, err := h.s.Wait(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func (h *harness) spawn(t *testing.T) fakeclaude.Spawn {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(h.spawns, "*.json"))
	if len(files) != 1 {
		t.Fatalf("spawns = %v, want one", files)
	}
	b, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	var sp fakeclaude.Spawn
	if err := json.Unmarshal(b, &sp); err != nil {
		t.Fatal(err)
	}
	return sp
}

// A run: its command line and place, its steps from the tool calls, a hit reported while
// it runs, its answer, cost and unseen flag.
func TestAgentSearchRun(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "go")
	h := newHarness(t, "agent.jsonl", Options{}, "CF_FAKE_CLAUDE_INIT_GATE="+gate)
	sub := bus.Subscribe[Changed](h.bus, 256)
	defer sub.Close()
	e, err := h.s.StartAgent(context.Background(), "  where did we decide the poller skips reruns?  ")
	if err != nil {
		t.Fatal(err)
	}
	if e.Status != StatusRunning || e.Query != "where did we decide the poller skips reruns?" || e.Model != "claude-sonnet-5-5" || e.ClaudeSessionID == "" {
		t.Fatalf("started = %+v", e)
	}
	hit, left, err := h.s.Report(context.Background(), e.ID, "s-aaa", "#4", "not refetch", "  says\nso ")
	if err != nil {
		t.Fatal(err)
	}
	if hit.N != 1 || hit.ThreadName != "Poller design" || hit.Why != "says so" || hit.Ordinal != 4 || left != MaxHits-1 {
		t.Errorf("hit = %+v, left %d", hit, left)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got := h.wait(t, e.ID)
	if got.Status != StatusDone || got.Answer != "The poller skips reruns [1]." || got.CostUSD != 0.0123 || !got.Unseen || got.FinishedAt.IsZero() {
		t.Errorf("finished = %+v", got)
	}
	var texts []string
	for _, st := range got.Steps {
		texts = append(texts, st.Text)
	}
	want := []string{"Searched poller refetch · 3 hits", "Read Poller design · #3–#5", "List home · failed"}
	if !slices.Equal(texts, want) {
		t.Errorf("steps = %q, want %q", texts, want)
	}
	if got.Searches() != 1 || got.ThreadsRead() != 1 || len(got.Hits) != 1 {
		t.Errorf("searches %d, read %d, hits %d", got.Searches(), got.ThreadsRead(), len(got.Hits))
	}
	sp := h.spawn(t)
	argv := strings.Join(sp.Argv, " ")
	for _, w := range []string{"--session-id " + e.ClaudeSessionID, "--model claude-sonnet-5-5", "--effort low", "--tools Bash",
		"--permission-mode dontAsk", "--safe-mode", "--system-prompt-snapshot off", "--search " + e.ID,
		"--allowedTools Bash(code-foundry thread search *) Bash(code-foundry thread read *) Bash(code-foundry search report *)"} {
		if !strings.Contains(argv, w) {
			t.Errorf("argv lacks %q: %s", w, argv)
		}
	}
	for _, bad := range []string{"--strict-mcp-config", "--mcp-config", "--settings", "--resume"} {
		if strings.Contains(argv, bad) {
			t.Errorf("argv has %s", bad)
		}
	}
	if real, _ := filepath.EvalSymlinks(filepath.Join(h.dir, "cwd")); sp.Cwd != real && sp.Cwd != filepath.Join(h.dir, "cwd") {
		t.Errorf("cwd = %s", sp.Cwd)
	}
	if !slices.Contains(sp.Env, "TMPDIR="+filepath.Join(h.dir, "tmp", e.ID)) {
		t.Errorf("env lacks the run's TMPDIR")
	}
	stdin, _ := os.ReadFile(h.log)
	if !strings.Contains(string(stdin), "where did we decide the poller skips reruns?") {
		t.Errorf("the question was not sent: %s", stdin)
	}
	// Events: steps, the hit, the answer and the end, versions growing.
	var kinds []EventKind
	var last uint64
	for len(sub.C()) > 0 {
		c := <-sub.C()
		if c.ID != e.ID {
			continue
		}
		if c.Version < last {
			t.Errorf("version %d after %d", c.Version, last)
		}
		last = c.Version
		kinds = append(kinds, c.Kind)
	}
	if !slices.Contains(kinds, EventHit) || !slices.Contains(kinds, EventStep) || kinds[len(kinds)-2] != EventAnswer || kinds[len(kinds)-1] != EventStatus {
		t.Errorf("events = %v", kinds)
	}
	// Ended: no more reports.
	if _, _, err := h.s.Report(context.Background(), e.ID, "s-aaa", "#5", "another quote here", "why"); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("report after the end = %v", err)
	}
}

func TestReportRefusals(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "go")
	h := newHarness(t, "agent.jsonl", Options{MaxHits: 2}, "CF_FAKE_CLAUDE_INIT_GATE="+gate)
	defer func() { _ = os.WriteFile(gate, nil, 0o600) }()
	e, err := h.s.StartAgent(context.Background(), "question")
	if err != nil {
		t.Fatal(err)
	}
	find, err := h.s.RecordFind(context.Background(), "words")
	if err != nil {
		t.Fatal(err)
	}
	h.threads.verify = func(threadID, item, quote string) (thread.QuotedItem, error) {
		if quote == "wrong" {
			return thread.QuotedItem{}, fmt.Errorf("%w: the quote does not occur in #4", thread.ErrInvalidArgument)
		}
		t, _ := h.threads.Snapshot().Thread(threadID)
		return thread.QuotedItem{Thread: t, ItemID: "item" + item, Ordinal: 4, Quote: quote}, nil
	}
	if _, _, err := h.s.Report(context.Background(), e.ID, "s-aaa", "#1", "first quote", "why"); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, search, item, quote, why string
		want                           error
		words                          string
	}{
		{"no why", e.ID, "#2", "a quote", " ", ErrInvalidArgument, "--why is required"},
		{"unknown search", "q-none", "#2", "a quote", "why", ErrNotFound, "no agent search"},
		{"a find entry", find.ID, "#2", "a quote", "why", ErrNotFound, "no agent search"},
		{"quote refused", e.ID, "#2", "wrong", "why", ErrInvalidArgument, "the quote does not occur in #4"},
		{"duplicate", e.ID, "#1", "first quote again", "why", ErrInvalidArgument, "hit [1] already"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := h.s.Report(context.Background(), tt.search, "s-aaa", tt.item, tt.quote, tt.why)
			if !errors.Is(err, tt.want) || !strings.Contains(err.Error(), tt.words) {
				t.Errorf("err = %v, want %v with %q", err, tt.want, tt.words)
			}
			if strings.Contains(fmt.Sprint(err), "invalid argument: invalid argument") {
				t.Errorf("doubled prefix: %v", err)
			}
		})
	}
	if _, left, err := h.s.Report(context.Background(), e.ID, "s-bbb", "#2", "second quote", "why"); err != nil || left != 0 {
		t.Fatalf("second = %d, %v", left, err)
	}
	if _, _, err := h.s.Report(context.Background(), e.ID, "s-bbb", "#3", "third quote", "why"); !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "write your answer now") {
		t.Errorf("past the cap = %v", err)
	}
}

// Past MaxToolCalls the turn is interrupted and the wrap-up message asks for the answer.
func TestWrapUpAtTheToolCallCap(t *testing.T) {
	h := newHarness(t, "wrapup.jsonl", Options{MaxToolCalls: 2})
	e, err := h.s.StartAgent(context.Background(), "q")
	if err != nil {
		t.Fatal(err)
	}
	got := h.wait(t, e.ID)
	if got.Status != StatusDone || got.Answer != "Nothing answered it." || got.CostUSD != 0.02 || len(got.Steps) != 3 {
		t.Errorf("finished = %+v", got)
	}
	stdin, _ := os.ReadFile(h.log)
	if !strings.Contains(string(stdin), `"subtype":"interrupt"`) || !strings.Contains(string(stdin), "Stop searching now") {
		t.Errorf("no interrupt and wrap-up in stdin:\n%s", stdin)
	}
}

func TestRunEnds(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		opts    Options
		env     []string
		hit     bool
		stop    bool
		status  Status
		note    string
	}{
		{"api error", "error.jsonl", Options{}, nil, false, false, StatusFailed, "API Error: 500 overloaded"},
		{"stopped", "agent.jsonl", Options{}, []string{"CF_FAKE_CLAUDE_STALL=1"}, false, true, StatusStopped, ""},
		{"time limit without a hit", "agent.jsonl", Options{WallTime: 400 * time.Millisecond}, []string{"CF_FAKE_CLAUDE_STALL=1"}, false, false, StatusFailed, "limit"},
		{"time limit with a hit", "agent.jsonl", Options{WallTime: 600 * time.Millisecond}, []string{"CF_FAKE_CLAUDE_STALL=1"}, true, false, StatusDone, "limit"},
		{"claude does not start", "agent.jsonl", Options{}, []string{fakeclaude.Env}, false, false, StatusFailed, "Claude did not start: fakeclaude: CF_FAKE_CLAUDE is not set"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, tt.fixture, tt.opts, tt.env...)
			e, err := h.s.StartAgent(context.Background(), "q")
			if err != nil {
				t.Fatal(err)
			}
			if tt.hit {
				if _, _, err := h.s.Report(context.Background(), e.ID, "s-aaa", "#4", "a quote", "why"); err != nil {
					t.Fatal(err)
				}
			}
			if tt.stop {
				time.Sleep(200 * time.Millisecond)
				if _, err := h.s.Stop(context.Background(), e.ID); err != nil {
					t.Fatal(err)
				}
			}
			got := h.wait(t, e.ID)
			if got.Status != tt.status || !strings.Contains(got.Error, tt.note) || !got.Unseen {
				t.Errorf("ended %s %q (unseen %v), want %s with %q", got.Status, got.Error, got.Unseen, tt.status, tt.note)
			}
			for _, st := range got.Steps {
				if !st.Done {
					t.Errorf("step %d left running", st.Index)
				}
			}
		})
	}
}

func TestHistoryCapForgetAndClear(t *testing.T) {
	h := newHarness(t, "agent.jsonl", Options{MaxEntries: 3})
	ctx := context.Background()
	e, err := h.s.StartAgent(ctx, "the agent one")
	if err != nil {
		t.Fatal(err)
	}
	h.wait(t, e.ID)
	// What the run left on disk, and Claude's transcript of it.
	transcript := filepath.Join(h.claude, "projects", "-some-cwd", e.ClaudeSessionID+".jsonl")
	sessionDir := filepath.Join(h.claude, "projects", "-some-cwd", e.ClaudeSessionID)
	other := filepath.Join(h.claude, "projects", "-some-cwd", "00000000-0000-4000-8000-00000000ffff.jsonl")
	for _, d := range []string{sessionDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{transcript, other} {
		if err := os.WriteFile(f, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tmp := filepath.Join(h.dir, "tmp", e.ID)
	if _, err := os.Stat(tmp); err != nil {
		t.Fatalf("no TMPDIR: %v", err)
	}
	clock := time.Now()
	h.s.opts.Now = func() time.Time { clock = clock.Add(time.Second); return clock }
	for _, q := range []string{"one", "two", "one"} {
		if _, err := h.s.RecordFind(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	queries := func() []string {
		var out []string
		for _, e := range h.s.List() {
			out = append(out, e.Query)
		}
		return out
	}
	if got := queries(); !slices.Equal(got, []string{"one", "two", "the agent one"}) {
		t.Fatalf("history = %q", got)
	}
	// A fourth pushes the oldest, the agent search, out: its files go.
	if _, err := h.s.RecordFind(ctx, "three"); err != nil {
		t.Fatal(err)
	}
	if got := queries(); !slices.Equal(got, []string{"three", "one", "two"}) {
		t.Fatalf("history = %q", got)
	}
	for _, p := range []string{transcript, sessionDir, tmp} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s still there (%v)", p, err)
		}
	}
	if _, err := os.Stat(other); err != nil {
		t.Errorf("another session's transcript went: %v", err)
	}
	// Persisted: a new store reads the same.
	s2, err := New(ctx, Options{DB: h.s.opts.DB, Threads: h.threads})
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.List()) != 3 {
		t.Errorf("reopened history has %d", len(s2.List()))
	}
	one := h.s.List()[1]
	if err := h.s.Forget(ctx, one.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.s.Forget(ctx, one.ID); err != nil {
		t.Errorf("forget twice = %v", err)
	}
	if got := queries(); !slices.Equal(got, []string{"three", "two"}) {
		t.Errorf("after forget = %q", got)
	}
	if n, err := h.s.Clear(ctx); err != nil || n != 2 || len(h.s.List()) != 0 {
		t.Errorf("clear = %d, %v; left %d", n, err, len(h.s.List()))
	}
}

func TestUnseenOpenedAndRemovedThreads(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "go")
	h := newHarness(t, "agent.jsonl", Options{}, "CF_FAKE_CLAUDE_INIT_GATE="+gate)
	ctx := context.Background()
	e, err := h.s.StartAgent(ctx, "q")
	if err != nil {
		t.Fatal(err)
	}
	if e.Unseen {
		t.Error("unseen while running")
	}
	for _, th := range []string{"s-aaa", "s-bbb"} {
		if _, _, err := h.s.Report(ctx, e.ID, th, "#4", "a quote from "+th, "why"); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(gate, nil, 0o600)
	if got := h.wait(t, e.ID); !got.Unseen {
		t.Error("finished, not unseen")
	}
	got, err := h.s.MarkSeen(ctx, e.ID)
	if err != nil || got.Unseen {
		t.Errorf("seen = %v, %v", got.Unseen, err)
	}
	if got, err = h.s.OpenHit(ctx, e.ID, 2); err != nil || got.Hits[0].Opened || !got.Hits[1].Opened {
		t.Errorf("opened = %+v, %v", got.Hits, err)
	}
	if _, err := h.s.OpenHit(ctx, e.ID, 9); !errors.Is(err, ErrNotFound) {
		t.Errorf("open hit 9 = %v", err)
	}
	h.threads.remove("s-aaa")
	got, _ = h.s.Get(e.ID)
	if len(got.Hits) != 1 || got.Hits[0].ThreadID != "s-bbb" || got.Hits[0].N != 2 {
		t.Errorf("hits after a removal = %+v", got.Hits)
	}
}

func TestPromote(t *testing.T) {
	gate := filepath.Join(t.TempDir(), "go")
	h := newHarness(t, "agent.jsonl", Options{ThreadDefaults: func() (string, string) { return "claude-opus-5-5[1m]", "high" }},
		"CF_FAKE_CLAUDE_INIT_GATE="+gate)
	ctx := context.Background()
	e, err := h.s.StartAgent(ctx, "where did we decide it?")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.s.Promote(ctx, e.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("promote while running = %v", err)
	}
	if _, _, err := h.s.Report(ctx, e.ID, "s-aaa", "#4", "skip reruns (100%)", "it says so"); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(gate, nil, 0o600)
	h.wait(t, e.ID)
	id, err := h.s.Promote(ctx, e.ID)
	if err != nil || id != "s-promoted" {
		t.Fatalf("promote = %q, %v", id, err)
	}
	o := h.threads.created[0]
	if !o.NoProject || o.ResumeSession != e.ClaudeSessionID || o.Model != "claude-opus-5-5[1m]" || o.Effort != "high" ||
		o.PermissionMode != thread.PermissionAuto || o.Owner != "" || o.CreatedBy != "" {
		t.Errorf("create = %+v", o)
	}
	for _, w := range []string{"where did we decide it?\n\n", "The search is over and you have your usual tools again",
		`1. [Assistant quote](cf-cite://v1/s-aaa/s-aaa-item-4?text=skip%20reruns%20%28100%25%29&start=0&end=18&prefix=&suffix=&comment=it%20says%20so) in "Poller design" (#4)`,
		"Your answer: The poller skips reruns [1]."} {
		if !strings.Contains(o.InitialPrompt, w) {
			t.Errorf("prompt lacks %q:\n%s", w, o.InitialPrompt)
		}
	}
	got, _ := h.s.Get(e.ID)
	if got.PromotedThreadID != "s-promoted" || got.Unseen {
		t.Errorf("entry after promote = %+v", got)
	}
	find, _ := h.s.RecordFind(ctx, "words")
	if _, err := h.s.Promote(ctx, find.ID); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("promote a find = %v", err)
	}
}

// A run a previous daemon left RUNNING ends FAILED when the store opens.
func TestNewEndsALeftoverRun(t *testing.T) {
	db := dbtest.Open(t)
	if err := saveEntry(context.Background(), db, Entry{ID: "q-1", Mode: ModeAgent, Query: "q", CreatedAt: time.Now(), Status: StatusRunning}); err != nil {
		t.Fatal(err)
	}
	s, err := New(context.Background(), Options{DB: db, Threads: &fakeThreads{}})
	if err != nil {
		t.Fatal(err)
	}
	e, _ := s.Get("q-1")
	if e.Status != StatusFailed || !e.Unseen || e.FinishedAt.IsZero() {
		t.Errorf("leftover = %+v", e)
	}
}

func TestStartAgentRefusals(t *testing.T) {
	h := newHarness(t, "agent.jsonl", Options{})
	for _, q := range []string{"", "  ", "a\x00b", strings.Repeat("x", MaxQuestionRunes+1)} {
		if _, err := h.s.StartAgent(context.Background(), q); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("StartAgent(%.10q) = %v", q, err)
		}
	}
}
