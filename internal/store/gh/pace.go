package gh

import "time"

// Pacing defaults. Rationale (see docs/notes/phase1c-gh.md and
// docs/notes/gh-http-transport.md):
//
//   - Requests go over one keep-alive HTTP client (HTTPRunner), one in flight. Until
//     2026-10 each request was a fresh `gh` process (keychain read through securityd,
//     new TLS handshake), which is what a 2s gap protected; that cost is gone.
//   - The poll is one request per PollInterval; details follow only for what changed.
//   - GitHub's secondary rate limits penalize concurrency and bursts (no more than ~100
//     concurrent requests, ~2,000 GraphQL points per minute, serial requests). One
//     request in flight with a 1s gap caps us below 60 requests/minute.
//   - The GraphQL primary limit is 5,000 points/hour. The shortest request measured
//     ~0.2s, so a worker that never idled would make at most 3600/1.2 = 3,000
//     requests/hour at a 1s gap: even a runaway schedule cannot drain the budget past
//     MinRemaining. A 0.5s gap would allow ~5,100. The store also reads rateLimit from
//     every response and pauses until resetAt when fewer than MinRemaining points remain.
const (
	DefaultMinGap = time.Second
	// DefaultPollInterval is how often the fingerprint poll runs while any repository
	// is tracked or branch watched (github.poll_interval_seconds). One request, cost 1.
	DefaultPollInterval = 60 * time.Second
	// DefaultIdleInterval is the poll cadence with nothing tracked or watched: only the
	// viewer is fetched.
	DefaultIdleInterval   = 10 * time.Minute
	DefaultAuthRetry      = 60 * time.Second
	DefaultNetworkBackoff = 15 * time.Second
	// DefaultSecondaryBackoff follows GitHub's guidance to wait at least a minute after a
	// secondary rate limit response without a retry-after header. With one, the store
	// waits exactly that long (rateLimitPause).
	DefaultSecondaryBackoff = 60 * time.Second
	DefaultMaxBackoff       = 15 * time.Minute
	DefaultDetailTTL        = 30 * time.Second
	DefaultMinRemaining     = 200
	// DefaultMaxPages caps check pages (100 checks each) fetched for one commit.
	DefaultMaxPages = 4
	// DefaultDetailBatch is how many open pull requests one detail request asks for.
	// Measured ~300ms of server time per busy PR (mergeStateStatus and reviewDecision
	// dominate): 10 took ~4.5s, 20 ~6.5s, 40 hit GitHub's 10s timeout (HTTP 502). A
	// 502/504 halves it (sticky, floor minDetailBatch).
	DefaultDetailBatch = 10
	minDetailBatch     = 1
	// closedPerOpen is how many closed/merged PRs (summary only, ~40ms each) one detail
	// request carries per open PR slot.
	closedPerOpen = 3
	// jitterFraction spreads retries by +/-20% so failures that happen together
	// drift apart instead of retrying back to back forever.
	jitterFraction = 0.2
	// rateLimitSlack is added to resetAt before resuming, to absorb clock skew.
	rateLimitSlack = 5 * time.Second
	// retryAfterSlack is added to a retry-after header's wait.
	retryAfterSlack = time.Second
)

// backoff returns the delay before retry number n (n >= 1): base doubled n-1 times,
// capped at max, then jittered by +/-jitterFraction using r in [0, 1). n <= 0 is
// treated as 1.
func backoff(base, max time.Duration, n int, r float64) time.Duration {
	if n < 1 {
		n = 1
	}
	d := base
	for i := 1; i < n && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	return jitter(d, r)
}

// jitter scales d by a factor in [1-jitterFraction, 1+jitterFraction) chosen by r in [0, 1).
func jitter(d time.Duration, r float64) time.Duration {
	f := 1 + jitterFraction*(2*r-1)
	return time.Duration(float64(d) * f)
}

// budgetPause returns when to resume if the remaining rate-limit budget is below
// minRemaining, or the zero time when no pause is needed.
func budgetPause(rl *rateLimitJSON, minRemaining int, now time.Time) time.Time {
	if rl == nil || rl.Limit == 0 || rl.Remaining >= minRemaining || !rl.ResetAt.After(now) {
		return time.Time{}
	}
	return rl.ResetAt.Add(rateLimitSlack)
}

// rateLimitPause returns when to resume after a rate-limit error. GitHub's guidance:
// honor retry-after when present; after a primary limit wait for x-ratelimit-reset (or
// the resetAt of the last successful response); otherwise wait at least a minute
// (fallback, the jittered SecondaryBackoff).
func rateLimitPause(rle *RateLimitError, now, lastResetAt time.Time, fallback time.Duration) time.Time {
	var until time.Time
	if rle.RetryAfter > 0 {
		until = now.Add(rle.RetryAfter + retryAfterSlack)
	}
	if !rle.Secondary {
		reset := rle.ResetAt
		if !reset.After(now) {
			reset = lastResetAt
		}
		if reset.After(now) {
			until = laterOf(until, reset.Add(rateLimitSlack))
		}
	}
	if until.IsZero() {
		until = now.Add(fallback)
	}
	return until
}

func laterOf(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
