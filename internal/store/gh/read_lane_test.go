package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// readLaneRunner implements Runner, RESTRunner, RawRESTRunner, and RESTWriter while
// tracking total concurrent in-flight requests across all transports and letting tests
// block specific operations on either lane.
type readLaneRunner struct {
	g *fakeGitHub

	mu          sync.Mutex
	inflight    int
	maxInflight int
	writeActive bool
	readWhileWr bool
	ops         []string

	// onOp is an optional hook called right before answering a GraphQL/REST request.
	onOp func(ctx context.Context, op string, isWrite bool)
	// afterOp is an optional hook called after g.respond computed its answer.
	afterOp func(ctx context.Context, op string, data json.RawMessage, err error) (json.RawMessage, error)
	// customGraphQL overrides GraphQL responses for ops not handled by fakeGitHub (e.g. PublishOwners).
	customGraphQL func(op, doc string, vars map[string]any) (json.RawMessage, error, bool)
	// customREST overrides REST GET responses.
	customREST func(path string, params map[string]string) (json.RawMessage, error)
	// customRaw overrides RawREST responses.
	customRaw func(path string, params map[string]string, accept string) (RawResponse, error)
	// customWrite overrides RESTWrite responses.
	customWrite func(method, path string, body any) (json.RawMessage, error)
}

func (r *readLaneRunner) enter(ctx context.Context, op string, isWrite bool) func() {
	r.mu.Lock()
	r.inflight++
	r.maxInflight = max(r.maxInflight, r.inflight)
	if isWrite {
		if r.inflight > 1 || r.writeActive {
			r.readWhileWr = true
		}
		r.writeActive = true
	} else if r.writeActive {
		r.readWhileWr = true
	}
	r.ops = append(r.ops, op)
	hook := r.onOp
	r.mu.Unlock()
	if hook != nil {
		hook(ctx, op, isWrite)
	}
	return func() {
		r.mu.Lock()
		r.inflight--
		if isWrite {
			r.writeActive = false
		}
		r.mu.Unlock()
	}
}

func (r *readLaneRunner) GraphQL(ctx context.Context, q string, vars map[string]any) (json.RawMessage, error) {
	op := opRE.FindStringSubmatch(q)[1]
	isWrite := isMutation(q)
	leave := r.enter(ctx, op, isWrite)
	defer leave()

	r.mu.Lock()
	custom := r.customGraphQL
	after := r.afterOp
	r.mu.Unlock()

	var (
		data json.RawMessage
		err  error
		ok   bool
	)
	if custom != nil {
		data, err, ok = custom(op, q, vars)
	}
	if !ok {
		data, err = r.g.respond(op, q, vars)
	}
	if after != nil {
		data, err = after(ctx, op, data, err)
	}
	return data, err
}

func (r *readLaneRunner) AuthStatus(context.Context) (AuthStatus, error) {
	return AuthStatus{LoggedIn: true, Login: "octocat"}, nil
}

func (r *readLaneRunner) REST(ctx context.Context, p string, params map[string]string) (json.RawMessage, error) {
	leave := r.enter(ctx, "REST:"+p, false)
	defer leave()
	r.mu.Lock()
	fn := r.customREST
	r.mu.Unlock()
	if fn != nil {
		return fn(p, params)
	}
	return json.RawMessage(`{"total_count": 7}`), nil
}

func (r *readLaneRunner) RESTRaw(ctx context.Context, p string, params map[string]string, accept string, _ int64) (RawResponse, error) {
	leave := r.enter(ctx, "RAW:"+p, false)
	defer leave()
	r.mu.Lock()
	fn := r.customRaw
	r.mu.Unlock()
	if fn != nil {
		return fn(p, params, accept)
	}
	return RawResponse{Body: []byte("diff --git a/a.go b/a.go\n+ok\n"), ContentType: "text/plain"}, nil
}

func (r *readLaneRunner) RESTWrite(ctx context.Context, method, p string, body any) (json.RawMessage, error) {
	leave := r.enter(ctx, "WRITE:"+method+":"+p, true)
	defer leave()
	r.mu.Lock()
	fn := r.customWrite
	r.mu.Unlock()
	if fn != nil {
		return fn(method, p, body)
	}
	return json.RawMessage(`{"requested_reviewers":[{"login":"alice"}],"requested_teams":[]}`), nil
}

func (r *readLaneRunner) stats() (inflight, maxInflight int, readWhileWrite bool, ops []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.inflight, r.maxInflight, r.readWhileWr, slices.Clone(r.ops)
}

func newReadLaneStore(t *testing.T, mod func(*Options)) (*fakeGitHub, *readLaneRunner, *Store, *bus.Subscription[Polled]) {
	t.Helper()
	b := bus.New()
	polled := bus.Subscribe[Polled](b, 64)
	g, t0 := changeDrivenWorld()
	g.addPR(fakePR("PR_2", "o/r", 2, t0), sectionAuthored)
	g.setBody("PR_a", "initial body")
	g.cards = []Repository{{Owner: "o", Name: "r", Visibility: VisibilityPublic, URL: "https://github.com/o/r"}}
	g.detail.assignable = []ReviewerCandidate{{ID: "U1", Login: "alice", Name: "Alice"}}

	r := &readLaneRunner{g: g}
	prHandler := answerPullRequest(g)
	r.customGraphQL = func(op, doc string, vars map[string]any) (json.RawMessage, error, bool) {
		switch op {
		case "PublishOwners":
			return json.RawMessage(`{"rateLimit":{"limit":5000,"cost":1,"remaining":4000,"resetAt":"2030-01-01T00:00:00Z"},"viewer":{"login":"octocat","organizations":{"nodes":[{"login":"acme","viewerCanCreateRepositories":true}]}}}`), nil, true
		case "PullRequest":
			data, err := prHandler(op, doc, vars)
			return data, err, true
		}
		return nil, nil, false
	}
	r.customREST = func(p string, _ map[string]string) (json.RawMessage, error) {
		if strings.HasPrefix(p, "orgs/") {
			return json.RawMessage(`{"members_can_create_public_repositories":true,"members_can_create_private_repositories":true}`), nil
		}
		return json.RawMessage(`{"total_count": 7}`), nil
	}

	opts := testOptions(openTestDB(t), r, b)
	opts.MinGap = 4 * time.Millisecond
	opts.UserGap = time.Millisecond
	if mod != nil {
		mod(&opts)
	}
	s := startStore(t, opts)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	// Run initial poll to warm viewer & state, then drain.
	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-polled.C():
	case <-time.After(5 * time.Second):
		t.Fatal("initial poll did not finish")
	}
	drain(polled)
	r.mu.Lock()
	r.maxInflight = 0
	r.readWhileWr = false
	r.ops = nil
	r.mu.Unlock()
	return g, r, s, polled
}

// Every eligible user-waited read completes on the read lane WHILE a slow poll is still
// blocked in flight on the primary worker — zero wait for the poll to finish.
func TestReadLaneOverlapsSlowPollForAllEligibleReads(t *testing.T) {
	sha := strings.Repeat("a", 40)
	tests := []struct {
		name string
		read func(ctx context.Context, s *Store) error
	}{
		{"FullPullRequest", func(ctx context.Context, s *Store) error {
			d, err := s.FullPullRequest(ctx, "o/r", 1, true)
			if err == nil && d.PullRequest.Number != 1 {
				return fmt.Errorf("unexpected PR %d", d.PullRequest.Number)
			}
			return err
		}},
		{"PullRequestDiff", func(ctx context.Context, s *Store) error {
			d, err := s.PullRequestDiff(ctx, "o/r", 1, true)
			if err == nil && !strings.Contains(d.Diff, "diff --git") {
				return fmt.Errorf("unexpected diff %q", d.Diff)
			}
			return err
		}},
		{"PullRequestFile", func(ctx context.Context, s *Store) error {
			f, err := s.PullRequestFile(ctx, "o/r", sha, "a.go")
			if err == nil && len(f.Contents) == 0 {
				return errors.New("empty file")
			}
			return err
		}},
		{"PullRequest", func(ctx context.Context, s *Store) error {
			d, err := s.PullRequest(ctx, "o/r", 1)
			if err == nil && d.PullRequest.Number != 1 {
				return fmt.Errorf("unexpected PR %d", d.PullRequest.Number)
			}
			return err
		}},
		{"ReviewerCandidates", func(ctx context.Context, s *Store) error {
			c, err := s.ReviewerCandidates(ctx, "o/r", 1, "al")
			if err == nil && len(c.Candidates) == 0 {
				return errors.New("no candidates")
			}
			return err
		}},
		{"SearchRepositories", func(ctx context.Context, s *Store) error {
			repos, err := s.SearchRepositories(ctx, "r")
			if err == nil && len(repos) == 0 {
				return errors.New("no repos")
			}
			return err
		}},
		{"LookupRepository", func(ctx context.Context, s *Store) error {
			repo, err := s.LookupRepository(ctx, "o", "r")
			if err == nil && repo.Slug() != "o/r" {
				return fmt.Errorf("unexpected repo %q", repo.Slug())
			}
			return err
		}},
		{"PublishOwners", func(ctx context.Context, s *Store) error {
			owners, err := s.PublishOwners(ctx)
			if err == nil && len(owners) != 2 {
				return fmt.Errorf("owners = %+v, want 2", owners)
			}
			return err
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, r, s, polled := newReadLaneStore(t, nil)
			pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
			var holdOnce, releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(pollRelease) })

			r.mu.Lock()
			r.onOp = func(_ context.Context, op string, _ bool) {
				if op == "Poll" {
					holdOnce.Do(func() {
						close(pollEntered)
						<-pollRelease
					})
				}
			}
			r.mu.Unlock()

			if err := s.Refresh(context.Background(), ""); err != nil {
				t.Fatal(err)
			}
			<-pollEntered

			// Call the read while Poll is STILL blocked in flight on primary.
			done := make(chan error, 1)
			go func() {
				done <- tt.read(context.Background(), s)
			}()
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("%s failed while poll held: %v", tt.name, err)
				}
			case <-time.After(3 * time.Second):
				t.Fatalf("%s blocked waiting for the held poll instead of using the read lane", tt.name)
			}

			_, maxInf, readWhileWr, _ := r.stats()
			if maxInf != 2 {
				t.Errorf("maxInflight = %d, want 2 (poll + read lane)", maxInf)
			}
			if readWhileWr {
				t.Error("read ran concurrently with a write")
			}

			releaseOnce.Do(func() { close(pollRelease) })
			select {
			case <-polled.C():
			case <-time.After(5 * time.Second):
				t.Fatal("poll did not finish after release")
			}
		})
	}
}

// Multi-page Checks pagination inside FullPullRequest also completes on the read lane
// while a slow detail batch is blocked on the primary worker.
func TestReadLaneOverlapsSlowDetailBatchWithPaginatedChecks(t *testing.T) {
	g, r, s, polled := newReadLaneStore(t, func(o *Options) { o.MaxPages = 3 })
	// Add >0 checks with pagination by answering Checks page 2 via customGraphQL.
	p1 := fixtureData(t, "pull_request_14586_page1.json")
	p2 := fixtureData(t, "pull_request_14586_page2.json")
	r.mu.Lock()
	r.customGraphQL = func(op, _ string, vars map[string]any) (json.RawMessage, error, bool) {
		if op == "PullRequest" {
			if _, paged := vars["after"]; paged {
				return p2, nil, true
			}
			return p1, nil, true
		}
		return nil, nil, false
	}
	r.mu.Unlock()

	// Move PR_a so the next poll triggers a PullRequestDetails batch.
	g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
	entered, release := make(chan struct{}), make(chan struct{})
	var holdOnce, relOnce sync.Once
	defer relOnce.Do(func() { close(release) })
	r.mu.Lock()
	r.onOp = func(_ context.Context, op string, _ bool) {
		if op == "PullRequestDetails" {
			holdOnce.Do(func() {
				close(entered)
				<-release
			})
		}
	}
	r.mu.Unlock()

	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	<-entered

	done := make(chan PullRequestDetail, 1)
	errCh := make(chan error, 1)
	go func() {
		d, err := s.PullRequest(context.Background(), "ghostty-org/ghostty", 14586)
		if err != nil {
			errCh <- err
			return
		}
		done <- d
	}()
	select {
	case err := <-errCh:
		t.Fatalf("PullRequest failed: %v", err)
	case d := <-done:
		if len(d.Checks) != 105 {
			t.Errorf("checks = %d, want 105 across 2 pages", len(d.Checks))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("PullRequest with 2 check pages blocked behind held PullRequestDetails")
	}
	_, maxInf, _, _ := r.stats()
	if maxInf != 2 {
		t.Errorf("maxInflight = %d, want 2", maxInf)
	}
	relOnce.Do(func() { close(release) })
	<-polled.C()
}

// Ineligible jobs (Refresh(slug) polls, promised background refreshes with 0 waiters,
// WatchProjects, and mutations/REST writes) NEVER use the read lane.
func TestReadLaneExcludesIneligibleJobs(t *testing.T) {
	_, r, s, polled := newReadLaneStore(t, nil)
	if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.maxInflight = 0
	r.mu.Unlock()

	entered, release := make(chan struct{}), make(chan struct{})
	var holdOnce, relOnce sync.Once
	defer relOnce.Do(func() { close(release) })
	r.mu.Lock()
	r.onOp = func(_ context.Context, op string, _ bool) {
		if op == "Poll" {
			holdOnce.Do(func() {
				close(entered)
				<-release
			})
		}
	}
	r.mu.Unlock()

	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	<-entered

	// Queue: background refresh (0 waiters), Refresh(slug) poll, GraphQL mutation, RESTWrite.
	if err := s.refreshFull(fullKey{"o/r", 1}); err != nil {
		t.Fatal(err)
	}
	refreshDone := make(chan error, 1)
	go func() { refreshDone <- s.Refresh(context.Background(), "o/r") }()
	commentDone := make(chan error, 1)
	go func() {
		_, err := s.AddPullRequestComment(context.Background(), "o/r", 1, "hi")
		commentDone <- err
	}()
	reviewReqDone := make(chan error, 1)
	go func() {
		_, err := s.SetReviewRequest(context.Background(), "o/r", 1, ReviewRequest{Login: "alice", Requested: true})
		reviewReqDone <- err
	}()

	waitFor(t, "all 4 ineligible jobs queued", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == 4
	})
	// Give the read lane plenty of time to misbehave if it were going to claim any of them.
	time.Sleep(30 * time.Millisecond)
	inf, maxInf, readWhileWr, _ := r.stats()
	if inf != 1 || maxInf != 1 {
		t.Errorf("inflight=%d maxInflight=%d while only ineligible jobs queued, want 1", inf, maxInf)
	}
	if readWhileWr {
		t.Error("write overlapped with read")
	}

	relOnce.Do(func() { close(release) })
	for _, ch := range []<-chan error{refreshDone, commentDone, reviewReqDone} {
		if err := recv(t, ch); err != nil {
			t.Fatalf("job failed: %v", err)
		}
	}
	<-polled.C()
	settleWorker(t, s)
	_, maxInf, readWhileWr, _ = r.stats()
	if maxInf != 1 || readWhileWr {
		t.Errorf("after draining ineligible jobs: maxInflight=%d readWhileWrite=%v, want 1 / false", maxInf, readWhileWr)
	}
}

// Writes are strictly serial:
//  1. While a GraphQL mutation or RESTWrite is in flight on primary, a user-waited read
//     NEVER dispatches on the read lane.
//  2. While a read-lane job is in flight, a queued write on primary waits for the read
//     lane to finish before starting (never runs concurrently with the read).
func TestReadLaneWriteSerialization(t *testing.T) {
	t.Run("read waits while GraphQL mutation is in flight", func(t *testing.T) {
		_, r, s, _ := newReadLaneStore(t, nil)
		if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		r.mu.Lock()
		r.maxInflight = 0
		r.readWhileWr = false
		r.mu.Unlock()

		entered, release := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(release) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "AddComment" {
				holdOnce.Do(func() {
					close(entered)
					<-release
				})
			}
		}
		r.mu.Unlock()

		writeDone := make(chan error, 1)
		go func() {
			_, err := s.AddPullRequestComment(context.Background(), "o/r", 1, "hello")
			writeDone <- err
		}()
		<-entered

		readDone := make(chan error, 1)
		go func() {
			_, err := s.FullPullRequest(context.Background(), "o/r", 2, true)
			readDone <- err
		}()
		waitFor(t, "read queued behind mutation", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return len(s.queue) == 1
		})
		time.Sleep(30 * time.Millisecond)
		if inf, maxInf, rww, _ := r.stats(); inf != 1 || maxInf != 1 || rww {
			t.Fatalf("during mutation: inflight=%d maxInflight=%d readWhileWrite=%v, want 1/1/false", inf, maxInf, rww)
		}

		relOnce.Do(func() { close(release) })
		if err := recv(t, writeDone); err != nil {
			t.Fatal(err)
		}
		if err := recv(t, readDone); err != nil {
			t.Fatal(err)
		}
		if _, maxInf, rww, _ := r.stats(); maxInf != 1 || rww {
			t.Errorf("after mutation: maxInflight=%d readWhileWrite=%v, want 1/false", maxInf, rww)
		}
	})

	t.Run("read waits while RESTWrite is in flight", func(t *testing.T) {
		_, r, s, _ := newReadLaneStore(t, nil)
		entered, release := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(release) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if strings.HasPrefix(op, "WRITE:") {
				holdOnce.Do(func() {
					close(entered)
					<-release
				})
			}
		}
		r.mu.Unlock()

		writeDone := make(chan error, 1)
		go func() {
			_, err := s.SetReviewRequest(context.Background(), "o/r", 1, ReviewRequest{Login: "alice", Requested: true})
			writeDone <- err
		}()
		<-entered

		readDone := make(chan error, 1)
		go func() {
			_, err := s.LookupRepository(context.Background(), "o", "r")
			readDone <- err
		}()
		waitFor(t, "read queued behind RESTWrite", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return len(s.queue) == 1
		})
		time.Sleep(30 * time.Millisecond)
		if inf, maxInf, rww, _ := r.stats(); inf != 1 || maxInf != 1 || rww {
			t.Fatalf("during RESTWrite: inflight=%d maxInflight=%d readWhileWrite=%v", inf, maxInf, rww)
		}

		relOnce.Do(func() { close(release) })
		if err := recv(t, writeDone); err != nil {
			t.Fatal(err)
		}
		if err := recv(t, readDone); err != nil {
			t.Fatal(err)
		}
		if _, maxInf, rww, _ := r.stats(); maxInf != 1 || rww {
			t.Errorf("after RESTWrite: maxInflight=%d readWhileWrite=%v", maxInf, rww)
		}
	})

	t.Run("write drains in-flight read-lane job before starting", func(t *testing.T) {
		const minGap = 30 * time.Millisecond
		_, r, s, polled := newReadLaneStore(t, func(o *Options) {
			o.MinGap = minGap
			o.UserGap = 5 * time.Millisecond
		})
		if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		r.mu.Lock()
		r.maxInflight = 0
		r.readWhileWr = false
		r.mu.Unlock()

		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		readEntered, readRelease := make(chan struct{}), make(chan struct{})
		var pollOnceH, readOnceH, pollRel, readRel sync.Once
		defer pollRel.Do(func() { close(pollRelease) })
		defer readRel.Do(func() { close(readRelease) })

		var readEnd, writeStart atomic.Int64
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			switch op {
			case "Poll":
				pollOnceH.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			case "PullRequestFull":
				readOnceH.Do(func() {
					close(readEntered)
					<-readRelease
					readEnd.Store(time.Now().UnixNano())
				})
			case "AddComment":
				writeStart.Store(time.Now().UnixNano())
			}
		}
		r.mu.Unlock()

		// 1. Start Poll on primary.
		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		// 2. Start FullPullRequest on read lane and hold it in flight.
		readDone := make(chan error, 1)
		go func() {
			_, err := s.FullPullRequest(context.Background(), "o/r", 2, true)
			readDone <- err
		}()
		<-readEntered

		// 3. Queue a write while both lanes are busy.
		writeDone := make(chan error, 1)
		go func() {
			_, err := s.AddPullRequestComment(context.Background(), "o/r", 1, "after read")
			writeDone <- err
		}()
		waitFor(t, "write queued", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return len(s.queue) == 1
		})

		// 4. Release Poll: primary finishes Poll and claims the write, which MUST wait
		// for the in-flight read-lane job to finish before executing AddComment.
		pollRel.Do(func() { close(pollRelease) })
		<-polled.C()
		time.Sleep(30 * time.Millisecond)
		if writeStart.Load() != 0 {
			t.Fatal("mutation started while read-lane request was still in flight")
		}

		// 5. Release read-lane job -> write should now run after MinGap with zero overlap.
		readRel.Do(func() { close(readRelease) })
		if err := recv(t, readDone); err != nil {
			t.Fatal(err)
		}
		if err := recv(t, writeDone); err != nil {
			t.Fatal(err)
		}
		_, maxInf, rww, _ := r.stats()
		if rww {
			t.Error("read and write ran concurrently")
		}
		if maxInf != 2 {
			t.Errorf("maxInflight = %d, want 2 (poll + read lane)", maxInf)
		}
		gap := time.Duration(writeStart.Load() - readEnd.Load())
		if gap < minGap-5*time.Millisecond {
			t.Errorf("write started %v after read-lane end, want >= %v", gap, minGap)
		}
	})
}

// Global pauses (rate limit, network error, auth error, low remaining budget) on EITHER
// lane immediately stop BOTH lanes without sending refused requests.
func TestReadLaneGlobalPausePropagation(t *testing.T) {
	t.Run("read lane rate limit stops primary poll stages and exhausts allowance", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, func(o *Options) {
			o.SecondaryBackoff = time.Hour
			o.MaxBackoff = time.Hour
		})
		// Make PR_a move so Poll would normally follow up with PullRequestDetails.
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
		g.failNext("LookupRepository", &RateLimitError{Secondary: true, Msg: "slow down"})

		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			}
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		// Read lane hits secondary rate limit while Poll is still in flight.
		_, err := s.LookupRepository(context.Background(), "o", "r")
		if !errors.Is(err, ErrRateLimited) {
			t.Fatalf("read-lane err = %v, want ErrRateLimited", err)
		}
		s.mu.Lock()
		allowanceLeft := s.allowance.left(s.opts.Now())
		paused := s.pausedLocked() != nil
		s.mu.Unlock()
		if allowanceLeft {
			t.Error("allowance was not exhausted by read-lane rate limit")
		}
		if !paused {
			t.Error("store not paused after read-lane rate limit")
		}

		// Release Poll: PullRequestDetails MUST be refused without sending.
		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()
		_, _, _, ops := r.stats()
		if slices.Contains(ops, "PullRequestDetails") {
			t.Errorf("ops %v: primary sent PullRequestDetails despite read-lane pause", ops)
		}
	})

	t.Run("read lane low budget stops primary", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, nil)
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			}
		}
		r.customGraphQL = func(op, _ string, _ map[string]any) (json.RawMessage, error, bool) {
			if op == "LookupRepository" {
				reset := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
				return json.RawMessage(fmt.Sprintf(`{"rateLimit":{"limit":5000,"cost":1,"remaining":50,"resetAt":%q},"repository":{"name":"r","owner":{"login":"o"},"visibility":"PUBLIC","url":"https://github.com/o/r"}}`, reset)), nil, true
			}
			return nil, nil, false
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		if _, err := s.LookupRepository(context.Background(), "o", "r"); err != nil {
			t.Fatalf("LookupRepository: %v", err)
		}
		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()
		_, _, _, ops := r.stats()
		if slices.Contains(ops, "PullRequestDetails") {
			t.Errorf("ops %v: primary sent PullRequestDetails despite low budget on read lane", ops)
		}
	})

	t.Run("read lane auth failure stops primary", func(t *testing.T) {
		g, r, s, _ := newReadLaneStore(t, func(o *Options) { o.AuthRetry = time.Hour })
		g.failNext("LookupRepository", fmt.Errorf("%w: Bad credentials (HTTP 401)", ErrNotAuthenticated))

		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			}
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		_, err := s.LookupRepository(context.Background(), "o", "r")
		if !errors.Is(err, ErrNotAuthenticated) {
			t.Fatalf("err = %v, want ErrNotAuthenticated", err)
		}
		s.mu.Lock()
		authBad := s.authBad
		s.mu.Unlock()
		if !authBad {
			t.Error("authBad not set after read-lane 401")
		}
		relOnce.Do(func() { close(pollRelease) })
	})

	t.Run("primary network error stops queued read without sending", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, func(o *Options) {
			o.NetworkBackoff = time.Hour
			o.MaxBackoff = time.Hour
		})
		g.failNext("Poll", fmt.Errorf("%w: connection reset", ErrNetwork))
		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		// Exhaust allowance so the queued read waits for primary to finish Poll.
		s.mu.Lock()
		s.allowance.exhaust(s.opts.Now())
		s.mu.Unlock()
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			}
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		readErr := make(chan error, 1)
		go func() {
			_, err := s.LookupRepository(context.Background(), "o", "r")
			readErr <- err
		}()
		waitFor(t, "read queued", func() bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			return len(s.queue) == 1
		})
		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()
		if err := recv(t, readErr); !errors.Is(err, ErrNetwork) || !strings.Contains(err.Error(), "paused until") {
			t.Errorf("read err = %v, want paused ErrNetwork", err)
		}
		_, _, _, ops := r.stats()
		if slices.Contains(ops, "LookupRepository") {
			t.Errorf("ops %v: LookupRepository was sent despite primary network pause", ops)
		}
	})
}

// Once the 8-token allowance burst is exhausted on the read lane, additional reads do NOT
// run on the read lane while the poll is still held; they fall back cleanly to serial
// pacing on the primary worker.
func TestReadLaneAllowanceExhaustionFallsBackToSerial(t *testing.T) {
	_, r, s, polled := newReadLaneStore(t, func(o *Options) {
		o.MinGap = 5 * time.Millisecond
		o.UserGap = time.Millisecond
	})
	pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
	var holdOnce, relOnce sync.Once
	defer relOnce.Do(func() { close(pollRelease) })
	r.mu.Lock()
	r.onOp = func(_ context.Context, op string, _ bool) {
		if op == "Poll" {
			holdOnce.Do(func() {
				close(pollEntered)
				<-pollRelease
			})
		}
	}
	r.mu.Unlock()

	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	<-pollEntered

	const total = userGapBurst + 4
	doneCh := make(chan error, total)
	for i := range total {
		name := fmt.Sprintf("repo-%02d", i)
		go func() {
			_, err := s.SearchRepositories(context.Background(), name)
			doneCh <- err
		}()
	}

	// Exactly userGapBurst (8) reads complete on the read lane while Poll is held.
	for i := range userGapBurst {
		select {
		case err := <-doneCh:
			if err != nil {
				t.Fatalf("burst read %d failed: %v", i, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d/%d burst reads completed on read lane", i, userGapBurst)
		}
	}
	// The remaining 4 reads must wait in s.queue (allowance exhausted).
	waitFor(t, "remaining reads queued after allowance exhaustion", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == total-userGapBurst
	})
	select {
	case err := <-doneCh:
		t.Fatalf("9th read completed while poll still held and bucket empty (err=%v)", err)
	case <-time.After(30 * time.Millisecond):
	}
	s.mu.Lock()
	queued := len(s.queue)
	s.mu.Unlock()
	if queued != total-userGapBurst {
		t.Fatalf("queued = %d, want %d while poll still held and bucket empty", queued, total-userGapBurst)
	}

	// Release Poll -> remaining 4 reads complete serially on primary worker.
	relOnce.Do(func() { close(pollRelease) })
	for i := userGapBurst; i < total; i++ {
		if err := recv(t, doneCh); err != nil {
			t.Fatalf("fallback read %d failed: %v", i, err)
		}
	}
	<-polled.C()
	_, maxInf, _, _ := r.stats()
	if maxInf > 2 {
		t.Errorf("maxInflight = %d, want <= 2", maxInf)
	}
}

// Joining callers coalesce onto an in-flight read-lane job, abandoning an in-flight
// waiter leaves other waiters intact, and abandoning a queued read when both lanes are
// busy drops it with zero requests sent.
func TestReadLaneInflightDedupAndAbandon(t *testing.T) {
	_, r, s, polled := newReadLaneStore(t, nil)
	pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
	fullEntered, fullRelease := make(chan struct{}), make(chan struct{})
	var pOnce, fOnce, pRel, fRel sync.Once
	defer pRel.Do(func() { close(pollRelease) })
	defer fRel.Do(func() { close(fullRelease) })

	r.mu.Lock()
	r.onOp = func(_ context.Context, op string, _ bool) {
		switch op {
		case "Poll":
			pOnce.Do(func() {
				close(pollEntered)
				<-pollRelease
			})
		case "PullRequestFull":
			fOnce.Do(func() {
				close(fullEntered)
				<-fullRelease
			})
		}
	}
	r.mu.Unlock()

	if err := s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	<-pollEntered

	// 1st caller starts PullRequestFull on the read lane.
	res1 := make(chan error, 1)
	go func() {
		_, err := s.FullPullRequest(context.Background(), "o/r", 1, true)
		res1 <- err
	}()
	<-fullEntered

	// 2nd caller for the SAME PR coalesces onto s.inflight (no duplicate queued job).
	res2 := make(chan error, 1)
	go func() {
		_, err := s.FullPullRequest(context.Background(), "o/r", 1, true)
		res2 <- err
	}()
	// 3rd caller for the SAME PR cancels while in flight.
	ctx3, cancel3 := context.WithCancel(context.Background())
	res3 := make(chan error, 1)
	go func() {
		_, err := s.FullPullRequest(ctx3, "o/r", 1, true)
		res3 <- err
	}()
	key := (&job{kind: jobFunc, id: fullJobID(fullKey{"o/r", 1})}).key()
	waitFor(t, "3 waiters on in-flight read-lane job", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.inflight[key] != nil && len(s.inflight[key].waiters) == 3 && len(s.queue) == 0
	})

	cancel3()
	if err := recv(t, res3); !errors.Is(err, context.Canceled) {
		t.Fatalf("caller 3 = %v, want context.Canceled", err)
	}

	// A DIFFERENT read (PR #2) queues because both primary and read lane are busy;
	// cancelling it before dispatch removes it from s.queue and sends nothing.
	ctx4, cancel4 := context.WithCancel(context.Background())
	res4 := make(chan error, 1)
	go func() {
		_, err := s.LookupRepository(ctx4, "o", "r")
		res4 <- err
	}()
	waitFor(t, "distinct read queued while both lanes busy", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == 1
	})
	cancel4()
	if err := recv(t, res4); !errors.Is(err, context.Canceled) {
		t.Fatalf("caller 4 = %v, want context.Canceled", err)
	}
	s.mu.Lock()
	qLen := len(s.queue)
	s.mu.Unlock()
	if qLen != 0 {
		t.Fatalf("queue len = %d after abandoning queued read, want 0", qLen)
	}

	fRel.Do(func() { close(fullRelease) })
	if err := recv(t, res1); err != nil {
		t.Fatalf("caller 1: %v", err)
	}
	if err := recv(t, res2); err != nil {
		t.Fatalf("caller 2: %v", err)
	}
	pRel.Do(func() { close(pollRelease) })
	<-polled.C()

	_, _, _, ops := r.stats()
	fullCount := 0
	for _, op := range ops {
		if op == "PullRequestFull" {
			fullCount++
		}
		if op == "LookupRepository" {
			t.Errorf("abandoned queued read sent LookupRepository: %v", ops)
		}
	}
	if fullCount != 1 {
		t.Errorf("PullRequestFull count = %d, want 1 (coalesced across 3 callers)", fullCount)
	}
}

// Cancelling Store.Run while both primary and read lane are in flight exits cleanly,
// drains the read-lane goroutine before Run returns, and fails queued jobs.
func TestReadLaneShutdownAndCancellation(t *testing.T) {
	g, _ := changeDrivenWorld()
	r := &readLaneRunner{g: g}
	pollEntered, readEntered := make(chan struct{}), make(chan struct{})
	var pOnce, fOnce sync.Once
	r.onOp = func(ctx context.Context, op string, _ bool) {
		switch op {
		case "Poll":
			pOnce.Do(func() {
				close(pollEntered)
				<-ctx.Done()
			})
		case "PullRequestFull":
			fOnce.Do(func() {
				close(readEntered)
				<-ctx.Done()
			})
		}
	}
	opts := testOptions(openTestDB(t), r, nil)
	opts.MinGap = time.Millisecond
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	runCtx, cancelRun := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() { runDone <- s.Run(runCtx) }()

	<-pollEntered
	inFlightRead := make(chan error, 1)
	go func() {
		_, err := s.FullPullRequest(context.Background(), "o/r", 1, true)
		inFlightRead <- err
	}()
	<-readEntered

	queuedRead := make(chan error, 1)
	go func() {
		_, err := s.LookupRepository(context.Background(), "o", "r")
		queuedRead <- err
	}()
	waitFor(t, "queued read", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return len(s.queue) == 1
	})

	cancelRun()
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit cleanly with both lanes in flight")
	}

	if err := recv(t, queuedRead); !errors.Is(err, context.Canceled) {
		t.Errorf("queued read = %v, want context.Canceled", err)
	}
	// In-flight read must have finished before Run returned.
	if err := recv(t, inFlightRead); err == nil {
		t.Log("in-flight read finished cleanly")
	}
	s.mu.Lock()
	busy := s.readLaneBusy
	stopped := s.stopped
	s.mu.Unlock()
	if busy {
		t.Error("readLaneBusy still true after Run returned")
	}
	if !errors.Is(stopped, context.Canceled) {
		t.Errorf("stopped = %v, want context.Canceled", stopped)
	}
}

// An overlapping older poll fingerprint MUST NOT falsely mark a fresher concurrent
// read-lane FullPullRequest or PullRequest fetch stale, whereas a strictly newer poll
// fingerprint DOES still mark it stale.
func TestReadLanePollFingerprintCausality(t *testing.T) {
	t.Run("older overlapping poll does not stale fresher read-lane FullPullRequest", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, nil)
		if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
			t.Fatal(err)
		}

		// Hold Poll AFTER fakeGitHub computed the old fingerprint (before the edit).
		pollComputed, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.afterOp = func(_ context.Context, op string, data json.RawMessage, err error) (json.RawMessage, error) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollComputed)
					<-pollRelease
				})
			}
			return data, err
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollComputed

		// GitHub advances AFTER the poll computed its response; read lane fetches the new copy.
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Hour) })
		g.setBody("PR_a", "fresh from read lane")
		d, err := s.FullPullRequest(context.Background(), "o/r", 1, true)
		if err != nil {
			t.Fatal(err)
		}
		if d.Body != "fresh from read lane" {
			t.Fatalf("read-lane body = %q", d.Body)
		}

		// Now let the older Poll finish and run applyPoll / staleFullDetails.
		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()

		// Subsequent read must see the fresh read-lane copy (not stale, not refreshing, 0 fetches).
		_, _, _, opsBefore := r.stats()
		d2, err := s.FullPullRequest(context.Background(), "o/r", 1, false)
		if err != nil {
			t.Fatal(err)
		}
		if d2.Body != "fresh from read lane" || d2.Refreshing {
			t.Errorf("after older poll finished: body=%q refreshing=%v, want fresh and not refreshing", d2.Body, d2.Refreshing)
		}
		settleWorker(t, s)
		_, _, _, opsAfter := r.stats()
		if slices.Contains(opsAfter[len(opsBefore):], "PullRequestFull") {
			t.Errorf("older poll triggered needless refetch: %v", opsAfter[len(opsBefore):])
		}
	})

	t.Run("older overlapping poll does not falsely invalidate concurrent PullRequest", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, func(o *Options) { o.DetailTTL = time.Hour })
		// Move PR_a once so Poll sees a change from known and calls markMovedDetails.
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })

		pollComputed, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.afterOp = func(_ context.Context, op string, data json.RawMessage, err error) (json.RawMessage, error) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollComputed)
					<-pollRelease
				})
			}
			return data, err
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollComputed

		// GitHub advances further; read lane fetches PullRequest with the newer UpdatedAt.
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Hour) })
		d, err := s.PullRequest(context.Background(), "o/r", 1)
		if err != nil {
			t.Fatal(err)
		}

		// Older Poll finishes and runs markMovedDetails.
		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()

		// Cached PullRequest must still be served with 0 GitHub requests.
		_, _, _, opsBefore := r.stats()
		d2, err := s.PullRequest(context.Background(), "o/r", 1)
		if err != nil {
			t.Fatal(err)
		}
		if !d2.PullRequest.UpdatedAt.Equal(d.PullRequest.UpdatedAt) {
			t.Errorf("updatedAt changed: %v vs %v", d2.PullRequest.UpdatedAt, d.PullRequest.UpdatedAt)
		}
		_, _, _, opsAfter := r.stats()
		if slices.Contains(opsAfter[len(opsBefore):], "PullRequest") {
			t.Errorf("older poll falsely invalidated PullRequest cache: %v", opsAfter[len(opsBefore):])
		}
	})

	t.Run("strictly newer poll fingerprint still stales an older read-lane fetch", func(t *testing.T) {
		g, r, s, polled := newReadLaneStore(t, nil)
		if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
			t.Fatal(err)
		}

		// Hold Poll BEFORE fakeGitHub reads state, let read lane fetch first, then edit
		// GitHub so the poll actually observes a strictly newer UpdatedAt.
		pollEntered, pollRelease := make(chan struct{}), make(chan struct{})
		var holdOnce, relOnce sync.Once
		defer relOnce.Do(func() { close(pollRelease) })
		r.mu.Lock()
		r.onOp = func(_ context.Context, op string, _ bool) {
			if op == "Poll" {
				holdOnce.Do(func() {
					close(pollEntered)
					<-pollRelease
				})
			}
		}
		r.mu.Unlock()

		if err := s.Refresh(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		<-pollEntered

		// Read lane fetches current copy (v1) while Poll hasn't read GitHub yet.
		if _, err := s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
			t.Fatal(err)
		}
		// Now GitHub advances to v2 BEFORE Poll reads it.
		g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(2 * time.Hour) })
		g.setBody("PR_a", "v2 seen by poll")

		relOnce.Do(func() { close(pollRelease) })
		<-polled.C()

		// The entry MUST be marked stale because Poll saw a strictly newer UpdatedAt.
		e, ok := s.full.entry(fullKey{"o/r", 1})
		if !ok || !e.stale {
			t.Errorf("entry stale = %v (ok=%v), want true when poll saw strictly newer UpdatedAt", e.stale, ok)
		}
	})
}
