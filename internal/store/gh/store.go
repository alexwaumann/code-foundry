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
	// Bus receives the store's events (gh.go, activity.go). Optional.
	Bus *bus.Bus
	Log *slog.Logger

	MinGap time.Duration
	// PollInterval is the default for Config().PollInterval.
	PollInterval time.Duration
	// IdleInterval is the poll cadence while nothing is tracked or watched.
	IdleInterval     time.Duration
	AuthRetry        time.Duration
	NetworkBackoff   time.Duration
	SecondaryBackoff time.Duration
	MaxBackoff       time.Duration
	DetailTTL        time.Duration
	MinRemaining     int
	// MaxPages caps the pages of checks (100 each) fetched for one commit.
	MaxPages int
	// DetailBatch is how many open pull requests one detail request carries.
	DetailBatch int

	// StatsInterval is how often the monthly stats ride along with the poll. Negative
	// disables them.
	StatsInterval time.Duration
	// BranchWatch is how long a branch stays in the poll after BranchPullRequests
	// asked for it.
	BranchWatch time.Duration
	// SearchAs replaces @me in the viewer searches and stats with this login (and the
	// branch filter with it). A development aid for capturing populated dashboards
	// from an account that has no pull requests; empty in normal use.
	SearchAs string

	// Config returns the user settings the poll follows. It is read before every poll,
	// so changes apply from the next one. Nil means PollInterval with dashboards on.
	Config func() Config

	// Now and Rand are injectable for tests.
	Now  func() time.Time
	Rand func() float64
}

// Config is the user-tunable part of the poll (github.* settings).
type Config struct {
	// PollInterval is the time between the end of one poll and the start of the next.
	// Zero takes Options.PollInterval.
	PollInterval time.Duration
	// Dashboards includes the viewer's pull request searches in the poll.
	Dashboards bool
}

func (o *Options) setDefaults() {
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&o.MinGap, DefaultMinGap)
	def(&o.PollInterval, DefaultPollInterval)
	def(&o.IdleInterval, DefaultIdleInterval)
	def(&o.AuthRetry, DefaultAuthRetry)
	def(&o.NetworkBackoff, DefaultNetworkBackoff)
	def(&o.SecondaryBackoff, DefaultSecondaryBackoff)
	def(&o.MaxBackoff, DefaultMaxBackoff)
	def(&o.DetailTTL, DefaultDetailTTL)
	o.MinRemaining = cmp.Or(o.MinRemaining, DefaultMinRemaining)
	o.MaxPages = cmp.Or(o.MaxPages, DefaultMaxPages)
	o.DetailBatch = cmp.Or(o.DetailBatch, DefaultDetailBatch)
	def(&o.BranchWatch, DefaultBranchWatch)
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
	tracked        map[string]bool
	watches        branchWatches
	pollNext       time.Time
	pollAgain      bool // a poll was asked for while one was running
	pollFailures   int
	statsNext      time.Time
	statsFailures  int
	authBad        bool
	authNext       time.Time
	authFailures   int
	pauseUntil     time.Time
	pauseErr       error
	globalFailures int
	lastResetAt    time.Time // rateLimit.resetAt of the last successful response
	queue          []*job

	branches branchStates // per-branch results (activity.go)
	full     fullCache    // pull request detail panel cache (pr_detail.go)
	owners   ownersCache  // publish owners (owners.go)

	// Worker goroutine only.
	lastEnd     time.Time      // when the previous request finished
	searchFirst map[string]int // per-section search size after 502/504 shrinking
	detailBatch int            // open PRs per detail request after 502/504 shrinking
	recheck     map[string]int // PR id -> detail refetches left while mergeable is UNKNOWN
	failingKey  map[string]string
	searchAsID  string // node id of Options.SearchAs
	cycle       cycleStats

	wake chan struct{}
}

var _ Service = (*Store)(nil)

type jobKind int

const (
	jobPoll jobKind = iota
	jobAuth
	jobPullRequest
	jobChecks
	// jobFunc runs job.run; job.id identifies it for coalescing (pr_detail.go).
	jobFunc
)

type job struct {
	kind   jobKind
	slug   string
	number int
	ref    string
	// id and run: jobFunc only.
	id      string
	run     func(context.Context) (any, error)
	waiters []chan jobResult
}

func (j *job) key() string {
	if j.kind == jobFunc {
		return fmt.Sprintf("%d|%s", j.kind, j.id)
	}
	return fmt.Sprintf("%d|%s|%d|%s", j.kind, j.slug, j.number, j.ref)
}

type jobResult struct {
	detail PullRequestDetail
	checks RefChecks
	value  any // jobFunc
	err    error
}

// New loads the cache and returns a store. Run starts polling.
func New(ctx context.Context, opts Options) (*Store, error) {
	if opts.DB == nil {
		return nil, errors.New("gh: Options.DB is required")
	}
	opts.setDefaults()
	s := &Store{
		opts:        opts,
		log:         opts.Log,
		cache:       cache{db: opts.DB},
		tracked:     map[string]bool{},
		watches:     branchWatches{},
		branches:    branchStates{m: map[branchKey]BranchPullRequests{}},
		searchFirst: map[string]int{},
		detailBatch: opts.DetailBatch,
		recheck:     map[string]int{},
		failingKey:  map[string]string{},
		wake:        make(chan struct{}, 1),
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
	s.loadOwners(ctx)
	s.snap.Store(snap)
	// A recent poll in the cache (with the viewer's id, which stats need) waits out its
	// interval, so restarts do not poll in a burst.
	s.pollNext = now
	if v := snap.Viewer.Viewer; v != nil && v.ID != "" && !snap.Poll.FetchedAt.IsZero() {
		s.pollNext = laterOf(now, snap.Poll.FetchedAt.Add(s.config().PollInterval))
	}
	for slug, r := range snap.Repos {
		s.failingKey[slug] = failingKeyOf(r.Activity.DefaultBranch)
	}
	s.log.Info("gh store loaded cache", "repos", len(snap.Repos), "viewer", snap.Viewer.Viewer != nil,
		"first_poll_in", s.pollNext.Sub(now).Round(time.Second).String())
	return s, nil
}

// config returns the current Config with defaults applied.
func (s *Store) config() Config {
	c := Config{PollInterval: s.opts.PollInterval, Dashboards: true}
	if s.opts.Config != nil {
		c = s.opts.Config()
	}
	if c.PollInterval <= 0 {
		c.PollInterval = s.opts.PollInterval
	}
	return c
}

// pollDebounce lets a burst of Track/BranchPullRequests calls (daemon start, a client
// opening several views) share one poll.
const pollDebounce = 500 * time.Millisecond

// pollSoonLocked moves the next poll to within pollDebounce. A poll that is running
// now (it may have planned without the caller's change) is followed by another one.
// Called with s.mu held.
func (s *Store) pollSoonLocked(now time.Time) {
	s.pollAgain = true
	if at := now.Add(pollDebounce); s.pollNext.After(at) {
		s.pollNext = at
	}
}

// schedulePollLocked sets the next poll after one finished: at next, or right away if
// a poll was asked for meanwhile. Called with s.mu held.
func (s *Store) schedulePollLocked(now, next time.Time) {
	if s.pollAgain && next.After(now) {
		next = now
	}
	s.pollAgain = false
	s.pollNext = next
}

// Snapshot implements Service.
func (s *Store) Snapshot() *Snapshot { return s.snap.Load() }

// Track implements Service. A repository without cached default-branch CI makes the
// next poll come soon; otherwise it joins the regular cadence.
func (s *Store) Track(slug string) error {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return err
	}
	now := s.opts.Now()
	s.mu.Lock()
	if s.tracked[key] {
		s.mu.Unlock()
		return nil
	}
	s.tracked[key] = true
	a := s.Snapshot().Repos[key].Activity
	if a.DefaultBranch.FetchedAt.IsZero() {
		s.pollSoonLocked(now)
	}
	if a.Stats.FetchedAt.IsZero() {
		s.statsNext = now // the next poll brings its stats (and refreshes the others)
	}
	s.mu.Unlock()
	s.setTracked(key, true)
	s.nudge()
	s.log.Info("gh tracking repo", "slug", key)
	return nil
}

// Untrack implements Service.
func (s *Store) Untrack(slug string) error {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return err
	}
	s.mu.Lock()
	ok := s.tracked[key]
	delete(s.tracked, key)
	s.mu.Unlock()
	if !ok {
		return nil
	}
	s.setTracked(key, false)
	s.log.Info("gh untracked repo", "slug", key)
	return nil
}

// setTracked records a repository's tracked flag and announces it: GetRepoActivity
// reports it and GetDashboard filters by it.
func (s *Store) setTracked(slug string, tracked bool) {
	r := s.updateRepo(slug, func(r *RepoState) { r.Tracked = tracked })
	publish(s, RepoActivityUpdated{Slug: slug, FetchedAt: r.Activity.DefaultBranch.FetchedAt})
	publish(s, DashboardUpdated{FetchedAt: s.Snapshot().Dashboard.FetchedAt})
}

// Refresh implements Service.
func (s *Store) Refresh(ctx context.Context, slug string) error {
	if slug == "" {
		s.mu.Lock()
		s.pollAgain = true
		s.pollNext = s.opts.Now()
		s.mu.Unlock()
		s.nudge()
		return nil
	}
	if _, err := NormalizeSlug(slug); err != nil {
		return err
	}
	return s.submit(ctx, &job{kind: jobPoll}).err
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
		"min_gap", s.opts.MinGap.String(), "poll_interval", s.config().PollInterval.String())
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
// poll (or only the auth check while gh is not authenticated). Nothing starts within
// MinGap of the previous request's end, and the poll waits out a rate-limit or network
// pause.
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
		j, at = &job{kind: jobPoll}, laterOf(s.pollNext, s.pauseUntil)
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
	case jobPoll:
		res.err = s.poll(ctx)
	case jobAuth:
		s.checkAuth(ctx)
	case jobPullRequest:
		res.detail, res.err = s.fetchPullRequest(ctx, j.slug, j.number)
	case jobChecks:
		res.checks, res.err = s.fetchChecks(ctx, j.slug, j.ref)
	case jobFunc:
		res.value, res.err = j.run(ctx)
	}
	j.reply(res)
}

// call runs one paced GraphQL request from queries/ and applies its global effects.
func (s *Store) call(ctx context.Context, name string, vars map[string]any) (json.RawMessage, error) {
	q, err := query(name)
	if err != nil {
		return nil, err
	}
	return s.callDoc(ctx, name, q, vars)
}

// callDoc runs one paced GraphQL document and applies its global effects (auth state,
// rate-limit budget, pauses). It sleeps out MinGap since the previous request first. A
// *PartialError comes back with its data and counts as a success globally.
func (s *Store) callDoc(ctx context.Context, name, doc string, vars map[string]any) (json.RawMessage, error) {
	if err := s.pace(ctx); err != nil {
		return nil, err
	}
	start := s.opts.Now()
	data, err := s.opts.Runner.GraphQL(ctx, doc, vars)
	s.lastEnd = s.opts.Now()
	var rl *rateLimitJSON
	if data != nil {
		var env struct {
			RateLimit *rateLimitJSON `json:"rateLimit"`
		}
		if json.Unmarshal(data, &env) == nil {
			rl = env.RateLimit
		}
	}
	attrs := []any{"query", name, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "bytes", len(data)}
	if name != queryPoll { // the poll's variables are logged by poll.go in summary form
		attrs = append(attrs, "vars", vars)
	}
	if rl != nil {
		attrs = append(attrs, "cost", rl.Cost, "remaining", rl.Remaining)
	}
	if err != nil {
		attrs = append(attrs, "err", err)
	}
	s.log.Debug("gh request", attrs...)
	s.cycle.requests++
	if rl != nil {
		s.cycle.cost += rl.Cost
	}
	global := err
	if isPartial(err) {
		global = nil
	}
	s.noteResult(ctx, global, rl)
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
			s.pollNext = now
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
