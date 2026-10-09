package gh

import (
	"errors"
	"testing"
	"time"
)

func TestBackoff(t *testing.T) {
	const mid = 0.5 // r = 0.5 means no jitter
	tests := []struct {
		name      string
		base, max time.Duration
		n         int
		r         float64
		want      time.Duration
	}{
		{"first retry is base", time.Minute, 15 * time.Minute, 1, mid, time.Minute},
		{"n<1 treated as 1", time.Minute, 15 * time.Minute, 0, mid, time.Minute},
		{"doubles", time.Minute, 15 * time.Minute, 3, mid, 4 * time.Minute},
		{"caps at max", time.Minute, 15 * time.Minute, 5, mid, 15 * time.Minute},
		{"huge n stays capped", time.Minute, 15 * time.Minute, 1000, mid, 15 * time.Minute},
		{"jitter low end", time.Minute, 15 * time.Minute, 1, 0, 48 * time.Second},
		{"jitter high end", time.Minute, 15 * time.Minute, 1, 1, 72 * time.Second},
		{"jitter applies after cap", time.Minute, 15 * time.Minute, 10, 0, 12 * time.Minute},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := backoff(tt.base, tt.max, tt.n, tt.r); got != tt.want {
				t.Errorf("backoff = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBudgetPause(t *testing.T) {
	now := time.Date(2026, 10, 8, 6, 0, 0, 0, time.UTC)
	reset := now.Add(20 * time.Minute)
	tests := []struct {
		name string
		rl   *rateLimitJSON
		want time.Time
	}{
		{"no rate limit info", nil, time.Time{}},
		{"plenty left", &rateLimitJSON{Limit: 5000, Remaining: 4000, ResetAt: reset}, time.Time{}},
		{"exactly at threshold", &rateLimitJSON{Limit: 5000, Remaining: 200, ResetAt: reset}, time.Time{}},
		{"low budget pauses until reset", &rateLimitJSON{Limit: 5000, Remaining: 199, ResetAt: reset}, reset.Add(rateLimitSlack)},
		{"reset already passed", &rateLimitJSON{Limit: 5000, Remaining: 0, ResetAt: now.Add(-time.Second)}, time.Time{}},
		{"zero limit is unknown", &rateLimitJSON{}, time.Time{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := budgetPause(tt.rl, 200, now); !got.Equal(tt.want) {
				t.Errorf("budgetPause = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestNormalizeSlug(t *testing.T) {
	tests := []struct {
		in, want string
		ok       bool
	}{
		{"ghostty-org/ghostty", "ghostty-org/ghostty", true},
		{"  Ghostty-Org/Ghostty ", "ghostty-org/ghostty", true},
		{"a/b.c_d-e", "a/b.c_d-e", true},
		{"ghostty", "", false},
		{"a/b/c", "", false},
		{"-a/b", "", false},
		{"a/", "", false},
		{"/b", "", false},
		{"a/.", "", false},
		{"a/..", "", false},
		{"a b/c", "", false},
		{"", "", false},
	}
	for _, tt := range tests {
		got, err := NormalizeSlug(tt.in)
		if (err == nil) != tt.ok || got != tt.want {
			t.Errorf("NormalizeSlug(%q) = %q, %v; want %q ok=%v", tt.in, got, err, tt.want, tt.ok)
		}
		if err != nil && !errors.Is(err, ErrInvalidSlug) {
			t.Errorf("NormalizeSlug(%q) err = %v, want ErrInvalidSlug", tt.in, err)
		}
	}
}

func TestRateLimitPause(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	fallback := time.Minute
	tests := []struct {
		name        string
		rle         RateLimitError
		lastResetAt time.Time
		want        time.Time
	}{
		{"secondary, retry-after honored exactly", RateLimitError{Secondary: true, RetryAfter: 10 * time.Second},
			time.Time{}, now.Add(10*time.Second + retryAfterSlack)},
		{"secondary, retry-after longer than fallback", RateLimitError{Secondary: true, RetryAfter: 5 * time.Minute},
			time.Time{}, now.Add(5*time.Minute + retryAfterSlack)},
		{"secondary without retry-after waits the fallback", RateLimitError{Secondary: true},
			now.Add(time.Hour), now.Add(fallback)},
		{"primary, header reset", RateLimitError{ResetAt: now.Add(20 * time.Minute)},
			now.Add(time.Hour), now.Add(20*time.Minute + rateLimitSlack)},
		{"primary, last seen resetAt", RateLimitError{}, now.Add(30 * time.Minute), now.Add(30*time.Minute + rateLimitSlack)},
		{"primary, stale header reset falls back to last seen", RateLimitError{ResetAt: now.Add(-time.Minute)},
			now.Add(30 * time.Minute), now.Add(30*time.Minute + rateLimitSlack)},
		{"primary, nothing known", RateLimitError{}, now.Add(-time.Minute), now.Add(fallback)},
		{"primary, retry-after and reset: the later", RateLimitError{RetryAfter: time.Minute, ResetAt: now.Add(10 * time.Minute)},
			time.Time{}, now.Add(10*time.Minute + rateLimitSlack)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := rateLimitPause(&tt.rle, now, tt.lastResetAt, fallback); !got.Equal(tt.want) {
				t.Errorf("until = %v, want %v", got.Sub(now), tt.want.Sub(now))
			}
		})
	}
}
