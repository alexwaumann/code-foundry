package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// opLookup is the request testJob sends: nothing else in these tests uses it.
const opLookup = "LookupRepository"

// yieldWorld is a store whose every poll stage can be stopped at a request, with a log
// of requests in the order they went out (GraphQL operations and REST paths).
type yieldWorld struct {
	g      *fakeGitHub
	f      *fakeRunner
	s      *Store
	polled *bus.Subscription[Polled]
	events *bus.Subscription[PullRequestDetailUpdated]
	logs   *bytes.Buffer
	stop   func() // cancels Run and waits for it

	mu       sync.Mutex
	sent     []string
	holdAt   string
	after    bool // hold once the answer is computed, not before
	entered  chan struct{}
	release  chan struct{}
	released sync.Once
}

func newYieldWorld(t *testing.T, mod func(*Options)) *yieldWorld {
	t.Helper()
	b := bus.New()
	g, t0 := changeDrivenWorld()
	g.addPR(fakePR("PR_w", "o/r", 9, t0)) // in no list: a watched pull request's lookup asks GitHub
	w := &yieldWorld{g: g, f: &fakeRunner{}, polled: bus.Subscribe[Polled](b, 256),
		events: bus.Subscribe[PullRequestDetailUpdated](b, 256), logs: &bytes.Buffer{}}
	w.f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		w.note(op, true)
		var data json.RawMessage
		var err error
		if op == opLookup {
			if err = g.takeFail(op); err == nil {
				data = json.RawMessage(`{"repository":null}`)
			}
		} else {
			data, err = g.respond(op, doc, vars)
		}
		w.note(op, false)
		return data, err
	})
	r := &restRunner{fakeRunner: w.f, rest: func(path string, _ map[string]string) (json.RawMessage, error) {
		w.note(path, true)
		w.note(path, false)
		return json.RawMessage(`{"total_count": 7}`), nil
	}}
	opts := testOptions(openTestDB(t), r, b)
	opts.MinGap = time.Millisecond
	opts.StatsInterval = time.Hour
	opts.HistoryInterval = time.Millisecond // the closed months ride along with every stats poll
	opts.Log = slog.New(slog.NewTextHandler(lockedWriter{&w.mu, w.logs}, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if mod != nil {
		mod(&opts)
	}
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	w.s = s
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.Run(ctx)
	}()
	w.stop = func() {
		cancel()
		w.free()
		<-done
	}
	t.Cleanup(w.stop)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, w.f)
	if opts.StatsInterval > 0 {
		// The first poll learned the viewer's id; the stats follow, then nothing is left.
		pollOnce(t, s, w.f)
		pollOnce(t, s, w.f)
	}
	drain(w.polled)
	drain(w.events)
	return w
}

// note logs a request on its way out (start) and holds it where holdGitHub asked.
func (w *yieldWorld) note(op string, start bool) {
	w.mu.Lock()
	if start {
		w.sent = append(w.sent, op)
	}
	hold := op == w.holdAt && start != w.after
	var entered, release chan struct{}
	if hold {
		w.holdAt, entered, release = "", w.entered, w.release
	}
	w.mu.Unlock()
	if hold {
		close(entered)
		<-release
	}
}

// holdGitHub stops the next request named op until free.
func (w *yieldWorld) holdGitHub(op string, after bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.holdAt, w.after = op, after
	w.entered, w.release = make(chan struct{}), make(chan struct{})
	w.released = sync.Once{}
}

func (w *yieldWorld) waitHeld(t *testing.T) {
	t.Helper()
	w.mu.Lock()
	entered := w.entered
	w.mu.Unlock()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatalf("no held request; sent %v", w.sentSince(0))
	}
}

func (w *yieldWorld) free() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.release != nil {
		w.released.Do(func() { close(w.release) })
	}
}

func (w *yieldWorld) maxInflight() int {
	w.f.mu.Lock()
	defer w.f.mu.Unlock()
	return w.f.maxInflight
}

func (w *yieldWorld) sentSince(from int) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.sent[min(from, len(w.sent)):])
}

func (w *yieldWorld) nsent() int { return len(w.sentSince(0)) }

// moveEverything makes the next poll use every stage: a pull request that moved, a
// default branch newly failing, stats due with their closed months, and a watched pull
// request whose head only GitHub knows.
func (w *yieldWorld) moveEverything(t *testing.T, n int) {
	t.Helper()
	w.g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Duration(n) * time.Minute) })
	w.g.editRepo("o/r", func(r *fakeRepo) {
		r.sha = fmt.Sprintf("m%d", n+1)
		r.rollup = CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1}
		r.failing = []CheckRun{{Name: "linux", URL: "u1", Conclusion: ConclusionFailure}}
	})
	w.s.statsDueNow("test")
	if err := w.s.WatchPullRequests([]PullRequestRef{{"o/r", 9}}); err != nil {
		t.Fatal(err)
	}
}

func (w *yieldWorld) kickPoll(t *testing.T) {
	t.Helper()
	if err := w.s.Refresh(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
}

func (w *yieldWorld) waitPolled(t *testing.T) Polled {
	t.Helper()
	select {
	case p := <-w.polled.C():
		return p
	case <-time.After(5 * time.Second):
		t.Fatalf("no Polled event; sent %v", w.sentSince(0))
		return Polled{}
	}
}

func (w *yieldWorld) queued() int {
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	return len(w.s.queue)
}

// testJob is a click: it queues id, sends one request, and returns its error.
func (w *yieldWorld) testJob(ctx context.Context, id string) error {
	_, err := submitFunc(ctx, w.s, id, func(ctx context.Context) (int, error) {
		_, err := w.s.call(ctx, queryLookupRepository, map[string]any{"owner": "o", "name": id})
		return 0, err
	})
	return err
}

// goJob starts testJob and returns where its error will land, once it is queued.
func (w *yieldWorld) goJob(t *testing.T, ctx context.Context, id string) <-chan error {
	t.Helper()
	before := w.queued()
	out := make(chan error, 1)
	go func() { out <- w.testJob(ctx, id) }()
	waitFor(t, "the job in the queue", func() bool { return w.queued() > before })
	return out
}

func recv(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("no answer")
		return nil
	}
}

// A click during any request of a poll runs right after that request, and the poll then
// carries on and ends as usual.
func TestClickDuringEveryStageOfAPoll(t *testing.T) {
	stages := []string{"PullRequest", "Poll", "PullRequestDetails", "DefaultBranchChecks", "PollStats", "search/commits", "PollProjects"}
	for _, stage := range stages {
		t.Run(stage, func(t *testing.T) {
			w := newYieldWorld(t, nil)
			w.moveEverything(t, 1)
			from := w.nsent()
			w.holdGitHub(stage, false)
			w.kickPoll(t)
			w.waitHeld(t)
			click := make(chan error, 1)
			go func() {
				_, err := w.s.FullPullRequest(context.Background(), "o/r", 1, true)
				click <- err
			}()
			waitFor(t, "the click in the queue", func() bool { return w.queued() == 1 })
			w.free()
			if err := recv(t, click); err != nil {
				t.Fatal(err)
			}
			w.waitPolled(t)
			sent := w.sentSince(from)
			at := slices.Index(sent, stage)
			if at < 0 || at+1 >= len(sent) || sent[at+1] != "PullRequestFull" {
				t.Errorf("sent %v, want PullRequestFull right after %s", sent, stage)
			}
			if n := w.count(sent, "PullRequestFull"); n != 1 {
				t.Errorf("sent %v, want one PullRequestFull", sent)
			}
			for _, op := range stages {
				if !slices.Contains(sent, op) {
					t.Errorf("sent %v: the poll skipped %s", sent, op)
				}
			}
			if n := w.maxInflight(); n != 1 {
				t.Errorf("max in flight = %d", n)
			}
		})
	}
}

func (w *yieldWorld) count(sent []string, op string) int {
	n := 0
	for _, s := range sent {
		if s == op {
			n++
		}
	}
	return n
}

// A click that comes while the poll sits out its gap goes before the poll's next
// request, at the short gap, and the poll pays the full gap after it.
func TestClickDuringThePollsGap(t *testing.T) {
	const minGap, userGap = 400 * time.Millisecond, 40 * time.Millisecond
	w := newYieldWorld(t, func(o *Options) {
		o.MinGap, o.UserGap, o.StatsInterval = minGap, userGap, -1
	})
	w.g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Minute) })
	calls := w.f.ncalls()
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	w.free()
	waitFor(t, "the poll's request to end", func() bool { return w.f.ncalls() > calls })
	if err := w.testJob(context.Background(), "click"); err != nil {
		t.Fatal(err)
	}
	w.waitPolled(t)
	got, _ := w.f.snapshot()
	got = got[calls:]
	if len(got) < 3 || got[0].op != "Poll" || got[1].op != opLookup || got[2].op != "PullRequestDetails" {
		t.Fatalf("calls %v, want Poll, the click, PullRequestDetails", ops(got))
	}
	if gap := got[1].start.Sub(got[0].end); gap < userGap {
		t.Errorf("click %v after the poll's request, want >= %v", gap, userGap)
	}
	if gap := got[2].start.Sub(got[1].end); gap < minGap {
		t.Errorf("poll resumed %v after the click, want >= %v", gap, minGap)
	}
}

func ops(calls []fakeCall) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.op
	}
	return out
}

// A burst runs in order, a bounded number of jobs between two poll requests, and
// identical clicks share a request.
func TestBurstOfClicksDuringAPoll(t *testing.T) {
	tests := []struct {
		name     string
		ids      func(i int) string
		requests int
	}{
		{"50 different", func(i int) string { return fmt.Sprintf("j%02d", i) }, 50},
		{"50 the same", func(int) string { return "same" }, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newYieldWorld(t, nil)
			w.moveEverything(t, 1)
			from := w.nsent()
			calls := w.f.ncalls()
			w.holdGitHub("Poll", false)
			w.kickPoll(t)
			w.waitHeld(t)
			var answers []<-chan error
			for i := range 50 {
				ch := make(chan error, 1)
				id := tt.ids(i)
				go func() { ch <- w.testJob(context.Background(), id) }()
				answers = append(answers, ch)
				waitFor(t, "the click in the queue", func() bool {
					w.s.mu.Lock()
					defer w.s.mu.Unlock()
					n := 0
					for _, j := range w.s.queue {
						n += len(j.waiters)
					}
					return n == i+1
				})
			}
			w.free()
			for _, ch := range answers {
				if err := recv(t, ch); err != nil {
					t.Fatal(err)
				}
			}
			w.waitPolled(t)
			sent := w.sentSince(from)
			if n := w.count(sent, opLookup); n != tt.requests {
				t.Errorf("%d requests, want %d", n, tt.requests)
			}
			run := 0
			for _, op := range sent {
				if op != opLookup {
					run = 0
					continue
				}
				if run++; run > maxJobsAhead {
					t.Fatalf("more than %d jobs in a row ahead of the poll: %v", maxJobsAhead, sent)
				}
			}
			got, _ := w.f.snapshot()
			var names []string
			for _, c := range got[calls:] {
				if c.op == opLookup {
					names = append(names, c.vars["name"].(string))
				}
			}
			if !slices.IsSorted(names) {
				t.Errorf("clicks ran out of order: %v", names)
			}
			if n := w.maxInflight(); n != 1 {
				t.Errorf("max in flight = %d", n)
			}
		})
	}
}

// A steady stream of jobs cannot stop polls: not their start, not their middle.
func TestStreamOfJobsDoesNotStarveThePoll(t *testing.T) {
	tests := []struct {
		name    string
		midPoll bool
	}{{"before the poll starts", false}, {"once the poll is running", true}}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newYieldWorld(t, nil)
			w.moveEverything(t, 1)
			if tt.midPoll {
				w.holdGitHub("Poll", false)
				w.kickPoll(t)
				w.waitHeld(t)
			}
			ctx, cancel := context.WithCancel(context.Background())
			var wg sync.WaitGroup
			var ran atomic.Int64
			for g := range 4 {
				wg.Go(func() {
					for i := 0; ctx.Err() == nil; i++ {
						if w.testJob(ctx, fmt.Sprintf("g%d-%d", g, i)) == nil {
							ran.Add(1)
						}
					}
				})
			}
			defer wg.Wait()
			defer cancel()
			waitFor(t, "the stream to run", func() bool { return tt.midPoll || ran.Load() > 20 })
			if tt.midPoll {
				w.free()
			} else {
				w.kickPoll(t)
			}
			w.waitPolled(t)
			if tt.midPoll {
				waitFor(t, "jobs during the poll", func() bool { return ran.Load() > 0 })
			}
		})
	}
}

// Shutdown in the middle of a poll: the poll stops at its next request, the queued job
// fails without being sent, and Run returns.
func TestPollCancelledWithAJobQueued(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.moveEverything(t, 1)
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	click := w.goJob(t, context.Background(), "click")
	n := w.nsent()
	w.stop()
	if err := recv(t, click); !errors.Is(err, context.Canceled) {
		t.Errorf("click: %v", err)
	}
	if sent := w.sentSince(n); len(sent) != 0 {
		t.Errorf("sent %v after the shutdown", sent)
	}
}

// Shutdown while a yield runs: the job in flight ends, the next one is not started, the
// poll does not resume, and a job submitted after Run ended fails at once.
func TestShutdownWhileYielding(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.moveEverything(t, 1)
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	first := w.goJob(t, context.Background(), "first")
	second := w.goJob(t, context.Background(), "second")
	w.mu.Lock()
	poll := w.release
	w.mu.Unlock()
	w.holdGitHub(opLookup, false) // first stops here once the poll's request is let go
	close(poll)
	w.waitHeld(t)
	n := w.nsent()
	w.stop()
	if err := recv(t, first); err != nil {
		t.Errorf("first was in flight and got its answer: %v", err)
	}
	if err := recv(t, second); !errors.Is(err, context.Canceled) {
		t.Errorf("second: %v", err)
	}
	if sent := w.sentSince(n); len(sent) != 0 {
		t.Errorf("sent %v after the shutdown", sent)
	}
	done := make(chan error, 1)
	go func() { done <- w.testJob(context.Background(), "late") }()
	if err := recv(t, done); !errors.Is(err, context.Canceled) {
		t.Errorf("after Run: %v", err)
	}
	if err := w.s.submitBackground(&job{kind: jobFunc, id: "late-bg"}); !errors.Is(err, context.Canceled) {
		t.Errorf("background after Run: %v", err)
	}
}

// A caller that leaves takes its place in the queue with it. A job someone else waits
// for, or one a client was promised, still runs; a job already running finishes.
func TestCallerLeaves(t *testing.T) {
	lookup := func(w *yieldWorld) *job {
		return &job{kind: jobFunc, id: "shared", run: func(ctx context.Context) (any, error) {
			_, err := w.s.call(ctx, queryLookupRepository, map[string]any{"owner": "o", "name": "shared"})
			return 0, err
		}}
	}
	tests := []struct {
		name string
		// setup queues the leaving caller's job behind a held poll.
		setup    func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error
		wantSent int
		check    func(t *testing.T, w *yieldWorld)
	}{
		{name: "only waiter: dropped", wantSent: 0, setup: func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error {
			return w.goJob(t, leaving, "gone")
		}},
		{name: "already gone: never queued", wantSent: 0, setup: func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := w.testJob(ctx, "gone"); !errors.Is(err, context.Canceled) {
				t.Errorf("dead context: %v", err)
			}
			if n := w.queued(); n != 0 {
				t.Errorf("queued %d", n)
			}
			return w.goJob(t, leaving, "gone")
		}},
		{name: "another live waiter: runs", wantSent: 1, setup: func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error {
			out := w.goJob(t, leaving, "shared")
			live := make(chan error, 1)
			go func() { live <- w.testJob(context.Background(), "shared") }()
			waitFor(t, "the second waiter", func() bool {
				w.s.mu.Lock()
				defer w.s.mu.Unlock()
				return len(w.s.queue) == 1 && len(w.s.queue[0].waiters) == 2
			})
			t.Cleanup(func() {
				if err := recv(t, live); err != nil {
					t.Errorf("the live waiter: %v", err)
				}
			})
			return out
		}},
		{name: "joined a background job: stays, behind the waited ones", wantSent: 1, setup: func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error {
			if err := w.s.submitBackground(lookup(w)); err != nil {
				t.Fatal(err)
			}
			out := make(chan error, 1)
			go func() { out <- w.testJob(leaving, "shared") }()
			waitFor(t, "the waiter", func() bool {
				w.s.mu.Lock()
				defer w.s.mu.Unlock()
				return !w.s.queue[0].background
			})
			return out
		}, check: func(t *testing.T, w *yieldWorld) {
			w.s.mu.Lock()
			defer w.s.mu.Unlock()
			if len(w.s.queue) != 1 || !w.s.queue[0].background {
				t.Errorf("the job did not go back to the background class")
			}
		}},
		{name: "background job joined a waited one: runs", wantSent: 1, setup: func(t *testing.T, w *yieldWorld, leaving context.Context) <-chan error {
			out := w.goJob(t, leaving, "shared")
			if err := w.s.submitBackground(lookup(w)); err != nil {
				t.Fatal(err)
			}
			return out
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newYieldWorld(t, nil)
			from := w.nsent()
			w.holdGitHub("Poll", false)
			w.kickPoll(t)
			w.waitHeld(t)
			leaving, cancel := context.WithCancel(context.Background())
			defer cancel()
			gone := tt.setup(t, w, leaving)
			cancel()
			if err := recv(t, gone); !errors.Is(err, context.Canceled) {
				t.Errorf("leaving caller: %v", err)
			}
			if tt.check != nil {
				tt.check(t, w)
			}
			w.free()
			w.waitPolled(t)
			settleWorker(t, w.s)
			if n := w.count(w.sentSince(from), opLookup); n != tt.wantSent {
				t.Errorf("%d requests, want %d", n, tt.wantSent)
			}
		})
	}
}

// A caller leaving while its job runs gets its answer at once, and the job finishes:
// its result lands in the cache for the next reader.
func TestCallerLeavesWhileRunning(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.holdGitHub("PullRequestFull", false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := make(chan error, 1)
	go func() {
		_, err := w.s.FullPullRequest(ctx, "o/r", 1, true)
		out <- err
	}()
	w.waitHeld(t)
	cancel()
	if err := recv(t, out); !errors.Is(err, context.Canceled) {
		t.Errorf("caller: %v", err)
	}
	from := w.nsent()
	w.free()
	settleWorker(t, w.s)
	d, err := w.s.FullPullRequest(context.Background(), "o/r", 1, false)
	if err != nil || d.FetchedAt.IsZero() || d.Refreshing {
		t.Errorf("after the fetch: %+v, %v", d.FetchedAt, err)
	}
	if sent := w.sentSince(from); len(sent) != 0 {
		t.Errorf("sent %v, want the running fetch to serve the next read", sent)
	}
}

// What a click fetched is newer than the fingerprint of the poll around it: the stale
// pass of that fingerprint comes before the click, never after.
func TestPollDoesNotStaleWhatAClickFetched(t *testing.T) {
	w := newYieldWorld(t, nil)
	if _, err := w.s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	// The poll's answer is computed, then GitHub moves, then the click reads the new copy.
	w.holdGitHub("Poll", true)
	w.kickPoll(t)
	w.waitHeld(t)
	w.g.edit("PR_a", func(p *PullRequest) { p.UpdatedAt = p.UpdatedAt.Add(time.Hour) })
	w.g.setBody("PR_a", "newer than the fingerprint")
	click := make(chan error, 1)
	go func() {
		_, err := w.s.FullPullRequest(context.Background(), "o/r", 1, true)
		click <- err
	}()
	waitFor(t, "the click in the queue", func() bool { return w.queued() == 1 })
	w.free()
	if err := recv(t, click); err != nil {
		t.Fatal(err)
	}
	w.waitPolled(t)
	from := w.nsent()
	d, err := w.s.FullPullRequest(context.Background(), "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Body != "newer than the fingerprint" || d.Refreshing {
		t.Errorf("after the poll: body %q refreshing %v", d.Body, d.Refreshing)
	}
	settleWorker(t, w.s)
	if sent := w.sentSince(from); slices.Contains(sent, "PullRequestFull") {
		t.Errorf("sent %v: the older fingerprint sent the click's copy back for a fetch", sent)
	}
}

// A write in a yield comes after what the poll already asked GitHub: the publish keeps
// the merge shown, and the poll it asked for still happens.
func TestWriteInAYieldSurvivesThePublish(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.moveEverything(t, 1)
	w.holdGitHub("PullRequestDetails", false)
	w.kickPoll(t)
	w.waitHeld(t)
	k := fullKey{"o/r", 1}
	write := make(chan error, 1)
	go func() {
		_, err := submitFunc(context.Background(), w.s, "write", func(context.Context) (int, error) {
			w.s.markMerged(k)
			w.s.pollSoon()
			return 0, nil
		})
		write <- err
	}()
	waitFor(t, "the write in the queue", func() bool { return w.queued() == 1 })
	polls := w.f.count("Poll")
	w.free()
	if err := recv(t, write); err != nil {
		t.Fatal(err)
	}
	w.waitPolled(t)
	d := w.s.Snapshot().Dashboard
	if slices.ContainsFunc(d.Authored, func(p PullRequest) bool { return p.Number == 1 }) ||
		!slices.ContainsFunc(d.RecentlyMerged, func(p PullRequest) bool { return p.Number == 1 }) {
		t.Errorf("after the publish: authored %v, merged %v", d.Authored, d.RecentlyMerged)
	}
	w.waitPolled(t) // the poll the write asked for
	if n := w.f.count("Poll"); n <= polls {
		t.Errorf("%d polls after the write, was %d", n, polls)
	}
}

// A pause means nothing goes out, whoever set it: the poll's remaining requests and the
// jobs queued behind it are refused without a request, with the pause's error.
func TestPauseStopsThePollAndTheQueue(t *testing.T) {
	tests := []struct {
		name  string
		limit string // this request is answered with a secondary rate limit; nothing follows it
		jobs  bool
	}{
		{"a job in a yield", opLookup, true},
		{"the poll's details", "PullRequestDetails", false},
		{"the poll's failing checks", "DefaultBranchChecks", false},
		{"the closed months", "PollStats", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newYieldWorld(t, func(o *Options) { o.SecondaryBackoff, o.MaxBackoff = time.Hour, time.Hour })
			w.moveEverything(t, 1)
			from := w.nsent()
			w.g.failNext(tt.limit, &RateLimitError{Secondary: true, Msg: "slow down"})
			w.holdGitHub("Poll", false)
			w.kickPoll(t)
			w.waitHeld(t)
			var first, second <-chan error
			if tt.jobs {
				first = w.goJob(t, context.Background(), "first")
				second = w.goJob(t, context.Background(), "second")
			}
			w.free()
			if tt.jobs {
				if err := recv(t, first); !errors.Is(err, ErrRateLimited) {
					t.Errorf("first: %v", err)
				}
				if err := recv(t, second); !errors.Is(err, ErrRateLimited) || !strings.Contains(err.Error(), "paused until") {
					t.Errorf("second: %v", err)
				}
			}
			w.waitPolled(t)
			settleWorkerPaused(t, w)
			sent := w.sentSince(from)
			if at := slices.Index(sent, tt.limit); at < 0 || at != len(sent)-1 {
				t.Errorf("sent %v, want nothing after %s", sent, tt.limit)
			}
		})
	}
}

// settleWorkerPaused waits for the worker to go idle: submitBackground refuses during a
// pause, so it looks at the queue instead.
func settleWorkerPaused(t *testing.T, w *yieldWorld) {
	t.Helper()
	waitFor(t, "an empty queue", func() bool { return w.queued() == 0 })
	w.f.mu.Lock()
	defer w.f.mu.Unlock()
	if w.f.inflight != 0 {
		t.Errorf("%d in flight", w.f.inflight)
	}
}

// A refresh queued when a pause starts ends like a failed fetch: refused without a
// request, and the client told Refreshing hears the end.
func TestBackgroundRefreshRefusedByAPause(t *testing.T) {
	w := newYieldWorld(t, func(o *Options) { o.SecondaryBackoff, o.MaxBackoff = time.Hour, time.Hour })
	if _, err := w.s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	drain(w.events)
	w.g.failNext("Poll", &RateLimitError{Secondary: true, Msg: "slow down"})
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	from := w.nsent()
	if err := w.s.refreshFull(fullKey{"o/r", 1}); err != nil {
		t.Fatal(err)
	}
	w.free()
	select {
	case e := <-w.events.C():
		if !e.Unchanged {
			t.Errorf("event = %+v", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no event for the refused refresh")
	}
	if sent := w.sentSince(from); len(sent) != 0 {
		t.Errorf("sent %v during the pause", sent)
	}
}

// A refresh that joins a queued read is promised to a client, so it announces its end
// even when nothing changed, and even when the read's caller left.
func TestRefreshJoiningAReadStillAnnounces(t *testing.T) {
	w := newYieldWorld(t, nil)
	if _, err := w.s.FullPullRequest(context.Background(), "o/r", 1, true); err != nil {
		t.Fatal(err)
	}
	drain(w.events)
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	read := make(chan error, 1)
	go func() {
		_, err := w.s.FullPullRequest(ctx, "o/r", 1, true)
		read <- err
	}()
	waitFor(t, "the read in the queue", func() bool { return w.queued() == 1 })
	if err := w.s.refreshFull(fullKey{"o/r", 1}); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := recv(t, read); !errors.Is(err, context.Canceled) {
		t.Fatalf("read: %v", err)
	}
	if n := w.queued(); n != 1 {
		t.Fatalf("queued %d, want the refresh", n)
	}
	w.free()
	select {
	case e := <-w.events.C():
		if !e.Unchanged {
			t.Errorf("event = %+v", e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no event for the refresh")
	}
}

// A queued poll waits for the one running, whoever waits for it, and background jobs
// wait too: only jobs someone waits for go into a yield.
func TestYieldTakesOnlyWaitedJobs(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	from := w.nsent()
	ran := make(chan struct{})
	if err := w.s.submitBackground(&job{kind: jobFunc, id: "bg", run: func(context.Context) (any, error) {
		close(ran)
		return nil, nil
	}}); err != nil {
		t.Fatal(err)
	}
	refresh := make(chan error, 1)
	go func() { refresh <- w.s.Refresh(context.Background(), "o/any") }()
	waitFor(t, "the poll in the queue", func() bool { return w.queued() == 2 })
	w.free()
	w.waitPolled(t)
	if err := recv(t, refresh); err != nil {
		t.Fatal(err)
	}
	<-ran
	sent := w.sentSince(from)
	if n := w.count(sent, "Poll"); n != 1 {
		t.Errorf("sent %v, want the queued poll once", sent)
	}
	if n := w.maxInflight(); n != 1 {
		t.Errorf("max in flight = %d", n)
	}
}

// The poll's own numbers stay its own, and the yield shows in its log line.
func TestYieldInThePollLogLine(t *testing.T) {
	w := newYieldWorld(t, nil)
	w.holdGitHub("Poll", false)
	w.kickPoll(t)
	w.waitHeld(t)
	click := w.goJob(t, context.Background(), "click")
	w.free()
	if err := recv(t, click); err != nil {
		t.Fatal(err)
	}
	w.waitPolled(t)
	settleWorker(t, w.s)
	w.mu.Lock()
	logs := w.logs.String()
	w.mu.Unlock()
	lines := strings.Split(logs, "\n")
	i := slices.IndexFunc(lines, func(l string) bool { return strings.Contains(l, "yields=1") })
	if i < 0 {
		t.Fatalf("no poll line with yields=1")
	}
	if !strings.Contains(lines[i], "msg=\"gh poll\"") || !strings.Contains(lines[i], "requests=2") {
		t.Errorf("line = %s, want the poll and projects requests and not the click", lines[i])
	}
}

func TestAdmitGap(t *testing.T) {
	const minGap, userGap = 400 * time.Millisecond, time.Millisecond
	tests := []struct {
		name      string
		forUser   bool
		scheduled bool
		read      bool
		empty     bool          // the allowance is spent
		since     time.Duration // the previous request ended this long ago
		wantShort bool
		wantSpent bool
	}{
		{name: "read someone waits for", forUser: true, read: true, wantShort: true, wantSpent: true},
		{name: "write someone waits for", forUser: true},
		{name: "background read", read: true},
		{name: "the poll's read", scheduled: true, read: true},
		{name: "allowance spent", forUser: true, read: true, empty: true},
		{name: "gap already over spends nothing", forUser: true, read: true, since: time.Hour, wantShort: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			now := time.Now()
			s := &Store{opts: Options{MinGap: minGap, UserGap: userGap, Now: time.Now}, wake: make(chan struct{}, 1)}
			s.forUser, s.scheduled = tt.forUser, tt.scheduled
			s.lastEnd = now.Add(-tt.since)
			if tt.empty {
				s.allowance.exhaust(now)
			}
			owed := s.allowance.owed
			if err := s.admit(context.Background(), tt.read); err != nil {
				t.Fatal(err)
			}
			took := time.Since(now)
			if tt.wantShort && took >= minGap {
				t.Errorf("waited %v, want under %v", took, minGap)
			}
			if !tt.wantShort && took < minGap {
				t.Errorf("waited %v, want %v", took, minGap)
			}
			if spent := !s.allowance.owed.Equal(owed); spent != tt.wantSpent {
				t.Errorf("spent = %v, want %v", spent, tt.wantSpent)
			}
		})
	}
}

func TestGapAllowance(t *testing.T) {
	t0 := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	var a gapAllowance
	for i := range userGapBurst {
		if !a.left(t0) {
			t.Fatalf("spent after %d, want %d", i, userGapBurst)
		}
		a.spend(t0)
	}
	if a.left(t0) {
		t.Fatal("left after the burst")
	}
	if a.left(t0.Add(userGapRefill - time.Nanosecond)) {
		t.Error("back before one refill")
	}
	if !a.left(t0.Add(userGapRefill)) {
		t.Error("not back after one refill")
	}
	// A long quiet stretch fills it to the burst and no further.
	later := t0.Add(24 * time.Hour)
	n := 0
	for a.left(later) {
		a.spend(later)
		n++
	}
	if n != userGapBurst {
		t.Errorf("%d short gaps after a long wait, want %d", n, userGapBurst)
	}
	var b gapAllowance
	b.exhaust(t0)
	if b.left(t0) || b.left(t0.Add(userGapRefill-time.Nanosecond)) {
		t.Error("left after exhaust")
	}
	if !b.left(t0.Add(userGapRefill)) {
		t.Error("exhausted forever")
	}
}

// A rate limit ends the short gaps.
func TestRateLimitExhaustsTheAllowance(t *testing.T) {
	w := newYieldWorld(t, func(o *Options) { o.SecondaryBackoff, o.MaxBackoff = 20*time.Millisecond, 20*time.Millisecond })
	w.g.failNext(opLookup, &RateLimitError{Secondary: true, Msg: "slow down"})
	if err := w.testJob(context.Background(), "limited"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("job: %v", err)
	}
	left := make(chan bool, 1) // read on the worker, whose field it is
	waitFor(t, "the pause to end", func() bool {
		return w.s.submitBackground(&job{kind: jobFunc, id: "look", run: func(context.Context) (any, error) {
			left <- w.s.allowance.left(time.Now())
			return nil, nil
		}}) == nil
	})
	if <-left {
		t.Error("the allowance outlived a rate limit")
	}
}

func TestIsMutation(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{queryMergePullRequest, true},
		{queryRevertPullRequest, true},
		{queryPullRequestFull, false},
		{queryLookupRepository, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc, err := query(tt.name)
			if err != nil {
				t.Fatal(err)
			}
			if got := isMutation(doc); got != tt.want {
				t.Errorf("isMutation = %v", got)
			}
		})
	}
}

// Everything at once, for the race detector: polls back to back, clicks that stay and
// clicks that leave, and background refreshes. One request in flight, nobody left hanging.
func TestQueueUnderLoad(t *testing.T) {
	w := newYieldWorld(t, func(o *Options) { o.PollInterval = time.Millisecond })
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			for i := range 40 {
				patience := time.Minute
				if i%3 == 0 {
					patience = time.Duration(i%5) * time.Millisecond
				}
				ctx, cancel := context.WithTimeout(context.Background(), patience)
				switch i % 4 {
				case 0:
					_ = w.s.refreshFull(fullKey{"o/r", 1})
				case 1:
					_, _ = w.s.FullPullRequest(ctx, "o/r", 1, true)
				default:
					_ = w.testJob(ctx, fmt.Sprintf("j%d", (g+i)%7))
				}
				cancel()
			}
		})
	}
	wg.Wait()
	settleWorker(t, w.s)
	if n := w.maxInflight(); n != 1 {
		t.Errorf("max in flight = %d", n)
	}
}
