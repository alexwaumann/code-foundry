package gh

import (
	"context"
	"fmt"
	"slices"
	"time"
)

// Bounded read-only concurrency lane (docs/notes/perf-gh-read-lane.md).
//
// While the primary worker is blocked inside a read-only GitHub request (a poll
// fingerprint, detail batch, stats query, projects search, or another read), a single
// extra read-lane goroutine may dispatch one user-waited read-only job at a time over
// the shared HTTP/2 client (at most 2 requests in flight total).
//
// Safety invariants:
//   - At most 1 job runs on the read lane at any time.
//   - Only read-only jobs with an active caller waiting (job.read && !job.background &&
//     len(waiters) > 0, never jobPoll, jobAuth, poll_projects, background refreshes, or
//     mutations/REST writes) are eligible.
//   - Read-lane concurrency is forbidden while a write/mutation is waiting to run or in
//     flight on the primary worker: enterWrite blocks new read-lane claims and drains
//     any in-flight read-lane job before the write begins.
//   - Every request on the read lane spends 1 token from the shared gapAllowance bucket
//     (burst 8, refill 1 per 10s, emptied on any rate-limit error). When the bucket is
//     empty, user-waited reads fall back cleanly to the primary worker (yield.go).
//   - Global pauses, auth errors, low rate-limit budget, and network errors on either
//     lane update shared state under s.mu and immediately block both lanes.
//   - Worker-only fields (scheduled, forUser, ahead, searchFirst, detailBatch, recheck,
//     appearing, failingKey, searchAsID, cycle) are never touched on the read lane.

type readLaneKey struct{}

func withReadLane(ctx context.Context) context.Context {
	return context.WithValue(ctx, readLaneKey{}, true)
}

func isReadLane(ctx context.Context) bool {
	v, _ := ctx.Value(readLaneKey{}).(bool)
	return v
}

// readLaneEligible reports whether j may be dispatched on the read-only lane.
func (j *job) readLaneEligible() bool {
	return j.read && !j.background && len(j.waiters) > 0 &&
		j.kind != jobPoll && j.kind != jobAuth && j.id != "poll_projects"
}

// dedupInflight reports whether callers submitting the same key while j is running
// should coalesce onto j's result instead of sending a duplicate request.
func (j *job) dedupInflight() bool {
	return j.read && !j.background &&
		j.kind != jobPoll && j.kind != jobAuth && j.id != "poll_projects"
}

// isWriteJob reports whether j is a non-read job (a GraphQL mutation, REST write, or
// serializing barrier) that must run strictly alone on the primary worker.
func isWriteJob(j *job) bool {
	return j.kind == jobFunc && !j.read
}

func (s *Store) nextReqSeq() uint64 {
	return s.reqSeq.Add(1)
}

func (s *Store) nudgeReadLane() {
	if s.readWake == nil {
		return
	}
	select {
	case s.readWake <- struct{}{}:
	default:
	}
}

// beginPrimaryRead marks that the primary worker is about to block inside a read-only
// network call, allowing the read lane to dispatch one user-waited read concurrently.
func (s *Store) beginPrimaryRead() {
	s.mu.Lock()
	wake := false
	if !s.primaryWriting {
		s.primaryInFlightRead = true
		wake = true
	}
	s.mu.Unlock()
	if wake {
		s.nudgeReadLane()
	}
}

// endPrimaryRead clears primaryInFlightRead and records end as the latest request finish.
func (s *Store) endPrimaryRead(end time.Time) {
	s.mu.Lock()
	s.primaryInFlightRead = false
	s.lastEnd = laterOf(s.lastEnd, end)
	s.mu.Unlock()
}

// recordLastEnd advances s.lastEnd to at least end under s.mu.
func (s *Store) recordLastEnd(end time.Time) {
	s.mu.Lock()
	s.lastEnd = laterOf(s.lastEnd, end)
	s.mu.Unlock()
}

// enterWrite prevents new read-lane dispatches and waits until any in-flight read-lane
// job finishes (or ctx is cancelled). Primary worker only.
func (s *Store) enterWrite(ctx context.Context) bool {
	s.mu.Lock()
	prev := s.primaryWriting
	s.primaryWriting = true
	for s.readLaneBusy {
		done := s.readLaneDone
		s.mu.Unlock()
		select {
		case <-done:
		case <-ctx.Done():
			return prev
		}
		s.mu.Lock()
	}
	s.mu.Unlock()
	return prev
}

// leaveWrite restores primaryWriting after a write job finishes. Primary worker only.
func (s *Store) leaveWrite(prev bool) {
	s.mu.Lock()
	s.primaryWriting = prev
	wake := !prev && s.primaryInFlightRead
	s.mu.Unlock()
	if wake {
		s.nudgeReadLane()
	}
}

// registerInflightLocked records a claimed user-waited read job so concurrent callers
// for the same key share its in-flight result. Called with s.mu held.
func (s *Store) registerInflightLocked(j *job) {
	if !j.dedupInflight() {
		return
	}
	if s.inflight == nil {
		s.inflight = map[string]*job{}
	}
	s.inflight[j.key()] = j
}

// finishJob removes j from s.inflight (if registered) and delivers res to every waiter
// atomically with respect to concurrent enqueueLocked/abandon calls.
func (s *Store) finishJob(j *job, res jobResult) {
	s.mu.Lock()
	if s.inflight[j.key()] == j {
		delete(s.inflight, j.key())
	}
	waiters := j.waiters
	j.waiters = nil
	s.mu.Unlock()
	for _, ch := range waiters {
		ch <- res // buffered (cap 1), one send per channel
	}
}

// runReadLane is the single extra read-only worker goroutine owned by Store.Run.
// It exits cleanly when ctx is cancelled, after finishing any claimed job.
func (s *Store) runReadLane(ctx context.Context) {
	readCtx := withReadLane(ctx)
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		j, wait := s.claimReadLane(ctx)
		if j != nil {
			s.executeReadLane(readCtx, j)
			continue
		}
		var timerC <-chan time.Time
		if wait > 0 {
			timer.Reset(wait)
			timerC = timer.C
		}
		select {
		case <-ctx.Done():
			return
		case <-s.readWake:
		case <-timerC:
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}
}

// claimReadLane claims the first user-waited read job when the primary worker is blocked
// in a read-only request, no write or pause/auth failure is active, and the shared
// allowance has at least one token. If a UserGap wait remains since the last completed
// request, it returns (nil, wait) without claiming so callers can still abandon cleanly.
func (s *Store) claimReadLane(ctx context.Context) (*job, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || s.stopped != nil {
		return nil, 0
	}
	if !s.primaryInFlightRead || s.primaryWriting || s.authBad || s.pausedLocked() != nil {
		return nil, 0
	}
	i := slices.IndexFunc(s.queue, func(q *job) bool { return q.readLaneEligible() })
	if i < 0 {
		return nil, 0
	}
	now := s.opts.Now()
	if !s.allowance.left(now) {
		return nil, 0
	}
	if !s.lastEnd.IsZero() {
		if wait := s.lastEnd.Add(s.opts.UserGap).Sub(now); wait > 0 {
			return nil, wait
		}
	}
	j := s.queue[i]
	s.queue = slices.Delete(s.queue, i, i+1)
	s.readLaneBusy = true
	s.readLaneDone = make(chan struct{})
	s.registerInflightLocked(j)
	return j, 0
}

// executeReadLane runs a claimed user-waited read job on the read lane.
func (s *Store) executeReadLane(ctx context.Context, j *job) {
	defer func() {
		s.mu.Lock()
		s.readLaneBusy = false
		done := s.readLaneDone
		s.readLaneDone = nil
		s.mu.Unlock()
		if done != nil {
			close(done)
		}
	}()
	var res jobResult
	switch j.kind {
	case jobPullRequest:
		res.detail, res.err = s.fetchPullRequest(ctx, j.slug, j.number)
	case jobFunc:
		res.value, res.err = j.run(ctx)
	}
	s.finishJob(j, res)
}

// admitReadLane gates every request sent on the read lane: refuses writes, refuses
// while paused (notSent), enforces UserGap spacing, and spends one token from the
// shared gapAllowance on every dispatched request.
func (s *Store) admitReadLane(ctx context.Context, read bool) error {
	if !read {
		return fmt.Errorf("gh: write request attempted on read lane")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	if err := s.pausedLocked(); err != nil {
		s.mu.Unlock()
		return notSent{err}
	}
	now := s.opts.Now()
	var wait time.Duration
	if !s.allowance.left(now) {
		wait = s.allowance.nextRefill(now)
	}
	if !s.lastEnd.IsZero() {
		if gap := s.lastEnd.Add(s.opts.UserGap).Sub(now); gap > wait {
			wait = gap
		}
	}
	if wait <= 0 {
		s.allowance.spend(now)
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	t := time.NewTimer(wait)
	select {
	case <-ctx.Done():
		t.Stop()
		return ctx.Err()
	case <-t.C:
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.pausedLocked(); err != nil {
		return notSent{err}
	}
	s.allowance.spend(s.opts.Now())
	return nil
}
