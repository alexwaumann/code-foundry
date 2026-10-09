package gh

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// Options configures a Store. Zero durations and counts take the Default* values.
type Options struct {
	DB DB
	// Runner talks to GitHub. Defaults to an HTTPRunner whose token comes from gh on
	// $PATH (or Homebrew).
	Runner Runner
	// Bus receives PullRequestsUpdated and ViewerUpdated. Optional.
	Bus *bus.Bus
	Log *slog.Logger

	MinGap           time.Duration
	RepoInterval     time.Duration
	ViewerInterval   time.Duration
	AuthRetry        time.Duration
	NetworkBackoff   time.Duration
	SecondaryBackoff time.Duration
	MaxBackoff       time.Duration
	DetailTTL        time.Duration
	MinRemaining     int
	PageSize         int
	MaxPages         int

	// Phase 3a activity polling (activity.go). Zero takes the default; negative
	// disables that poll.
	DashboardInterval time.Duration
	StatsInterval     time.Duration
	// BranchWatch is how long a branch stays polled after BranchPullRequests asked
	// for it.
	BranchWatch time.Duration
	// SearchAs replaces @me in the viewer searches and stats with this login (and the
	// branch filter with it). A development aid for capturing populated dashboards
	// from an account that has no pull requests; empty in normal use.
	SearchAs string

	// Now and Rand are injectable for tests.
	Now  func() time.Time
	Rand func() float64
}

func (o *Options) setDefaults() {
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&o.MinGap, DefaultMinGap)
	def(&o.RepoInterval, DefaultRepoInterval)
	def(&o.ViewerInterval, DefaultViewerInterval)
	def(&o.AuthRetry, DefaultAuthRetry)
	def(&o.NetworkBackoff, DefaultNetworkBackoff)
	def(&o.SecondaryBackoff, DefaultSecondaryBackoff)
	def(&o.MaxBackoff, DefaultMaxBackoff)
	def(&o.DetailTTL, DefaultDetailTTL)
	o.MinRemaining = cmp.Or(o.MinRemaining, DefaultMinRemaining)
	o.PageSize = cmp.Or(o.PageSize, DefaultPageSize)
	o.MaxPages = cmp.Or(o.MaxPages, DefaultMaxPages)
	def(&o.BranchWatch, DefaultBranchWatch)
	if o.DashboardInterval == 0 {
		o.DashboardInterval = DefaultDashboardInterval
	}
	if o.StatsInterval == 0 {
		o.StatsInterval = DefaultStatsInterval
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Runner == nil {
		o.Runner = NewHTTPRunner(HTTPOptions{Log: o.Log})
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Rand == nil {
		o.Rand = rand.Float64
	}
}

// Store is the GitHub store. Create with New, then call Run in its own goroutine.
type Store struct {
	opts  Options
	log   *slog.Logger
	cache cache

	snapMu sync.Mutex // serializes snapshot writers
	snap   atomic.Pointer[Snapshot]

	mu             sync.Mutex
	tracked        map[string]*schedule
	viewerNext     time.Time
	viewerFailures int
	authBad        bool
	authNext       time.Time
	authFailures   int
	pauseUntil     time.Time
	pauseErr       error
	globalFailures int
	lastResetAt    time.Time // rateLimit.resetAt of the last successful response
	queue          []*job

	// Worker goroutine only.
	lastEnd   time.Time      // when the previous request finished
	pageSizes map[string]int // per-repo PR page size after 502/504 shrinking

	act activity // Phase 3a scheduling and branch state (activity.go)

	wake chan struct{}
}

var _ Service = (*Store)(nil)

type schedule struct {
	next     time.Time
	failures int
}

type jobKind int

const (
	jobViewer jobKind = iota
	jobAuth
	jobPullRequests
	jobPullRequest
	jobChecks
	// jobActivity runs j.run (activity.go); j.ref names it for coalescing.
	jobActivity
)

type job struct {
	kind    jobKind
	slug    string
	number  int
	ref     string
	run     func(context.Context) error
	waiters []chan jobResult
}

func (j *job) key() string {
	return fmt.Sprintf("%d|%s|%d|%s", j.kind, j.slug, j.number, j.ref)
}

type jobResult struct {
	detail PullRequestDetail
	checks RefChecks
	err    error
}

// New loads the cache and returns a store. Run starts polling.
func New(ctx context.Context, opts Options) (*Store, error) {
	if opts.DB == nil {
		return nil, errors.New("gh: Options.DB is required")
	}
	opts.setDefaults()
	s := &Store{
		opts:      opts,
		log:       opts.Log,
		cache:     cache{db: opts.DB},
		tracked:   map[string]*schedule{},
		pageSizes: map[string]int{},
		wake:      make(chan struct{}, 1),
	}
	now := opts.Now()
	if err := s.cache.prune(ctx, now); err != nil {
		s.log.Warn("gh cache prune failed", "err", err)
	}
	snap, err := s.cache.loadSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	s.loadActivity(ctx, snap)
	s.snap.Store(snap)
	s.viewerNext = now
	if snap.Viewer.Viewer != nil && snap.Viewer.Viewer.ID != "" {
		s.viewerNext = laterOf(now, snap.Viewer.FetchedAt.Add(opts.ViewerInterval))
	}
	s.log.Info("gh store loaded cache", "repos", len(snap.Repos), "viewer", snap.Viewer.Viewer != nil)
	return s, nil
}

// Snapshot implements Service.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// Track implements Service. A repository whose cached list is younger than
// RepoInterval is first polled when that cache expires, not immediately.
func (s *Store) Track(slug string) error {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return err
	}
	now := s.opts.Now()
	s.mu.Lock()
	if _, ok := s.tracked[key]; ok {
		s.mu.Unlock()
		return nil
	}
	next := now
	if r, ok := s.Snapshot().Repos[key]; ok && !r.FetchedAt.IsZero() {
		next = laterOf(now, r.FetchedAt.Add(s.opts.RepoInterval))
	}
	s.tracked[key] = &schedule{next: next}
	s.mu.Unlock()

	r := s.updateRepo(key, func(r *RepoState) { r.Tracked = true })
	s.publishRepo(r)
	s.nudge()
	s.log.Info("gh tracking repo", "slug", key, "first_poll_in", next.Sub(now).Round(time.Second).String())
	return nil
}

// Untrack implements Service.
func (s *Store) Untrack(slug string) error {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return err
	}
	s.mu.Lock()
	_, ok := s.tracked[key]
	delete(s.tracked, key)
	s.mu.Unlock()
	if !ok {
		return nil
	}
	r := s.updateRepo(key, func(r *RepoState) { r.Tracked = false })
	s.publishRepo(r)
	s.log.Info("gh untracked repo", "slug", key)
	return nil
}

// Refresh implements Service.
func (s *Store) Refresh(ctx context.Context, slug string) error {
	if slug == "" {
		now := s.opts.Now()
		s.mu.Lock()
		s.viewerNext = now
		for _, sc := range s.tracked {
			sc.next = now
		}
		s.mu.Unlock()
		s.nudge()
		return nil
	}
	key, err := NormalizeSlug(slug)
	if err != nil {
		return err
	}
	return s.submit(ctx, &job{kind: jobPullRequests, slug: key}).err
}

// PullRequest implements Service.
func (s *Store) PullRequest(ctx context.Context, slug string, number int) (PullRequestDetail, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return PullRequestDetail{}, err
	}
	if number <= 0 {
		return PullRequestDetail{}, fmt.Errorf("%w: pull request number %d", ErrInvalidArgument, number)
	}
	cached, ok, err := s.cache.loadDetail(ctx, key, number)
	if err != nil {
		s.log.Warn("gh cache read failed", "err", err)
	}
	if ok && s.opts.Now().Sub(cached.FetchedAt) < s.opts.DetailTTL {
		return cached, nil
	}
	res := s.submit(ctx, &job{kind: jobPullRequest, slug: key, number: number})
	if res.err != nil {
		if ok && ctx.Err() == nil {
			cached.LastError = res.err.Error()
			return cached, nil
		}
		return PullRequestDetail{}, res.err
	}
	return res.detail, nil
}

// Checks implements Service.
func (s *Store) Checks(ctx context.Context, slug, ref string) (RefChecks, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return RefChecks{}, err
	}
	if ref == "" || len(ref) > 255 {
		return RefChecks{}, fmt.Errorf("%w: ref %q", ErrInvalidArgument, ref)
	}
	cached, ok, err := s.cache.loadChecks(ctx, key, ref)
	if err != nil {
		s.log.Warn("gh cache read failed", "err", err)
	}
	if ok && s.opts.Now().Sub(cached.FetchedAt) < s.opts.DetailTTL {
		return cached, nil
	}
	res := s.submit(ctx, &job{kind: jobChecks, slug: key, ref: ref})
	if res.err != nil {
		if ok && ctx.Err() == nil {
			cached.LastError = res.err.Error()
			return cached, nil
		}
		return RefChecks{}, res.err
	}
	return res.checks, nil
}

// submit queues an on-demand job (coalescing with an identical queued one) and waits
// for its result. While the store is paused for rate limiting or network failure it
// fails fast instead of queueing behind the pause.
func (s *Store) submit(ctx context.Context, j *job) jobResult {
	ch := make(chan jobResult, 1)
	s.mu.Lock()
	if now := s.opts.Now(); now.Before(s.pauseUntil) {
		err := fmt.Errorf("paused until %s: %w", s.pauseUntil.Format(time.TimeOnly), s.pauseErr)
		s.mu.Unlock()
		return jobResult{err: err}
	}
	queued := false
	for _, q := range s.queue {
		if q.key() == j.key() {
			q.waiters = append(q.waiters, ch)
			queued = true
			break
		}
	}
	if !queued {
		j.waiters = []chan jobResult{ch}
		s.queue = append(s.queue, j)
	}
	s.mu.Unlock()
	s.nudge()
	select {
	case r := <-ch:
		return r
	case <-ctx.Done():
		return jobResult{err: ctx.Err()}
	}
}

func (s *Store) nudge() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Run is the worker loop: the only goroutine that talks to GitHub. It returns nil when
// ctx is cancelled.
func (s *Store) Run(ctx context.Context) error {
	s.log.Info("gh poller started",
		"min_gap", s.opts.MinGap.String(), "repo_interval", s.opts.RepoInterval.String())
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		j, wait := s.next()
		if j != nil && wait <= 0 {
			s.execute(ctx, j)
			continue
		}
		var timerC <-chan time.Time
		if j != nil {
			timer.Reset(wait)
			timerC = timer.C
		}
		select {
		case <-ctx.Done():
			s.failQueued(ctx.Err())
			return nil
		case <-s.wake:
		case <-timerC:
		}
		timer.Stop()
	}
}

// next picks the next job and how long until it may start. When the wait is <= 0 the
// job has been claimed (removed from the queue). On-demand jobs come first; then the
// earliest of the viewer and tracked repos (or only the auth check while gh is not
// authenticated). Nothing starts within MinGap of the previous request's end, and
// scheduled work waits out a rate-limit or network pause.
func (s *Store) next() (*job, time.Duration) {
	now := s.opts.Now()
	earliest := s.lastEnd.Add(s.opts.MinGap)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.queue) > 0 {
		if wait := earliest.Sub(now); wait > 0 {
			return s.queue[0], wait
		}
		j := s.queue[0]
		s.queue = s.queue[1:]
		return j, 0
	}
	var j *job
	var at time.Time
	if s.authBad {
		j, at = &job{kind: jobAuth}, s.authNext
	} else {
		j, at = &job{kind: jobViewer}, s.viewerNext
		for slug, sc := range s.tracked {
			if sc.next.Before(at) || (sc.next.Equal(at) && j.kind == jobPullRequests && slug < j.slug) {
				j, at = &job{kind: jobPullRequests, slug: slug}, sc.next
			}
		}
		if aj, aat := s.nextActivityLocked(now); aj != nil && aat.Before(at) {
			j, at = aj, aat
		}
		at = laterOf(at, s.pauseUntil)
	}
	at = laterOf(at, earliest)
	return j, at.Sub(now)
}

func (s *Store) failQueued(err error) {
	s.mu.Lock()
	q := s.queue
	s.queue = nil
	s.mu.Unlock()
	for _, j := range q {
		j.reply(jobResult{err: err})
	}
}

func (j *job) reply(r jobResult) {
	for _, ch := range j.waiters {
		ch <- r // buffered, one send per channel
	}
}

func (s *Store) execute(ctx context.Context, j *job) {
	var res jobResult
	switch j.kind {
	case jobViewer:
		s.pollViewer(ctx)
	case jobAuth:
		s.checkAuth(ctx)
	case jobPullRequests:
		res.err = s.pollPullRequests(ctx, j.slug)
	case jobPullRequest:
		res.detail, res.err = s.fetchPullRequest(ctx, j.slug, j.number)
	case jobChecks:
		res.checks, res.err = s.fetchChecks(ctx, j.slug, j.ref)
	case jobActivity:
		res.err = j.run(ctx)
	}
	j.reply(res)
}

// call runs one paced GraphQL request and applies its global effects (auth state,
// rate-limit budget, pauses). It sleeps out MinGap since the previous request first.
func (s *Store) call(ctx context.Context, name string, vars map[string]any) (json.RawMessage, error) {
	q, err := query(name)
	if err != nil {
		return nil, err
	}
	if err := s.pace(ctx); err != nil {
		return nil, err
	}
	start := s.opts.Now()
	data, err := s.opts.Runner.GraphQL(ctx, q, vars)
	s.lastEnd = s.opts.Now()
	var rl *rateLimitJSON
	if err == nil {
		var env struct {
			RateLimit *rateLimitJSON `json:"rateLimit"`
		}
		if json.Unmarshal(data, &env) == nil {
			rl = env.RateLimit
		}
	}
	attrs := []any{"query", name, "vars", vars, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String()}
	if rl != nil {
		attrs = append(attrs, "cost", rl.Cost, "remaining", rl.Remaining)
	}
	if err != nil {
		attrs = append(attrs, "err", err)
	}
	s.log.Debug("gh request", attrs...)
	s.noteResult(ctx, err, rl)
	return data, err
}

// pace waits until MinGap has passed since the previous request ended.
func (s *Store) pace(ctx context.Context) error {
	wait := s.lastEnd.Add(s.opts.MinGap).Sub(s.opts.Now())
	if wait <= 0 {
		return nil
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// noteResult updates global state after a request.
func (s *Store) noteResult(ctx context.Context, err error, rl *rateLimitJSON) {
	if ctx.Err() != nil {
		return
	}
	now := s.opts.Now()
	var rle *RateLimitError
	switch {
	case err == nil:
		s.mu.Lock()
		if s.authBad { // an on-demand request succeeded while polling was paused
			s.viewerNext = now
			for _, sc := range s.tracked {
				sc.next = now
			}
		}
		s.authBad, s.authFailures, s.globalFailures = false, 0, 0
		if rl != nil {
			s.lastResetAt = rl.ResetAt
		}
		if until := budgetPause(rl, s.opts.MinRemaining, now); !until.IsZero() {
			s.pauseUntil = until
			s.pauseErr = fmt.Errorf("%w: %d of %d points left, resets at %s",
				ErrRateLimited, rl.Remaining, rl.Limit, rl.ResetAt.Local().Format(time.TimeOnly))
			s.log.Warn("gh rate-limit budget low, pausing", "remaining", rl.Remaining, "until", until)
		}
		s.mu.Unlock()
		if !s.Snapshot().Viewer.Authenticated {
			s.setAuthenticated(true, "")
		}
	case errors.Is(err, ErrNotAuthenticated):
		s.mu.Lock()
		first := !s.authBad
		s.authBad = true
		s.authFailures++
		s.authNext = now.Add(backoff(s.opts.AuthRetry, s.opts.MaxBackoff, s.authFailures, s.opts.Rand()))
		s.mu.Unlock()
		if first {
			s.log.Warn("gh is not authenticated; polling paused", "err", err)
		}
		s.setAuthenticated(false, err.Error())
	case errors.As(err, &rle):
		s.mu.Lock()
		s.globalFailures++
		until := rateLimitPause(rle, now, s.lastResetAt,
			backoff(s.opts.SecondaryBackoff, s.opts.MaxBackoff, s.globalFailures, s.opts.Rand()))
		s.pauseUntil, s.pauseErr = until, err
		s.mu.Unlock()
		s.log.Warn("gh rate limited, pausing", "err", err, "until", until)
	case errors.Is(err, ErrNetwork):
		s.mu.Lock()
		s.globalFailures++
		until := now.Add(backoff(s.opts.NetworkBackoff, s.opts.MaxBackoff, s.globalFailures, s.opts.Rand()))
		s.pauseUntil, s.pauseErr = until, err
		s.mu.Unlock()
		s.log.Warn("gh network error, pausing", "err", err, "until", until)
	}
}
