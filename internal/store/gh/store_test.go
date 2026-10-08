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

	"github.com/awaumann/code-foundry/internal/bus"
)

// fakeRunner answers GraphQL by query operation name and records call timing.
type fakeRunner struct {
	mu          sync.Mutex
	graphql     func(op string, vars map[string]any) (json.RawMessage, error)
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
	data, err := h(op, vars)
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

func (f *fakeRunner) set(h func(op string, vars map[string]any) (json.RawMessage, error)) {
	f.mu.Lock()
	f.graphql = h
	f.mu.Unlock()
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

// fixtureHandler serves the captured ghostty fixtures.
func fixtureHandler(t *testing.T) func(op string, vars map[string]any) (json.RawMessage, error) {
	viewer := fixtureData(t, "viewer.json")
	prs1, prs2 := fixtureData(t, "pull_requests_page1.json"), fixtureData(t, "pull_requests_page2.json")
	pr1, pr2 := fixtureData(t, "pull_request_14586_page1.json"), fixtureData(t, "pull_request_14586_page2.json")
	checks := fixtureData(t, "checks_main.json")
	unknownRef := fixtureData(t, "checks_unknown_ref.json")
	return func(op string, vars map[string]any) (json.RawMessage, error) {
		_, paged := vars["after"]
		switch {
		case op == "Viewer":
			return viewer, nil
		case op == "PullRequests" && !paged:
			return prs1, nil
		case op == "PullRequests":
			return prs2, nil
		case op == "PullRequest" && !paged:
			return pr1, nil
		case op == "PullRequest":
			return pr2, nil
		case op == "Checks" && vars["ref"] == "main":
			return checks, nil
		case op == "Checks":
			return unknownRef, nil
		}
		return nil, fmt.Errorf("unexpected op %s", op)
	}
}

func testOptions(db DB, r Runner, b *bus.Bus) Options {
	return Options{
		DB: db, Runner: r, Bus: b,
		MinGap:           20 * time.Millisecond,
		RepoInterval:     time.Hour, // polls only happen when a test asks for them
		ViewerInterval:   time.Hour,
		AuthRetry:        30 * time.Millisecond,
		NetworkBackoff:   30 * time.Millisecond,
		SecondaryBackoff: 30 * time.Millisecond,
		MaxBackoff:       time.Second,
		PageSize:         25,
		MaxPages:         2,
		// Phase 3a polls are off here; activity_test.go turns them on.
		DashboardInterval: -1,
		StatsInterval:     -1,
		Rand:              func() float64 { return 0.5 },
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

func TestStorePollsTracksAndServesCacheOnRestart(t *testing.T) {
	db := openTestDB(t)
	b := bus.New()
	prEvents := bus.Subscribe[PullRequestsUpdated](b, 16)
	viewerEvents := bus.Subscribe[ViewerUpdated](b, 16)
	f := &fakeRunner{}
	f.set(fixtureHandler(t))
	s := startStore(t, testOptions(db, f, b))

	if err := s.Track("Ghostty-Org/Ghostty"); err != nil {
		t.Fatal(err)
	}
	if r, ok := s.Snapshot().Repo("ghostty-org/ghostty"); !ok || !r.Tracked || !r.FetchedAt.IsZero() {
		t.Fatalf("after Track: %+v ok=%v", r, ok)
	}
	if ev := <-prEvents.C(); ev.Slug != "ghostty-org/ghostty" || !ev.FetchedAt.IsZero() {
		t.Errorf("track event = %+v", ev)
	}
	waitFor(t, "first poll", func() bool {
		r, _ := s.Snapshot().Repo("ghostty-org/ghostty")
		return !r.FetchedAt.IsZero()
	})
	if ev := <-prEvents.C(); ev.FetchedAt.IsZero() {
		t.Errorf("poll event = %+v", ev)
	}
	r, _ := s.Snapshot().Repo("ghostty-org/ghostty")
	if len(r.PullRequests) != 50 || r.TotalCount != 129 || r.LastError != "" {
		t.Errorf("repo: %d PRs, total %d, err %q", len(r.PullRequests), r.TotalCount, r.LastError)
	}
	if r.PullRequests[0].Number != 13745 || r.PullRequests[25].Number != 13779 {
		t.Errorf("order: first %d, 26th %d", r.PullRequests[0].Number, r.PullRequests[25].Number)
	}
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "PullRequests" && (c.vars["owner"] != "ghostty-org" || c.vars["name"] != "ghostty" || c.vars["first"] != 25) {
			t.Errorf("vars = %v", c.vars)
		}
	}
	waitFor(t, "viewer", func() bool { return s.Snapshot().Viewer.Viewer != nil })
	<-viewerEvents.C()
	if v := s.Snapshot().Viewer; v.Viewer.Login != "octocat" || !v.Authenticated || v.FetchedAt.IsZero() {
		t.Errorf("viewer = %+v", v)
	}

	// A second store on the same DB serves the cache before any request.
	f2 := &fakeRunner{}
	f2.set(func(string, map[string]any) (json.RawMessage, error) { return nil, errors.New("offline") })
	s2, err := New(context.Background(), testOptions(db, f2, nil))
	if err != nil {
		t.Fatal(err)
	}
	r2, ok := s2.Snapshot().Repo("ghostty-org/ghostty")
	// The cache keeps millisecond precision.
	if !ok || len(r2.PullRequests) != 50 || r2.Tracked || !r2.FetchedAt.Equal(r.FetchedAt.Truncate(time.Millisecond)) {
		t.Errorf("cached repo = %d PRs tracked=%v fetched=%v", len(r2.PullRequests), r2.Tracked, r2.FetchedAt)
	}
	if v := s2.Snapshot().Viewer.Viewer; v == nil || v.Login != "octocat" {
		t.Errorf("cached viewer = %+v", v)
	}
	// Tracking a freshly cached repo waits for the cache to expire.
	if err := s2.Track("ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	s2.mu.Lock()
	next := s2.tracked["ghostty-org/ghostty"].next
	s2.mu.Unlock()
	if want := r2.FetchedAt.Add(time.Hour); !next.Equal(want) {
		t.Errorf("first poll at %v, want %v", next, want)
	}
}

func TestStorePacing(t *testing.T) {
	f := &fakeRunner{delay: 5 * time.Millisecond}
	f.set(fixtureHandler(t))
	opts := testOptions(openTestDB(t), f, nil)
	opts.MinGap = 40 * time.Millisecond
	opts.RepoInterval = 10 * time.Millisecond // always due: the gap is the only limit
	opts.MaxPages = 1
	s := startStore(t, opts)
	for _, slug := range []string{"a/one", "a/two", "a/three"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, "8 requests", func() bool { c, _ := f.snapshot(); return len(c) >= 8 })
	calls, _ := f.snapshot()
	for i := 1; i < len(calls); i++ {
		if gap := calls[i].start.Sub(calls[i-1].end); gap < opts.MinGap {
			t.Errorf("request %d started %v after the previous ended, want >= %v", i, gap, opts.MinGap)
		}
	}
	if f.maxInflight != 1 {
		t.Errorf("max in flight = %d, want 1", f.maxInflight)
	}
	seen := map[string]bool{}
	for _, c := range calls {
		if c.op == "PullRequests" {
			seen[c.vars["name"].(string)] = true
		}
	}
	if len(seen) != 3 {
		t.Errorf("polled repos = %v, want all three", seen)
	}
}

func TestStoreAuthPauseAndRecovery(t *testing.T) {
	b := bus.New()
	viewerEvents := bus.Subscribe[ViewerUpdated](b, 16)
	f := &fakeRunner{}
	notAuthed := fmt.Errorf("%w: To get started with GitHub CLI, please run:  gh auth login", ErrNotAuthenticated)
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
	if n := len(func() []fakeCall { c, _ := f.snapshot(); return c }()); n != 1 {
		t.Errorf("GraphQL calls while unauthenticated = %d, want 1 (only auth checks after)", n)
	}

	f.set(fixtureHandler(t))
	loggedIn.Lock()
	authOK = true
	loggedIn.Unlock()
	waitFor(t, "recovery", func() bool {
		v := s.Snapshot().Viewer
		r, _ := s.Snapshot().Repo("a/b")
		return v.Authenticated && v.Viewer != nil && v.LastError == "" && !r.FetchedAt.IsZero()
	})
}

func TestStoreRateLimitBudgetPauses(t *testing.T) {
	f := &fakeRunner{}
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	f.set(func(op string, _ map[string]any) (json.RawMessage, error) {
		return json.RawMessage(fmt.Sprintf(`{"rateLimit":{"limit":5000,"cost":1,"remaining":10,"resetAt":%q},
			"viewer":{"login":"octocat"}}`, reset.Format(time.RFC3339))), nil
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
	if err := s.Track("a/b"); err != nil {
		t.Fatal(err)
	}
	err := s.Refresh(context.Background(), "a/b")
	if !errors.Is(err, ErrRateLimited) {
		t.Errorf("Refresh err = %v, want ErrRateLimited", err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := f.count("PullRequests"); n != 0 {
		t.Errorf("PullRequests calls during pause = %d", n)
	}
}

func TestStoreRepoErrorBackoff(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[PullRequestsUpdated](b, 16)
	f := &fakeRunner{}
	viewer := fixtureData(t, "viewer.json")
	f.set(func(op string, _ map[string]any) (json.RawMessage, error) {
		if op == "Viewer" {
			return viewer, nil
		}
		return parseGraphQLOutput(1, fixture(t, "graphql_repo_not_found.json"), nil)
	})
	opts := testOptions(openTestDB(t), f, b)
	opts.RepoInterval = 40 * time.Millisecond
	opts.MaxBackoff = 80 * time.Millisecond
	s := startStore(t, opts)
	if err := s.Track("ghostty-org/no-such-repo-cf1c"); err != nil {
		t.Fatal(err)
	}
	<-events.C() // tracked
	waitFor(t, "3 failed polls", func() bool { return f.count("PullRequests") >= 3 })
	r, _ := s.Snapshot().Repo("ghostty-org/no-such-repo-cf1c")
	if r.LastError == "" || !r.FetchedAt.IsZero() {
		t.Errorf("repo = %+v", r)
	}
	// The error is announced once, not on every retry.
	<-events.C()
	select {
	case ev := <-events.C():
		t.Errorf("unexpected second event %+v", ev)
	default:
	}
	calls, _ := f.snapshot()
	var starts []time.Time
	for _, c := range calls {
		if c.op == "PullRequests" {
			starts = append(starts, c.start)
		}
	}
	// Retry n waits RepoInterval*2^(n-1) capped at MaxBackoff: 40ms, then 80ms.
	if d := starts[2].Sub(starts[1]); d < 75*time.Millisecond {
		t.Errorf("second retry after %v, want >= 80ms (backoff)", d)
	}
	// Viewer is unaffected by a repo error.
	if s.Snapshot().Viewer.LastError != "" {
		t.Errorf("viewer error = %q", s.Snapshot().Viewer.LastError)
	}
}

func TestStoreServerTimeoutShrinksPageSize(t *testing.T) {
	f := &fakeRunner{}
	page := fixtureData(t, "pull_requests_page2.json") // hasNextPage: true, MaxPages 1 stops
	f.set(func(op string, vars map[string]any) (json.RawMessage, error) {
		if op == "PullRequests" && vars["first"] == 25 {
			return nil, fmt.Errorf("%w: HTTP 502", ErrServerTimeout)
		}
		if op == "PullRequests" {
			return page, nil
		}
		return fixtureData(t, "viewer.json"), nil
	})
	opts := testOptions(openTestDB(t), f, nil)
	opts.MaxPages = 1
	s := startStore(t, opts)
	if err := s.Track("a/b"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "retry at smaller page", func() bool {
		r, _ := s.Snapshot().Repo("a/b")
		return !r.FetchedAt.IsZero()
	})
	var sizes []any
	calls, _ := f.snapshot()
	for _, c := range calls {
		if c.op == "PullRequests" {
			sizes = append(sizes, c.vars["first"])
		}
	}
	if fmt.Sprint(sizes) != "[25 12]" {
		t.Errorf("page sizes = %v, want [25 12]", sizes)
	}
}

func TestStorePullRequestDetail(t *testing.T) {
	f := &fakeRunner{}
	f.set(fixtureHandler(t))
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
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); _ = s.Run(runCtx) }()
	defer func() { cancel(); <-done }()

	d := <-results
	<-results
	if d.PullRequest.Number != 14586 || len(d.Checks) != 104 || d.PullRequest.Checks.Total != 104 ||
		d.PullRequest.HeadRepoSlug != "kgni/ghostty" || d.LastError != "" {
		t.Errorf("detail: pr %+v, %d checks", d.PullRequest, len(d.Checks))
	}
	// Sorted: no failures or pending, so passed (SUCCESS) come before skipped.
	if d.Checks[0].Conclusion != ConclusionSuccess || d.Checks[103].Conclusion != "SKIPPED" {
		t.Errorf("order: first %+v last %+v", d.Checks[0], d.Checks[103])
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
		return nil, errors.New("gh exited 1: boom")
	})
	stale, err := s.PullRequest(ctx, "ghostty-org/ghostty", 14586)
	if err != nil || stale.LastError == "" || len(stale.Checks) != 104 {
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
	f.set(fixtureHandler(t))
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

func TestStoreRefreshAndUntrack(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[PullRequestsUpdated](b, 16)
	f := &fakeRunner{}
	f.set(fixtureHandler(t))
	opts := testOptions(openTestDB(t), f, b)
	opts.MaxPages = 1
	s := startStore(t, opts)
	ctx := context.Background()

	// Refresh of an untracked repo fetches synchronously and caches it untracked.
	if err := s.Refresh(ctx, "ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	r, ok := s.Snapshot().Repo("ghostty-org/ghostty")
	if !ok || r.Tracked || len(r.PullRequests) != 25 {
		t.Errorf("after refresh: ok=%v %+v", ok, r)
	}
	if ev := <-events.C(); ev.Slug != "ghostty-org/ghostty" {
		t.Errorf("event %+v", ev)
	}

	if err := s.Track("ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	if err := s.Untrack("ghostty-org/ghostty"); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Snapshot().Repo("ghostty-org/ghostty"); r.Tracked || len(r.PullRequests) != 25 {
		t.Errorf("after untrack: %+v", r)
	}
	if err := s.Untrack("never/tracked"); err != nil {
		t.Errorf("untrack unknown: %v", err)
	}
	if err := s.Track("bad slug"); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("track bad slug: %v", err)
	}

	// Refresh("") marks everything due and returns immediately. Wait out the first
	// viewer poll: a Refresh("") while it is in flight is satisfied by it.
	waitFor(t, "first viewer poll", func() bool { return !s.Snapshot().Viewer.FetchedAt.IsZero() })
	before := f.count("Viewer")
	if err := s.Refresh(ctx, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "viewer refetch", func() bool { return f.count("Viewer") > before })
}
