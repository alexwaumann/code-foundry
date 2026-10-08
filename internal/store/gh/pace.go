package gh

import "time"

// Pacing defaults. Rationale (see docs/notes/phase1c-gh.md):
//
//   - Every request is a fresh `gh` process: it reads the token from the macOS keychain
//     through securityd and performs a new TLS handshake (also securityd-verified).
//     Bursts of parallel gh processes make securityd spike CPU and serialize anyway, so
//     there is one request in flight and at least MinGap of idle between requests.
//   - GitHub's secondary rate limits penalize concurrency and bursts (no more than ~100
//     concurrent requests, ~2,000 GraphQL points per minute, and "make requests serially,
//     wait at least one second between mutative requests"). Serial requests at a 2s gap
//     cap us at 30 requests/minute, far inside those limits.
//   - The GraphQL primary limit is 5,000 points/hour. A PR-list page costs ~1 point, so
//     one repo every 60s is ~60 points/hour; dozens of tracked repos fit comfortably. The
//     store reads rateLimit from every response and pauses until resetAt when fewer
//     than MinRemaining points remain.
const (
	DefaultMinGap         = 2 * time.Second
	DefaultRepoInterval   = 60 * time.Second
	DefaultViewerInterval = 10 * time.Minute
	DefaultAuthRetry      = 60 * time.Second
	DefaultNetworkBackoff = 15 * time.Second
	// DefaultSecondaryBackoff follows GitHub's guidance to wait at least a minute after a
	// secondary rate limit response without a retry-after header (gh does not surface it).
	DefaultSecondaryBackoff = 60 * time.Second
	DefaultMaxBackoff       = 15 * time.Minute
	DefaultDetailTTL        = 30 * time.Second
	DefaultMinRemaining     = 200
	// DefaultPageSize keeps a PR-list page around 2.5s of GitHub server time (~95ms per
	// PR measured on ghostty-org/ghostty); 100 per page hit GitHub's 10s timeout (502).
	DefaultPageSize = 25
	// DefaultMaxPages caps a poll at the 100 most recently updated open PRs. TotalCount
	// still reports the real number.
	DefaultMaxPages = 4
	// minPageSize is the floor when a 502/504 halves a repo's page size.
	minPageSize = 5
	// jitterFraction spreads retries and polls by +/-20% so repos tracked at the same
	// moment drift apart instead of firing back to back forever.
	jitterFraction = 0.2
	// rateLimitSlack is added to resetAt before resuming, to absorb clock skew.
	rateLimitSlack = 5 * time.Second
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

func laterOf(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}
