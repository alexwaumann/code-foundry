package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// fakeRunner answers GraphQL by query operation name and records call timing.
type fakeRunner struct {
	mu          sync.Mutex
	graphql     func(op, doc string, vars map[string]any) (json.RawMessage, error)
	auth        func() (AuthStatus, error)
	delay       time.Duration
	calls       []fakeCall
	authCalls   int
	inflight    int
	maxInflight int
}

type fakeCall struct {
	op         string
	vars       map[string]any
	start, end time.Time
}

var opRE = regexp.MustCompile(`^query (\w+)`)

func (f *fakeRunner) GraphQL(ctx context.Context, q string, vars map[string]any) (json.RawMessage, error) {
	op := opRE.FindStringSubmatch(q)[1]
	f.mu.Lock()
	f.inflight++
	f.maxInflight = max(f.maxInflight, f.inflight)
	h := f.graphql
	f.mu.Unlock()
	start := time.Now()
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	data, err := h(op, q, vars)
	f.mu.Lock()
	f.inflight--
	f.calls = append(f.calls, fakeCall{op: op, vars: vars, start: start, end: time.Now()})
	f.mu.Unlock()
	return data, err
}

func (f *fakeRunner) AuthStatus(context.Context) (AuthStatus, error) {
	f.mu.Lock()
	f.authCalls++
	h := f.auth
	f.mu.Unlock()
	if h == nil {
		return AuthStatus{LoggedIn: true, Login: "octocat"}, nil
	}
	return h()
}

// set installs a handler that does not need the document.
func (f *fakeRunner) set(h func(op string, vars map[string]any) (json.RawMessage, error)) {
	f.setDoc(func(op, _ string, vars map[string]any) (json.RawMessage, error) { return h(op, vars) })
}

func (f *fakeRunner) setDoc(h func(op, doc string, vars map[string]any) (json.RawMessage, error)) {
	f.mu.Lock()
	f.graphql = h
	f.mu.Unlock()
}

// serve answers from g.
func (f *fakeRunner) serve(g *fakeGitHub) *fakeRunner {
	f.setDoc(g.respond)
	return f
}

func (f *fakeRunner) snapshot() (calls []fakeCall, authCalls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...), f.authCalls
}

func (f *fakeRunner) count(op string) int {
	calls, _ := f.snapshot()
	n := 0
	for _, c := range calls {
		if c.op == op {
			n++
		}
	}
	return n
}

// opsSince lists the operations called since call index from.
func (f *fakeRunner) opsSince(from int) []string {
	calls, _ := f.snapshot()
	var out []string
	for _, c := range calls[min(from, len(calls)):] {
		out = append(out, c.op)
	}
	return out
}

func (f *fakeRunner) ncalls() int {
	calls, _ := f.snapshot()
	return len(calls)
}

func testOptions(db DB, r Runner, b *bus.Bus) Options {
	return Options{
		DB: db, Runner: r, Bus: b,
		MinGap:           20 * time.Millisecond,
		PollInterval:     time.Hour, // polls only happen when a test asks for them
		IdleInterval:     time.Hour,
		AuthRetry:        30 * time.Millisecond,
		NetworkBackoff:   30 * time.Millisecond,
		SecondaryBackoff: 30 * time.Millisecond,
		MaxBackoff:       time.Second,
		MaxPages:         2,
		StatsInterval:    -1, // the stats test turns them on
		Rand:             func() float64 { return 0.5 },
	}
}

func startStore(t *testing.T, opts Options) *Store {
	t.Helper()
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return s
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestStorePacing(t *testing.T) {
	g := newFakeGitHub()
	f := (&fakeRunner{delay: 5 * time.Millisecond}).serve(g)
	opts := testOptions(openTestDB(t), f, nil)
	opts.MinGap = 40 * time.Millisecond
	opts.PollInterval = 10 * time.Millisecond // always due: the gap is the only limit
	s := startStore(t, opts)
	for _, slug := range []string{"a/one", "a/two", "a/three"} {
		g.setRepo(slug, &fakeRepo{branch: "main", sha: "s1"})
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, "6 requests", func() bool { return f.ncalls() >= 6 })
	calls, _ := f.snapshot()
	for i := 1; i < len(calls); i++ {
		if gap := calls[i].start.Sub(calls[i-1].end); gap < opts.MinGap {
			t.Errorf("request %d started %v after the previous ended, want >= %v", i, gap, opts.MinGap)
		}
	}
	if f.maxInflight != 1 {
		t.Errorf("max in flight = %d, want 1", f.maxInflight)
	}
	// One request per poll covers every repository.
	last := calls[len(calls)-1]
	if last.op != "Poll" || last.vars["r0n"] != "one" || last.vars["r1n"] != "three" || last.vars["r2n"] != "two" {
		t.Errorf("last request = %s %v, want a poll of all three repositories", last.op, last.vars)
	}
}

func TestStoreAuthPauseAndRecovery(t *testing.T) {
	b := bus.New()
	viewerEvents := bus.Subscribe[ViewerUpdated](b, 16)
	g := newFakeGitHub()
	g.setRepo("a/b", &fakeRepo{branch: "main", sha: "s1"})
	f := &fakeRunner{}
	notAuthed := fmt.Errorf("%w: Bad credentials (HTTP 401)", ErrNotAuthenticated)
	f.set(func(string, map[string]any) (json.RawMessage, error) { return nil, notAuthed })
	var loggedIn sync.Mutex
	authOK := false
	f.auth = func() (AuthStatus, error) {
		loggedIn.Lock()
		defer loggedIn.Unlock()
		return AuthStatus{LoggedIn: authOK, Login: "octocat"}, nil
	}
	s := startStore(t, testOptions(openTestDB(t), f, b))
	if err := s.Track("a/b"); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "unauthenticated", func() bool { return !s.Snapshot().Viewer.Authenticated })
	<-viewerEvents.C()
	if v := s.Snapshot().Viewer; v.LastError == "" {
		t.Errorf("viewer = %+v, want an error", v)
	}
	waitFor(t, "auth checks", func() bool { _, n := f.snapshot(); return n >= 2 })
	if n := f.ncalls(); n != 1 {
		t.Errorf("GraphQL calls while unauthenticated = %d, want 1 (only auth checks after)", n)
	}

	f.serve(g)
	loggedIn.Lock()
	authOK = true
	loggedIn.Unlock()
	waitFor(t, "recovery", func() bool {
		snap := s.Snapshot()
		v := snap.Viewer
		return v.Authenticated && v.Viewer != nil && v.LastError == "" && !snap.Repos["a/b"].Activity.DefaultBranch.FetchedAt.IsZero()
	})
}

func TestStoreRateLimitBudgetPauses(t *testing.T) {
	g := newFakeGitHub()
	f := &fakeRunner{}
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	f.set(func(op string, _ map[string]any) (json.RawMessage, error) {
		return json.RawMessage(fmt.Sprintf(`{"rateLimit":{"limit":5000,"cost":1,"remaining":10,"resetAt":%q},
			"viewer":{"id":"V","login":"octocat"}}`, reset.Format(time.RFC3339))), nil
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	waitFor(t, "viewer", func() bool { return s.Snapshot().Viewer.Viewer != nil })
	s.mu.Lock()
	until := s.pauseUntil
	s.mu.Unlock()
	if !until.Equal(reset.Add(rateLimitSlack)) {
		t.Errorf("pauseUntil = %v, want %v", until, reset.Add(rateLimitSlack))
	}
	// Scheduled work waits; on-demand work fails fast instead of queueing for an hour.
	f.serve(g)
	if err := s.Track("a/b"); err != nil {
		t.Fatal(err)
	}
	err := s.Refresh(context.Background(), "a/b")
	if !errors.Is(err, ErrRateLimited) {
		t.Errorf("Refresh err = %v, want ErrRateLimited", err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := f.ncalls(); n != 1 {
		t.Errorf("requests during the pause = %d, want none", n-1)
	}
}

func TestStoreSecondaryLimitHonorsRetryAfter(t *testing.T) {
	f := &fakeRunner{}
	f.set(func(string, map[string]any) (json.RawMessage, error) {
		return nil, &RateLimitError{Secondary: true, Msg: "secondary rate limit (HTTP 403)", RetryAfter: 2 * time.Minute}
	})
	before := time.Now()
	s := startStore(t, testOptions(openTestDB(t), f, nil)) // SecondaryBackoff is 30ms here
	waitFor(t, "pause", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return !s.pauseUntil.IsZero()
	})
	s.mu.Lock()
	until := s.pauseUntil
	s.mu.Unlock()
	if lo, hi := before.Add(2*time.Minute), time.Now().Add(2*time.Minute+retryAfterSlack); until.Before(lo) || until.After(hi) {
		t.Errorf("pauseUntil in %v, want retry-after (2m)", time.Until(until).Round(time.Second))
	}
	if !errors.Is(s.Refresh(context.Background(), "a/b"), ErrRateLimited) {
		t.Error("Refresh during the pause should fail fast with ErrRateLimited")
	}
	waitFor(t, "poll error recorded", func() bool { return s.Snapshot().Poll.LastError != "" })
	if p := s.Snapshot().Poll; !p.FetchedAt.IsZero() {
		t.Errorf("poll state = %+v, want no success yet", p)
	}
}

func TestStorePollErrorBackoff(t *testing.T) {
	b := bus.New()
	polled := bus.Subscribe[Polled](b, 16)
	f := &fakeRunner{}
	f.set(func(string, map[string]any) (json.RawMessage, error) {
		return nil, errors.New("github graphql: Something went wrong")
	})
	opts := testOptions(openTestDB(t), f, b)
	opts.PollInterval = 40 * time.Millisecond
	opts.MaxBackoff = 80 * time.Millisecond
	s := startStore(t, opts)
	waitFor(t, "3 failed polls", func() bool { return f.count("Poll") >= 3 })
	calls, _ := f.snapshot()
	// Retry n waits PollInterval*2^(n-1) capped at MaxBackoff: 40ms, then 80ms.
	if d := calls[2].start.Sub(calls[1].start); d < 75*time.Millisecond {
		t.Errorf("second retry after %v, want >= 80ms (backoff)", d)
	}
	ev := <-polled.C()
	if ev.LastError == "" || !ev.FetchedAt.IsZero() {
		t.Errorf("Polled = %+v, want the error", ev)
	}
	if d := s.Snapshot().Dashboard; d.LastError == "" {
		t.Errorf("dashboard error not set: %+v", d)
	}
}

func TestStorePullRequestDetail(t *testing.T) {
	f := &fakeRunner{}
	p1, p2 := fixtureData(t, "pull_request_14586_page1.json"), fixtureData(t, "pull_request_14586_page2.json")
	f.set(func(op string, vars map[string]any) (json.RawMessage, error) {
		if op != "PullRequest" {
			return nil, fmt.Errorf("unexpected %s", op)
		}
		if _, paged := vars["after"]; paged {
			return p2, nil
		}
		return p1, nil
	})
	opts := testOptions(openTestDB(t), f, nil)
	opts.MaxPages = 5
	opts.DetailTTL = time.Hour
	var clock sync.Mutex
	var offset time.Duration
	opts.Now = func() time.Time { clock.Lock(); defer clock.Unlock(); return time.Now().Add(offset) }
	advance := func(d time.Duration) { clock.Lock(); offset += d; clock.Unlock() }
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Two concurrent requests before the worker starts coalesce into one fetch.
	results := make(chan PullRequestDetail, 2)
	for range 2 {
		go func() {
			d, err := s.PullRequest(ctx, "ghostty-org/ghostty", 14586)
			if err != nil {
				t.Error(err)
			}
			results <- d
		}()
	}
	waitFor(t, "coalesced job", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == 1 && len(s.queue[0].waiters) == 2
	})
	// Hold the poll off: only the on-demand job runs.
	s.mu.Lock()
	s.pollNext = time.Now().Add(time.Hour)
	s.mu.Unlock()
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); _ = s.Run(runCtx) }()
	defer func() { cancel(); <-done }()

	d := <-results
	<-results
	pr := d.PullRequest
	if pr.Number != 14586 || len(d.Checks) != 105 || pr.Checks.Total != 105 || pr.HeadRepoSlug != "kgni/ghostty" ||
		pr.State != PullRequestMerged || pr.Repo != "ghostty-org/ghostty" || pr.ID == "" || d.LastError != "" {
		t.Errorf("detail: pr %+v, %d checks", pr, len(d.Checks))
	}
	if n := f.count("PullRequest"); n != 2 {
		t.Errorf("PullRequest requests = %d, want 2 (two pages, one fetch)", n)
	}

	// Within the TTL: served from cache.
	if _, err := s.PullRequest(ctx, "ghostty-org/ghostty", 14586); err != nil || f.count("PullRequest") != 2 {
		t.Errorf("cached read: err=%v requests=%d", err, f.count("PullRequest"))
	}
	// Past the TTL with GitHub failing: stale copy with the error.
	advance(2 * time.Hour)
	f.set(func(string, map[string]any) (json.RawMessage, error) {
		return nil, errors.New("github graphql: boom")
	})
	stale, err := s.PullRequest(ctx, "ghostty-org/ghostty", 14586)
	if err != nil || stale.LastError == "" || len(stale.Checks) != 105 {
		t.Errorf("stale read: err=%v lastError=%q checks=%d", err, stale.LastError, len(stale.Checks))
	}
	// No cache and failing: the error.
	if _, err := s.PullRequest(ctx, "ghostty-org/ghostty", 1); err == nil {
		t.Error("uncached failing read: want error")
	}

	// Argument validation.
	if _, err := s.PullRequest(ctx, "nope", 1); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("bad slug err = %v", err)
	}
	if _, err := s.PullRequest(ctx, "a/b", 0); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad number err = %v", err)
	}
}

func TestStoreChecks(t *testing.T) {
	f := &fakeRunner{}
	checks, unknown := fixtureData(t, "checks_main.json"), fixtureData(t, "checks_unknown_ref.json")
	g := newFakeGitHub()
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		switch {
		case op == "Checks" && vars["ref"] == "main":
			return checks, nil
		case op == "Checks":
			return unknown, nil
		}
		return g.respond(op, doc, vars)
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	ctx := context.Background()
	rc, err := s.Checks(ctx, "ghostty-org/ghostty", "main")
	if err != nil {
		t.Fatal(err)
	}
	if rc.SHA != "a60e9e2a57f73e1eef2bd1cf2995a467f69e7fb0" || len(rc.Runs) != 54 || rc.Rollup.Skipped != 50 || rc.FetchedAt.IsZero() {
		t.Errorf("checks = sha %s, %d runs, rollup %+v", rc.SHA, len(rc.Runs), rc.Rollup)
	}
	if _, err := s.Checks(ctx, "ghostty-org/ghostty", "no-such-branch"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown ref err = %v, want ErrNotFound", err)
	}
	if _, err := s.Checks(ctx, "ghostty-org/ghostty", ""); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("empty ref err = %v", err)
	}
}

func TestStoreTrackRefreshUntrack(t *testing.T) {
	b := bus.New()
	dash := bus.Subscribe[DashboardUpdated](b, 16)
	act := bus.Subscribe[RepoActivityUpdated](b, 16)
	g := newFakeGitHub()
	g.setRepo("ghostty-org/ghostty", &fakeRepo{branch: "main", sha: "s1", rollup: CheckRollup{State: RollupSuccess, Total: 1, Passed: 1}})
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	ctx := context.Background()

	// With nothing tracked, the first poll fetches only the viewer.
	waitFor(t, "idle poll", func() bool { return !s.Snapshot().Poll.FetchedAt.IsZero() })
	if c, _ := f.snapshot(); len(c) != 1 || c[0].vars["q_authored"] != nil || c[0].vars["r0o"] != nil {
		t.Errorf("idle poll = %+v", c)
	}

	// Tracking announces the tracked flag (dashboard filter and repo activity) and
	// polls soon.
	if err := s.Track("Ghostty-Org/Ghostty"); err != nil {
		t.Fatal(err)
	}
	if ev := <-act.C(); ev.Slug != "ghostty-org/ghostty" {
		t.Errorf("activity event %+v", ev)
	}
	<-dash.C()
	waitFor(t, "default branch", func() bool {
		return s.Snapshot().Repos["ghostty-org/ghostty"].Activity.DefaultBranch.SHA == "s1"
	})
	if r := s.Snapshot().Repos["ghostty-org/ghostty"]; !r.Tracked {
		t.Errorf("repo = %+v", r)
	}

	// Refresh(slug) polls and waits.
	before := f.count("Poll")
	if err := s.Refresh(ctx, "ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	if n := f.count("Poll"); n != before+1 {
		t.Errorf("polls after Refresh = %d, want %d", n, before+1)
	}
	if err := s.Refresh(ctx, "bad slug"); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("Refresh(bad) = %v", err)
	}
	// Refresh("") marks the poll due and returns immediately.
	if err := s.Refresh(ctx, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, `poll after Refresh("")`, func() bool { return f.count("Poll") > before+1 })

	if err := s.Untrack("ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	if r := s.Snapshot().Repos["ghostty-org/ghostty"]; r.Tracked || r.Activity.DefaultBranch.SHA != "s1" {
		t.Errorf("after untrack (cache kept): %+v", r)
	}
	if err := s.Untrack("never/tracked"); err != nil {
		t.Errorf("untrack unknown: %v", err)
	}
	if err := s.Track("bad slug"); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("track bad slug: %v", err)
	}
}
