package gh

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// testClock is an injectable Now that tests move forward.
type testClock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	c.offset += d
	c.mu.Unlock()
}

func TestFullPullRequestCache(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	g, _ := changeDrivenWorld()
	g.setBody("PR_a", "first body")
	g.addComment("PR_a", "looks good")
	f := (&fakeRunner{}).serve(g)
	db := openTestDB(t)
	clk := &testClock{}
	opts := testOptions(db, f, b)
	opts.Now = clk.now
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	ctx := context.Background()
	read := func(refresh bool) FullPullRequest {
		t.Helper()
		d, err := s.FullPullRequest(ctx, "O/R", 1, refresh)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	fetches := func() int { return f.count("PullRequestFull") }
	step := func(name string, wantFetches, wantEvents int) {
		t.Helper()
		if got := fetches(); got != wantFetches {
			t.Errorf("%s: fetches = %d, want %d", name, got, wantFetches)
		}
		if got := drain(events); got != wantEvents {
			t.Errorf("%s: events = %d, want %d", name, got, wantEvents)
		}
	}

	d := read(false)
	step("first read", 1, 0)
	if d.Body != "first body" || d.PullRequest.Number != 1 || d.PullRequest.ID != "PR_a" || len(d.Labels) != 1 ||
		d.CommitCount != 1 || len(d.Comments) != 1 || d.Comments[0].Kind != CommentIssue || d.FetchedAt.IsZero() ||
		!d.ViewerCanUpdate() || d.PullRequest.Checks.Total != 3 {
		t.Errorf("detail = %+v", d)
	}

	read(false)
	step("fresh: cache hit", 1, 0)
	read(true)
	step("refresh, unchanged: no event", 2, 0)
	g.setBody("PR_a", "second body")
	if d := read(true); d.Body != "second body" {
		t.Errorf("refreshed body = %q", d.Body)
	}
	step("refresh, changed: event", 3, 1)

	pollOnce(t, s, f)
	read(false)
	step("a poll where nothing moved keeps it fresh", 3, 0)

	g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
	pollOnce(t, s, f)
	step("the poll saw updatedAt move: stale + event", 3, 1)
	read(false)
	step("stale: fetched", 4, 0)

	g.edit("PR_a", func(p *PullRequest) { p.Checks = CheckRollup{State: RollupSuccess, Total: 4, Passed: 4} })
	pollOnce(t, s, f)
	step("check counts moved: stale + event", 4, 1)
	if d := read(false); d.PullRequest.Checks.Total != 4 {
		t.Errorf("checks after refetch = %+v", d.PullRequest.Checks)
	}
	step("refetched quietly (the stale event was the announcement)", 5, 0)

	clk.advance(2 * time.Hour) // past the poll interval (1h in testOptions)
	read(false)
	step("older than the poll interval: fetched", 6, 0)

	clk.advance(2 * time.Hour)
	g.failNext("PullRequestFull", errors.New("github graphql: boom"))
	if d := read(false); d.LastError == "" || d.Body != "second body" {
		t.Errorf("failed refresh: lastError %q body %q", d.LastError, d.Body)
	}

	if _, err := s.FullPullRequest(ctx, "o/r", 99, false); !errors.Is(err, ErrNotFound) || !strings.Contains(err.Error(), "Could not resolve") {
		t.Errorf("unknown PR err = %v", err)
	}
	if _, err := s.FullPullRequest(ctx, "nope", 1, false); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("bad slug err = %v", err)
	}
	if _, err := s.FullPullRequest(ctx, "o/r", 0, false); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("bad number err = %v", err)
	}

	// SQLite: another store on the same database (a restart) serves the last fetch while
	// GitHub fails.
	f2 := &fakeRunner{}
	f2.set(func(string, map[string]any) (json.RawMessage, error) { return nil, errors.New("github graphql: down") })
	opts2 := testOptions(db, f2, nil)
	opts2.Now = clk.now
	s2 := startStore(t, opts2)
	d2, err := s2.FullPullRequest(ctx, "o/r", 1, false)
	if err != nil || d2.Body != "second body" || d2.LastError == "" || d2.PullRequest.ID != "PR_a" {
		t.Errorf("restart: err %v body %q lastError %q", err, d2.Body, d2.LastError)
	}
}

func TestReviewerCandidatesThroughWorker(t *testing.T) {
	data := fixtureData(t, "reviewer_candidates_13779.json")
	var mu sync.Mutex
	var got []map[string]any
	f := &fakeRunner{}
	f.set(func(op string, vars map[string]any) (json.RawMessage, error) {
		if op != "ReviewerCandidates" {
			return nil, errors.New("github graphql: not this one")
		}
		mu.Lock()
		got = append(got, vars)
		mu.Unlock()
		return data, nil
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	c, err := s.ReviewerCandidates(context.Background(), "ghostty-org/ghostty", 13779, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Candidates) != 94 || c.Candidates[0].Login != "bo2themax" || !c.Candidates[1].Requested || c.Candidates[2].Requested {
		t.Errorf("candidates = %d, head %+v", len(c.Candidates), c.Candidates[:3])
	}

	// The query is trimmed; blank skips the search.
	tests := []struct {
		query, want string
		search      bool
	}{
		{query: "", want: "", search: false},
		{query: "   ", want: "", search: false},
		{query: " jc ", want: "jc", search: true},
	}
	for _, tt := range tests {
		mu.Lock()
		got = nil
		mu.Unlock()
		if _, err := s.ReviewerCandidates(context.Background(), "ghostty-org/ghostty", 13779, tt.query); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		if len(got) != 1 || got[0]["owner"] != "ghostty-org" || got[0]["name"] != "ghostty" || got[0]["number"] != 13779 ||
			got[0]["query"] != tt.want || got[0]["search"] != tt.search {
			t.Errorf("query %q: vars = %v", tt.query, got)
		}
		mu.Unlock()
	}
	if n := f.count("ReviewerCandidates"); n != 4 {
		t.Errorf("requests = %d", n)
	}
}

// A search of several words through the worker, against the fake's substring search:
// "jane doe" finds the user stored as "Doe, Jane" (GitHub's whole-string search alone
// would not), in one request.
func TestReviewerCandidatesSeveralWords(t *testing.T) {
	g, _ := changeDrivenWorld() // #1 open
	g.detail.assignable = []ReviewerCandidate{
		{ID: "U1", Login: "jdoe", Name: "Doe, Jane"},
		{ID: "U2", Login: "janet", Name: "Janet Smith"},
		{ID: "U3", Login: "doe-j", Name: "John Doe"},
		{ID: "U4", Login: "jane-doe-bot", Name: ""},
	}
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	ctx := context.Background()
	before := f.count("ReviewerCandidates")
	for _, q := range []string{"jane doe", " doe, jane ", "Doe,Jane"} {
		c, err := s.ReviewerCandidates(ctx, "o/r", 1, q)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, x := range c.Candidates {
			if !x.Requested {
				got = append(got, x.Login)
			}
		}
		if want := []string{"jane-doe-bot", "jdoe"}; !slices.Equal(got, want) {
			t.Errorf("%q: got %v, want %v", q, got, want)
		}
	}
	if n := f.count("ReviewerCandidates") - before; n != 3 {
		t.Errorf("requests = %d, want one per search", n)
	}
}

func TestSetReviewRequestREST(t *testing.T) {
	srv := newAPIServer(t, "tok", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/graphql": // the store's own polls
			_, _ = w.Write([]byte(`{"data":{"viewer":{"id":"U1","login":"octocat"}}}`))
		case r.URL.Path == "/repos/o/r/pulls/2/requested_reviewers":
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"Validation Failed","errors":["Review cannot be requested from pull request author."],"status":"422"}`))
		case r.URL.Path == "/repos/o/r/pulls/3/requested_reviewers":
			w.Header().Set("X-Ratelimit-Remaining", "4999")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Must have push access to repository","status":"403"}`))
		case r.URL.Path == "/repos/o/r/pulls/4/requested_reviewers" && r.Method == http.MethodPost:
			// GitHub took the request but did not add the reviewer (no access): only kim is pending.
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"number":4,"requested_reviewers":[{"login":"Kim"}],"requested_teams":[],"base":{"repo":{"owner":{"login":"o"}}}}`))
		case r.URL.Path == "/repos/o/r/pulls/4/requested_reviewers":
			// A withdraw GitHub did not apply: kim and the core team are still pending.
			_, _ = w.Write([]byte(`{"number":4,"requested_reviewers":[{"login":"kim"}],"requested_teams":[{"slug":"core"}],"base":{"repo":{"owner":{"login":"o"}}}}`))
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"number":1,"requested_reviewers":[{"login":"kim"}],"requested_teams":[{"slug":"core"}],"base":{"repo":{"owner":{"login":"o"}}}}`))
		default:
			_, _ = w.Write([]byte(`{"number":1,"requested_reviewers":[],"requested_teams":[],"base":{"repo":{"owner":{"login":"o"}}}}`))
		}
	})
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	runner := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
	s := startStore(t, testOptions(openTestDB(t), runner, b))
	ctx := context.Background()

	writes := func() []recorded {
		srv.mu.Lock()
		defer srv.mu.Unlock()
		var out []recorded
		for _, r := range srv.reqs {
			if r.path != "/graphql" {
				out = append(out, r)
			}
		}
		return out
	}
	tests := []struct {
		name       string
		number     int
		req        ReviewRequest
		method     string
		body       string // JSON, compared after decoding
		want       []string
		err        error
		errContain string
	}{
		{name: "request a user", number: 1, req: ReviewRequest{Login: "kim", Requested: true},
			method: "POST", body: `{"reviewers":["kim"],"team_reviewers":[]}`, want: []string{"kim", "o/core"}},
		{name: "withdraw a team given as org/team", number: 1, req: ReviewRequest{Login: "acme/core", Kind: ReviewerTeam},
			method: "DELETE", body: `{"reviewers":[],"team_reviewers":["core"]}`, want: []string{}},
		{name: "request a team by slug", number: 1, req: ReviewRequest{Login: "core", Kind: ReviewerTeam, Requested: true},
			method: "POST", body: `{"reviewers":[],"team_reviewers":["core"]}`, want: []string{"kim", "o/core"}},
		{name: "GitHub refuses (422)", number: 2, req: ReviewRequest{Login: "octocat", Kind: ReviewerUser, Requested: true},
			method: "POST", body: `{"reviewers":["octocat"],"team_reviewers":[]}`, err: ErrFailedPrecondition,
			errContain: "Review cannot be requested from pull request author."},
		{name: "no push access (403, not a rate limit)", number: 3, req: ReviewRequest{Login: "kim", Requested: true},
			method: "POST", body: `{"reviewers":["kim"],"team_reviewers":[]}`, err: ErrPermissionDenied,
			errContain: "Must have push access to repository"},
		{name: "GitHub answers but did not add the user", number: 4, req: ReviewRequest{Login: "outsider", Requested: true},
			method: "POST", body: `{"reviewers":["outsider"],"team_reviewers":[]}`, err: ErrFailedPrecondition,
			errContain: "GitHub did not add outsider as a reviewer (they may lack access to the repository)"},
		{name: "added: the login compares case-insensitively", number: 4, req: ReviewRequest{Login: "kIM", Requested: true},
			method: "POST", body: `{"reviewers":["kIM"],"team_reviewers":[]}`, want: []string{"Kim"}},
		{name: "GitHub answers but did not add the team", number: 4, req: ReviewRequest{Login: "o/core", Kind: ReviewerTeam, Requested: true},
			method: "POST", body: `{"reviewers":[],"team_reviewers":["core"]}`, err: ErrFailedPrecondition,
			errContain: "GitHub did not add team core as a reviewer"},
		{name: "a bot is not checked (GitHub lists it under another login)", number: 4,
			req:    ReviewRequest{Login: "copilot-pull-request-reviewer[bot]", Requested: true},
			method: "POST", body: `{"reviewers":["copilot-pull-request-reviewer[bot]"],"team_reviewers":[]}`, want: []string{"Kim"}},
		{name: "withdraw GitHub did not apply", number: 4, req: ReviewRequest{Login: "KIM"},
			method: "DELETE", body: `{"reviewers":["KIM"],"team_reviewers":[]}`, err: ErrFailedPrecondition,
			errContain: "GitHub still lists KIM as a requested reviewer"},
		{name: "team withdraw GitHub did not apply", number: 4, req: ReviewRequest{Login: "core", Kind: ReviewerTeam},
			method: "DELETE", body: `{"reviewers":[],"team_reviewers":["core"]}`, err: ErrFailedPrecondition,
			errContain: "GitHub still lists team core"},
		{name: "withdraw a user: gone afterwards", number: 1, req: ReviewRequest{Login: "kim"},
			method: "DELETE", body: `{"reviewers":["kim"],"team_reviewers":[]}`, want: []string{}},
		{name: "invalid login: nothing sent", number: 1, req: ReviewRequest{Login: "not a login", Requested: true}, err: ErrInvalidArgument},
		{name: "invalid kind: nothing sent", number: 1, req: ReviewRequest{Login: "kim", Kind: "ROBOT"}, err: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			k := fullKey{"o/r", tt.number}
			s.full.put(k, FullPullRequest{PullRequest: PullRequest{ID: "PR_x", Number: tt.number}, FetchedAt: time.Now()})
			before := len(writes())
			drain(events)
			got, err := s.SetReviewRequest(ctx, "o/r", tt.number, tt.req)
			sent := writes()[before:]
			if tt.method == "" {
				if len(sent) != 0 {
					t.Errorf("sent %d requests, want none", len(sent))
				}
			} else {
				if len(sent) != 1 {
					t.Fatalf("sent %d requests, want 1", len(sent))
				}
				r := sent[0]
				if r.method != tt.method || r.path != "/repos/o/r/pulls/"+strconv.Itoa(tt.number)+"/requested_reviewers" ||
					r.contentType != "application/json" || r.auth != "Bearer tok" {
					t.Errorf("request = %s %s (%s, %s)", r.method, r.path, r.contentType, r.auth)
				}
				var gotBody, wantBody any
				_ = json.Unmarshal(r.body, &gotBody)
				_ = json.Unmarshal([]byte(tt.body), &wantBody)
				if !sameJSON(gotBody, wantBody) {
					t.Errorf("body = %s, want %s", r.body, tt.body)
				}
			}
			_, stale, _ := s.full.get(k)
			if tt.err != nil {
				if !errors.Is(err, tt.err) || !strings.Contains(err.Error(), tt.errContain) {
					t.Errorf("err = %v, want %v containing %q", err, tt.err, tt.errContain)
				}
				if stale || drain(events) != 0 {
					t.Error("a failed request invalidated the detail")
				}
				return
			}
			if err != nil || !slices.Equal(got, tt.want) {
				t.Errorf("got %v, %v; want %v", got, err, tt.want)
			}
			if !stale || drain(events) != 1 {
				t.Errorf("detail stale %v; want stale with one event", stale)
			}
		})
	}

	// A rejected token takes the auth-paused path like every other request.
	srv.mu.Lock()
	srv.valid = "other"
	srv.mu.Unlock()
	if _, err := s.SetReviewRequest(ctx, "o/r", 1, ReviewRequest{Login: "kim", Requested: true}); !errors.Is(err, ErrNotAuthenticated) {
		t.Errorf("401 err = %v", err)
	}
	if s.Snapshot().Viewer.Authenticated {
		t.Error("viewer still authenticated after a 401")
	}
}

func TestSetReviewRequestNeedsRESTWriter(t *testing.T) {
	s := startStore(t, testOptions(openTestDB(t), (&fakeRunner{}).serve(newFakeGitHub()), nil))
	if _, err := s.SetReviewRequest(context.Background(), "o/r", 1, ReviewRequest{Login: "kim", Requested: true}); err == nil {
		t.Error("want an error without a RESTWriter")
	}
}

func TestRevertPullRequest(t *testing.T) {
	b := bus.New()
	events := bus.Subscribe[PullRequestDetailUpdated](b, 64)
	g, _ := changeDrivenWorld() // #1 open, #3 merged
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	ctx := context.Background()

	// Not merged: refused without calling the mutation (after a fresh look).
	_, err := s.RevertPullRequest(ctx, "o/r", 1)
	if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), "is open, not merged") {
		t.Errorf("open PR err = %v", err)
	}
	if n := f.count("RevertPullRequest"); n != 0 {
		t.Errorf("mutation called %d times for an open PR", n)
	}
	if n := f.count("PullRequestFull"); n != 2 {
		t.Errorf("detail fetches = %d, want 2 (cache miss, then a refresh to confirm)", n)
	}
	drain(events)

	polls := f.count("Poll")
	res, err := s.RevertPullRequest(ctx, "o/r", 3)
	if err != nil || res.Number != 901 || res.URL != "https://github.com/o/r/pull/901" {
		t.Fatalf("revert = %+v, %v", res, err)
	}
	if got := g.reverts(); !slices.Equal(got, []string{"PR_c"}) {
		t.Errorf("mutation ids = %v", got)
	}
	if drain(events) != 1 {
		t.Error("want a detail event for the reverted PR")
	}
	if _, stale, _ := s.full.get(fullKey{"o/r", 3}); !stale {
		t.Error("reverted PR's detail not stale")
	}
	waitFor(t, "a poll after the revert", func() bool { return f.count("Poll") > polls })

	// A repeat does not open a second revert.
	again, err := s.RevertPullRequest(ctx, "o/r", 3)
	if err != nil || again != res || len(g.reverts()) != 1 {
		t.Errorf("repeat = %+v, %v; mutations %d", again, err, len(g.reverts()))
	}

	// During a rate-limit pause, on-demand calls fail fast.
	s.mu.Lock()
	s.pauseUntil = time.Now().Add(time.Hour)
	s.pauseErr = &RateLimitError{Secondary: true, Msg: "slow down"}
	s.mu.Unlock()
	if _, err := s.RevertPullRequest(ctx, "o/r", 2); !errors.Is(err, ErrRateLimited) {
		t.Errorf("paused err = %v", err)
	}
	if _, err := s.ReviewerCandidates(ctx, "o/r", 1, ""); !errors.Is(err, ErrRateLimited) {
		t.Errorf("paused candidates err = %v", err)
	}
}

// A poll that sees a pull request's fingerprint unchanged confirms its cached detail,
// so reads past the poll interval are served from cache; pull requests the poll does
// not cover keep the age rule, and merged ones age at closedDetailTTL.
func TestFullPullRequestConfirmedByPoll(t *testing.T) {
	g, t0 := changeDrivenWorld()
	g.addPR(fakePR("PR_u", "o/r", 4, t0)) // on no dashboard: the poll never sees it
	uncoveredMerged := fakePR("PR_m", "o/r", 5, t0)
	uncoveredMerged.State, uncoveredMerged.MergedAt = PullRequestMerged, t0
	g.addPR(uncoveredMerged)
	f := (&fakeRunner{}).serve(g)
	clk := &testClock{}
	opts := testOptions(openTestDB(t), f, nil)
	opts.Now = clk.now
	opts.Config = func() Config { return Config{PollInterval: time.Minute, Dashboards: true} }
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	ctx := context.Background()
	fetchesOf := map[int]int{}
	read := func(number int) {
		t.Helper()
		before := f.count("PullRequestFull")
		if _, err := s.FullPullRequest(ctx, "o/r", number, false); err != nil {
			t.Fatal(err)
		}
		fetchesOf[number] += f.count("PullRequestFull") - before
	}
	expect := func(step string, want map[int]int) {
		t.Helper()
		for n, w := range want {
			if fetchesOf[n] != w {
				t.Errorf("%s: #%d fetched %d times, want %d", step, n, fetchesOf[n], w)
			}
		}
	}
	readAll := func() {
		t.Helper()
		for _, n := range []int{1, 3, 4, 5} {
			read(n)
		}
	}

	readAll()
	expect("first reads", map[int]int{1: 1, 3: 1, 4: 1, 5: 1})

	// Past the interval, after a poll that saw #1 (authored) and #3 (merged) unchanged.
	clk.advance(61 * time.Second)
	pollOnce(t, s, f)
	readAll()
	expect("past the interval, confirmed", map[int]int{1: 1, 3: 1, 4: 2, 5: 1})

	// Keep polling and reading each minute: #1 and #3 stay confirmed until
	// confirmedMaxAge, #4 refetches every interval, #5 (merged) once closedDetailTTL ends.
	for range 9 {
		clk.advance(61 * time.Second)
		pollOnce(t, s, f)
		readAll()
	}
	// 10 x 61s after the first fetch: #1, #3, and #5 crossed 10 minutes once.
	expect("ten minutes on", map[int]int{1: 2, 3: 2, 4: 11, 5: 2})

	// A move the poll sees still makes the next read fetch, confirmation or not.
	g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
	pollOnce(t, s, f)
	read(1)
	expect("moved", map[int]int{1: 3})
}
