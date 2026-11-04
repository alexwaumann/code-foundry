package gh

import (
	"context"
	"slices"
	"strings"
	"time"
)

// The worker is what keeps GitHub requests serial, and a poll is one job on it, many
// requests long. So that a click does not wait for all of them, every request goes
// through admit, and a poll's (or auth check's) admit first runs the jobs someone waits
// for, on this same goroutine, as plain calls from inside the poll. Nothing here is
// concurrent: one request is in flight as before, the worker-only fields stay
// worker-only, and the poll carries on from where it stood once the jobs are done.
//
// What this relies on: the only place a poll stops is admit, right before a request.
// Code between two requests runs unbroken, so what a fingerprint response marks stale is
// applied before any job can run (a job's fetch is never judged by an older fingerprint)
// and the publish cannot be split. What a poll holds across a yield is what it asked
// GitHub before the job ran, and a job that changes GitHub asks for another poll
// (pollSoon, kept by pollAgain), while a merge shown meanwhile survives the publish
// (mergedOverlay.apply). See docs/notes/pr-queue-priority.md.

// admit is every request's door, on the worker. It lets waiting jobs go first when the
// running job is scheduled work, refuses the request while a pause is in force (a pause
// set by the request before it or by a job just let in; nothing is sent, and the caller
// gets the pause's error), and waits out the gap since the previous request. read marks
// a request that changes nothing: with a waiting caller it may use a short gap.
func (s *Store) admit(ctx context.Context, read bool) error {
	short := read && s.forUser
wait:
	for {
		if s.scheduled {
			s.letWaitingIn(ctx)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		err := s.pausedLocked()
		s.mu.Unlock()
		if err != nil {
			return notSent{err}
		}
		now := s.opts.Now()
		left := s.lastEnd.Add(s.gap(short, now)).Sub(now)
		if left <= 0 {
			break
		}
		var wake <-chan struct{}
		if s.scheduled { // a job arriving during the gap goes first, not after the request
			wake = s.wake
		}
		t := time.NewTimer(left)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
			break wait
		case <-wake:
			t.Stop()
		}
	}
	now := s.opts.Now()
	if short && now.Before(s.lastEnd.Add(s.opts.MinGap)) {
		s.allowance.spend(now)
	}
	if s.scheduled {
		s.ahead = 0
	}
	return nil
}

// notSent is a pause's error from admit: it reads and matches like the pause, and says
// the request never left, which a network error otherwise cannot (outcomeUnknown).
type notSent struct{ error }

func (e notSent) Unwrap() error { return e.error }

// letWaitingIn runs the jobs someone waits for, oldest first, up to maxJobsAhead since
// scheduled work last sent a request; the rest get their turn before its next one.
// Background jobs wait for the poll to end, and so does a queued poll: polls do not nest.
func (s *Store) letWaitingIn(ctx context.Context) {
	for ctx.Err() == nil {
		j := s.claimWaiting()
		if j == nil {
			return
		}
		cycle, start := s.cycle, s.opts.Now()
		s.execute(ctx, j)
		s.cycle = cycle // the poll's counts are the poll's
		s.cycle.yields++
		s.cycle.yieldDur += s.opts.Now().Sub(start)
	}
}

// claimWaiting takes the first job someone waits for off the queue; nil when there is
// none, or when enough have gone ahead.
func (s *Store) claimWaiting() *job {
	if s.ahead >= maxJobsAhead {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.queue, func(q *job) bool { return !q.background && q.kind != jobPoll })
	if i < 0 {
		return nil
	}
	j := s.queue[i]
	s.queue = slices.Delete(s.queue, i, i+1)
	s.ahead++
	return j
}

// gap is how long after the previous request the next may start: MinGap, or UserGap for
// a read someone waits for while the allowance lasts. Worker goroutine only.
func (s *Store) gap(user bool, now time.Time) time.Duration {
	if user && s.allowance.left(now) {
		return s.opts.UserGap
	}
	return s.opts.MinGap
}

// isMutation reports whether a GraphQL document writes.
func isMutation(doc string) bool { return strings.HasPrefix(doc, "mutation") }

// gapAllowance is a token bucket of short gaps, userGapBurst deep, one back every
// userGapRefill: a person opening a few pull requests does not pay MinGap on each, and a
// runaway client still does. owed is when the bucket will be full again.
type gapAllowance struct{ owed time.Time }

// left reports whether a short gap is available at now.
func (a gapAllowance) left(now time.Time) bool {
	return a.owed.Sub(now) <= (userGapBurst-1)*userGapRefill
}

// spend takes one short gap at now.
func (a *gapAllowance) spend(now time.Time) { a.owed = laterOf(a.owed, now).Add(userGapRefill) }

// exhaust empties the bucket: after a rate limit, every request pays the full gap until
// it refills.
func (a *gapAllowance) exhaust(now time.Time) { a.owed = now.Add(userGapBurst * userGapRefill) }
