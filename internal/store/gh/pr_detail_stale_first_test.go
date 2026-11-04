package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// settleWorker waits until the worker has run everything queued before the call. It
// queues as a background job, so it lands behind the refreshes it waits for.
func settleWorker(t *testing.T, s *Store) {
	t.Helper()
	done := make(chan struct{})
	err := s.submitBackground(&job{kind: jobFunc, id: "settle", run: func(context.Context) (any, error) {
		close(done)
		return nil, nil
	}})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the worker")
	}
}

// staleWorld is a store with #1 fetched, whose GitHub can be held at the detail request.
type staleWorld struct {
	g      *fakeGitHub
	f      *fakeRunner
	s      *Store
	clk    *testClock
	events *bus.Subscription[PullRequestDetailUpdated]

	mu   sync.Mutex
	hold chan struct{} // non-nil: PullRequestFull waits for it
}

func newStaleWorld(t *testing.T, mod func(*Options)) *staleWorld {
	t.Helper()
	b := bus.New()
	g, _ := changeDrivenWorld()
	g.setBody("PR_a", "v1")
	w := &staleWorld{g: g, f: &fakeRunner{}, clk: &testClock{}, events: bus.Subscribe[PullRequestDetailUpdated](b, 64)}
	w.f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		w.mu.Lock()
		hold := w.hold
		w.mu.Unlock()
		if hold != nil && op == "PullRequestFull" {
			<-hold
		}
		return g.respond(op, doc, vars)
	})
	opts := testOptions(openTestDB(t), w.f, b)
	opts.Now = w.clk.now
	if mod != nil {
		mod(&opts)
	}
	w.s = startStore(t, opts)
	if err := w.s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, w.s, w.f)
	if _, err := w.s.FullPullRequest(context.Background(), "o/r", 1, false); err != nil {
		t.Fatal(err)
	}
	drain(w.events)
	return w
}

// holdGitHub stops detail requests until the returned func is called.
func (w *staleWorld) holdGitHub() (release func()) {
	ch := make(chan struct{})
	w.mu.Lock()
	w.hold = ch
	w.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			w.mu.Lock()
			w.hold = nil
			w.mu.Unlock()
			close(ch)
		})
	}
}

// waitForFetch waits until a request is out at GitHub (held by holdGitHub).
func (w *staleWorld) waitForFetch(t *testing.T) {
	t.Helper()
	waitFor(t, "the fetch behind the read", func() bool {
		w.f.mu.Lock()
		defer w.f.mu.Unlock()
		return w.f.inflight == 1
	})
}

func (w *staleWorld) read(t *testing.T) FullPullRequest {
	t.Helper()
	d, err := w.s.FullPullRequest(context.Background(), "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Whatever made the copy not current, a read answers with it while GitHub says nothing,
// and the fetch behind it lands as one event and a read that shows it.
func TestStaleReadAnswersWithoutWaiting(t *testing.T) {
	aged := func(w *staleWorld) { w.clk.advance(2 * time.Hour) }
	moved := func(w *staleWorld) { w.s.full.markStale(fullKey{"o/r", 1}) }
	tests := []struct {
		name  string
		stale func(*staleWorld)
		// change is what happened on GitHub meanwhile.
		change func(*fakeGitHub)
		// unchanged: the event says only the copy moved.
		unchanged bool
		want      func(FullPullRequest) bool
	}{
		{name: "aged, nothing changed", stale: aged, change: func(*fakeGitHub) {}, unchanged: true,
			want: func(d FullPullRequest) bool { return d.Body == "v1" }},
		{name: "aged, edited", stale: aged, change: func(g *fakeGitHub) { g.setBody("PR_a", "v2") },
			want: func(d FullPullRequest) bool { return d.Body == "v2" }},
		{name: "the poll saw it move", stale: moved, change: func(g *fakeGitHub) { g.setBody("PR_a", "v2") },
			want: func(d FullPullRequest) bool { return d.Body == "v2" }},
		{name: "merged meanwhile", stale: moved, change: func(g *fakeGitHub) {
			g.edit("PR_a", func(p *PullRequest) { p.State, p.MergedAt = PullRequestMerged, time.Now() })
		}, want: func(d FullPullRequest) bool { return d.PullRequest.State == PullRequestMerged }},
		{name: "closed meanwhile", stale: moved, change: func(g *fakeGitHub) {
			g.edit("PR_a", func(p *PullRequest) { p.State = PullRequestClosed })
		}, want: func(d FullPullRequest) bool { return d.PullRequest.State == PullRequestClosed }},
		{name: "force-pushed", stale: moved, change: func(g *fakeGitHub) {
			g.edit("PR_a", func(p *PullRequest) { p.HeadSHA = "forced" })
		}, want: func(d FullPullRequest) bool { return d.PullRequest.HeadSHA == "forced" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newStaleWorld(t, nil)
			before := w.read(t)
			tt.stale(w)
			tt.change(w.g)
			release := w.holdGitHub()
			defer release()

			got := w.read(t)
			if !sameFull(got, before) || !got.Refreshing || got.FetchFailed || !got.FetchedAt.Equal(before.FetchedAt) {
				t.Errorf("read while GitHub is silent: refreshing %v failed %v; want the copy as it was", got.Refreshing, got.FetchFailed)
			}
			w.waitForFetch(t)
			if n := drain(w.events); n != 0 {
				t.Errorf("%d events before the fetch landed", n)
			}
			release()
			settleWorker(t, w.s)

			var evs []PullRequestDetailUpdated
			for {
				select {
				case e := <-w.events.C():
					evs = append(evs, e)
					continue
				default:
				}
				break
			}
			if len(evs) != 1 || evs[0].Slug != "o/r" || evs[0].Number != 1 || evs[0].Unchanged != tt.unchanged {
				t.Errorf("events = %+v, want one with Unchanged %v", evs, tt.unchanged)
			}
			after := w.read(t)
			if !tt.want(after) || after.Refreshing || after.FetchFailed {
				t.Errorf("after the fetch: %+v", after)
			}
			if n := w.f.count("PullRequestFull"); n != 2 {
				t.Errorf("fetches = %d, want the one", n)
			}
		})
	}
}

// A fetch behind a read that fails leaves the copy, says so, and tries again later.
func TestStaleReadFetchFails(t *testing.T) {
	// The fake finds a pull request by number, so #1 stops resolving.
	gone := func(g *fakeGitHub) { g.edit("PR_a", func(p *PullRequest) { p.Number = 9999 }) }
	tests := []struct {
		name   string
		fail   func(*fakeGitHub)
		errHas string
	}{
		{"a server error", func(g *fakeGitHub) { g.failNext("PullRequestFull", errors.New("github graphql: boom")) }, "boom"},
		{"deleted on GitHub", gone, "Could not resolve"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newStaleWorld(t, nil)
			w.clk.advance(2 * time.Hour)
			tt.fail(w.g)
			if d := w.read(t); !d.Refreshing || d.FetchFailed || d.Body != "v1" {
				t.Fatalf("first read: %+v", d)
			}
			settleWorker(t, w.s)
			if n := drain(w.events); n != 1 {
				t.Errorf("events = %d, want the failure said once", n)
			}
			d := w.read(t)
			if d.Body != "v1" || !d.FetchFailed || d.Refreshing || !strings.Contains(d.LastError, tt.errHas) {
				t.Errorf("after the failure: body %q failed %v refreshing %v error %q", d.Body, d.FetchFailed, d.Refreshing, d.LastError)
			}
			settleWorker(t, w.s)
			if n := w.f.count("PullRequestFull"); n != 2 {
				t.Errorf("fetches = %d: the re-read the event brings tried again", n)
			}
			w.clk.advance(fullRetryAfter + time.Second)
			if d := w.read(t); !d.FetchFailed || !d.Refreshing {
				t.Errorf("past the retry wait: failed %v refreshing %v, want both", d.FetchFailed, d.Refreshing)
			}
			settleWorker(t, w.s)
			if n := w.f.count("PullRequestFull"); n != 3 {
				t.Errorf("fetches = %d, want the retry", n)
			}
		})
	}
}

// A rate-limit pause queues nothing and never turns a copy into an error.
func TestStaleReadWhilePaused(t *testing.T) {
	w := newStaleWorld(t, nil)
	w.s.full.markStale(fullKey{"o/r", 1})
	w.s.mu.Lock()
	w.s.pauseUntil = w.clk.now().Add(time.Hour)
	w.s.pauseErr = fmt.Errorf("%w: secondary", ErrRateLimited)
	w.s.mu.Unlock()
	d := w.read(t)
	if d.Body != "v1" || !d.FetchFailed || d.Refreshing || !strings.Contains(d.LastError, "paused until") {
		t.Errorf("paused: body %q failed %v refreshing %v error %q", d.Body, d.FetchFailed, d.Refreshing, d.LastError)
	}
	w.s.mu.Lock()
	queued := len(w.s.queue)
	w.s.pauseUntil = time.Time{}
	w.s.mu.Unlock()
	if queued != 0 || w.f.count("PullRequestFull") != 1 {
		t.Errorf("queued %d jobs, %d fetches, want none", queued, w.f.count("PullRequestFull"))
	}
	// The pause over, the next read is an ordinary stale read.
	if d := w.read(t); d.FetchFailed || !d.Refreshing {
		t.Errorf("after the pause: failed %v refreshing %v", d.FetchFailed, d.Refreshing)
	}
}

// Many reads of one stale copy, from two windows or a hundred, cost one request and one
// event; a read during that fetch gets the copy and adds no request.
func TestStaleReadsCoalesce(t *testing.T) {
	w := newStaleWorld(t, nil)
	w.g.setBody("PR_a", "v2")
	w.s.full.markStale(fullKey{"o/r", 1})
	release := w.holdGitHub()
	defer release()
	readMany := func() {
		var wg sync.WaitGroup
		for range 50 {
			wg.Go(func() {
				if _, err := w.s.FullPullRequest(context.Background(), "o/r", 1, false); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
	}
	readMany()
	w.waitForFetch(t)
	readMany()
	w.s.mu.Lock()
	queued := len(w.s.queue)
	w.s.mu.Unlock()
	if queued != 1 {
		t.Errorf("queued = %d behind the running fetch, want reads to share one job", queued)
	}
	release()
	settleWorker(t, w.s)
	if n := w.f.count("PullRequestFull"); n != 2 {
		t.Errorf("fetches = %d, want one for all the reads", n)
	}
	if d := w.read(t); d.Body != "v2" {
		t.Errorf("body = %q", d.Body)
	}
}

// A job someone waits for never queues behind a background refresh, and joining one
// makes it a job someone waits for.
func TestBackgroundJobsYield(t *testing.T) {
	bg := func(id string) *job { return &job{kind: jobFunc, id: id, background: true} }
	wait := func(id string) *job { return &job{kind: jobFunc, id: id} }
	ch := make(chan jobResult, 1)
	tests := []struct {
		name  string
		queue []*job
		add   *job
		ch    chan jobResult
		want  []string
	}{
		{"waited for goes before background", []*job{wait("a"), bg("b"), bg("c")}, wait("d"), ch, []string{"a", "d", "b", "c"}},
		{"background goes last", []*job{wait("a"), bg("b")}, bg("c"), nil, []string{"a", "b", "c"}},
		{"background joins a queued job", []*job{wait("a"), bg("b")}, bg("b"), nil, []string{"a", "b"}},
		{"joining a background job moves it up", []*job{wait("a"), bg("b"), bg("c")}, wait("c"), ch, []string{"a", "c", "b"}},
		{"a background job does not move a job someone waits for", []*job{wait("a"), wait("b")}, bg("a"), nil, []string{"a", "b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Store{queue: tt.queue}
			s.enqueueLocked(tt.add, tt.ch)
			var got []string
			for _, j := range s.queue {
				got = append(got, j.id)
			}
			if strings.Join(got, " ") != strings.Join(tt.want, " ") {
				t.Errorf("queue = %v, want %v", got, tt.want)
			}
		})
	}
}

// The read after this store's own write waits for the fetch, so a client that re-reads
// on the write's success shows it; a fetch that fails frees the reads after it.
func TestReadAfterWriteWaits(t *testing.T) {
	w := newStaleWorld(t, nil)
	ctx := context.Background()
	w.g.setBody("PR_a", "after the write")
	w.s.invalidateFull(fullKey{"o/r", 1})
	d := w.read(t)
	if d.Body != "after the write" || d.Refreshing {
		t.Errorf("read after the write: body %q refreshing %v", d.Body, d.Refreshing)
	}

	w.s.invalidateFull(fullKey{"o/r", 1})
	w.g.failNext("PullRequestFull", errors.New("github graphql: boom"))
	if d := w.read(t); !d.FetchFailed || d.Body != "after the write" {
		t.Errorf("failed fetch after a write: %+v", d)
	}
	release := w.holdGitHub()
	defer release()
	done := make(chan FullPullRequest, 1)
	go func() {
		d, err := w.s.FullPullRequest(ctx, "o/r", 1, false)
		if err != nil {
			t.Error(err)
		}
		done <- d
	}()
	select {
	case d := <-done:
		if !d.FetchFailed {
			t.Errorf("read after the failed fetch: %+v", d)
		}
	case <-time.After(5 * time.Second):
		t.Error("a read waited for GitHub again after the write's fetch failed")
	}
}

// The decisions keep waiting for a fetch: the stale copy a panel shows never reaches
// them, whatever a read just answered.
func TestDecisionsWaitForAFetch(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name   string
		change func(*fakeGitHub)
		decide func(*Store) error
		errHas string
	}{
		{"a merge finds the pull request merged", func(g *fakeGitHub) {
			g.edit("PR_a", func(p *PullRequest) { p.State, p.MergedAt = PullRequestMerged, time.Now() })
		}, func(s *Store) error {
			_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash})
			return err
		}, "is merged"},
		{"a merge finds another head than the copy's", func(g *fakeGitHub) {
			g.edit("PR_a", func(p *PullRequest) { p.HeadSHA = strings.Repeat("b", 40) })
		}, func(s *Store) error {
			_, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash, ExpectedHeadSHA: strings.Repeat("a", 40)})
			return err
		}, "changed since it was shown"},
		{"a revert finds it was not merged", func(*fakeGitHub) {}, func(s *Store) error {
			_, err := s.RevertPullRequest(ctx, "o/r", 1)
			return err
		}, "not merged"},
		{"marking ready finds it is no draft", func(*fakeGitHub) {}, func(s *Store) error {
			_, err := s.SetPullRequestDraft(ctx, "o/r", 1, false)
			return err
		}, "already ready for review"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newStaleWorld(t, nil)
			tt.change(w.g)
			w.s.full.markStale(fullKey{"o/r", 1})
			before := w.f.count("PullRequestFull")
			err := tt.decide(w.s)
			if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), tt.errHas) {
				t.Errorf("err = %v, want %q", err, tt.errHas)
			}
			if w.f.count("PullRequestFull") == before {
				t.Error("decided on the stale copy: no fetch")
			}
			if n := len(w.g.merges()); n != 0 {
				t.Errorf("%d merges sent", n)
			}
		})
	}
}

// The confirmation of a poll holds for as long as the poll's real cadence needs: hidden
// windows poll every 5 minutes, and a covered pull request must not fall back to the
// configured interval's age limit between two polls.
func TestConfirmationFollowsPollTier(t *testing.T) {
	tests := []struct {
		name     string
		presence Presence
		wait     time.Duration
		current  bool
	}{
		{"foreground, inside 1.5 intervals", PresenceForeground, 80 * time.Second, true},
		{"foreground, past 1.5 intervals", PresenceForeground, 95 * time.Second, false},
		{"background, between two polls", PresenceBackground, 4 * time.Minute, true},
		{"background, past 1.5 tier intervals", PresenceBackground, 8 * time.Minute, false},
		{"no GUI, between two polls", PresenceNone, 9 * time.Minute, true},
		{"no GUI, past confirmedMaxAge", PresenceNone, confirmedMaxAge + time.Second, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newStaleWorld(t, func(o *Options) {
				o.Config = func() Config { return Config{PollInterval: time.Minute, Dashboards: true} }
				o.Presence = func() Presence { return tt.presence }
			})
			pollOnce(t, w.s, w.f) // confirms #1
			w.clk.advance(tt.wait)
			if d := w.read(t); d.Refreshing == tt.current {
				t.Errorf("refreshing = %v, want current %v", d.Refreshing, tt.current)
			}
		})
	}
}

// A row of another cache version is no copy at all: the read waits for GitHub.
func TestOtherCacheVersionBlocks(t *testing.T) {
	g, _ := changeDrivenWorld()
	g.setBody("PR_a", "fetched")
	db := openTestDB(t)
	row := fmt.Sprintf(`{"v":%d,"data":{"body":"old shape","fetchedAt":"2026-10-01T00:00:00Z"}}`, cacheVersion-1)
	key := activityFull + "o/r#1"
	if _, err := db.Exec(`INSERT INTO gh_activity (key, fetched_at, payload) VALUES (?, ?, ?)`, key, time.Now().UnixMilli(), row); err != nil {
		t.Fatal(err)
	}
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(db, f, nil))
	d, err := s.FullPullRequest(context.Background(), "o/r", 1, false)
	if err != nil || d.Body != "fetched" || d.Refreshing || f.count("PullRequestFull") != 1 {
		t.Errorf("body %q refreshing %v err %v fetches %d", d.Body, d.Refreshing, err, f.count("PullRequestFull"))
	}
}

// One line per fetch splits the time on the queue from the time GitHub took.
func TestDetailFetchLogLine(t *testing.T) {
	var mu sync.Mutex
	var buf bytes.Buffer
	w := newStaleWorld(t, func(o *Options) {
		o.Log = slog.New(slog.NewTextHandler(lockedWriter{&mu, &buf}, &slog.HandlerOptions{Level: slog.LevelInfo}))
	})
	w.clk.advance(2 * time.Hour)
	w.read(t)
	settleWorker(t, w.s)
	mu.Lock()
	defer mu.Unlock()
	var lines []string
	for l := range strings.Lines(buf.String()) {
		if strings.Contains(l, "gh pull request detail fetch") {
			lines = append(lines, l)
		}
	}
	if len(lines) != 2 {
		t.Fatalf("lines = %q, want one per fetch", lines)
	}
	for i, want := range []string{"background=false", "background=true"} {
		for _, has := range []string{"level=INFO", "pr=o/r#1", "query=pull_request_full", "queue_wait=", "fetch=", want} {
			if !strings.Contains(lines[i], has) {
				t.Errorf("line %d = %q, want %q", i, lines[i], has)
			}
		}
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *bytes.Buffer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// Reads, polls, writes and evictions at once: for -race, and every read answers.
func TestStaleFirstConcurrent(t *testing.T) {
	w := newStaleWorld(t, nil)
	ctx := context.Background()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := w.s.FullPullRequest(ctx, "o/r", 1, false); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	wg.Go(func() {
		for i := range 20 {
			select {
			case <-stop:
				return
			default:
			}
			w.g.setBody("PR_a", fmt.Sprintf("v%d", i))
			if i%3 == 0 {
				w.s.invalidateFull(fullKey{"o/r", 1})
			} else {
				w.s.full.markStale(fullKey{"o/r", 1})
			}
			time.Sleep(time.Millisecond)
		}
	})
	for range 3 {
		pollOnce(t, w.s, w.f)
	}
	time.Sleep(50 * time.Millisecond)
	close(stop)
	wg.Wait()
	settleWorker(t, w.s)
}
