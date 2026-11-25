package gh

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// syncClock is a goroutine-safe controllable clock for tests that spawn background work.
type syncClock struct {
	mu  sync.Mutex
	cur time.Time
}

func newSyncClock() *syncClock {
	return &syncClock{cur: time.Unix(1_800_000_000, 0)}
}

func (c *syncClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cur
}

func (c *syncClock) advance(d time.Duration) {
	c.mu.Lock()
	c.cur = c.cur.Add(d)
	c.mu.Unlock()
}

// controlledTokens lets a test block, release, count, and swap TokenSource responses.
type controlledTokens struct {
	mu      sync.Mutex
	calls   int
	fn      func(ctx context.Context, call int) (string, error)
	started chan int
}

func (c *controlledTokens) Token(ctx context.Context) (string, error) {
	c.mu.Lock()
	c.calls++
	n := c.calls
	fn := c.fn
	started := c.started
	c.mu.Unlock()
	if started != nil {
		select {
		case started <- n:
		default:
		}
	}
	return fn(ctx, n)
}

func (c *controlledTokens) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

func TestHTTPRunnerSoftTTLRefresh(t *testing.T) {
	ctx := context.Background()

	t.Run("coalesced_background_refresh_off_hot_path", func(t *testing.T) {
		var authMu sync.Mutex
		var seenAuth []string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authMu.Lock()
			seenAuth = append(seenAuth, r.Header.Get("Authorization"))
			authMu.Unlock()
			_, _ = w.Write(fixtureBytes("viewer.json"))
		}))
		t.Cleanup(srv.Close)

		release := make(chan struct{})
		tokens := &controlledTokens{
			started: make(chan int, 4),
			fn: func(ctx context.Context, call int) (string, error) {
				if call == 1 {
					return "tok1", nil
				}
				select {
				case <-release:
					return "tok2", nil
				case <-ctx.Done():
					return "", ctx.Err()
				}
			},
		}
		clk := newSyncClock()
		r := NewHTTPRunner(HTTPOptions{
			BaseURL:  srv.URL,
			Tokens:   tokens,
			TokenTTL: 15 * time.Minute, // default soft TTL = 12m
			Now:      clk.now,
		})
		t.Cleanup(r.Close)

		// Cold call resolves tok1 synchronously.
		if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		if got := <-tokens.started; got != 1 {
			t.Fatalf("first call = %d, want 1", got)
		}

		// Just below soft TTL (11m59s): no background refresh.
		clk.advance(11*time.Minute + 59*time.Second)
		if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		if n := tokens.count(); n != 1 {
			t.Fatalf("below soft TTL: calls = %d, want 1", n)
		}

		// Enter soft-TTL window (12m01s): returns cached tok1 immediately while
		// background refresh blocks on release.
		clk.advance(2 * time.Second)
		start := time.Now()
		if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		if dur := time.Since(start); dur > 500*time.Millisecond {
			t.Fatalf("hot-path call blocked during background refresh: %v", dur)
		}

		// Wait until background refresh has started.
		select {
		case got := <-tokens.started:
			if got != 2 {
				t.Fatalf("bg call = %d, want 2", got)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("background refresh did not start")
		}

		// Concurrent / repeated calls while background refresh is in flight coalesce
		// and return immediately with cached tok1.
		var wg sync.WaitGroup
		for range 5 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
					t.Errorf("concurrent GraphQL: %v", err)
				}
			}()
		}
		wg.Wait()
		if n := tokens.count(); n != 2 {
			t.Fatalf("concurrent calls spawned extra refreshes: calls = %d, want 2", n)
		}

		// Unblock background refresh and wait for it to install tok2.
		close(release)
		waitFor(t, "background refresh applied", func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return !r.refreshing && r.token == "tok2"
		})

		// Next call uses tok2 immediately with no additional TokenSource call.
		if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		if n := tokens.count(); n != 2 {
			t.Fatalf("post-refresh calls = %d, want 2", n)
		}
		authMu.Lock()
		lastAuth := seenAuth[len(seenAuth)-1]
		authMu.Unlock()
		if lastAuth != "Bearer tok2" {
			t.Errorf("last auth = %q, want Bearer tok2", lastAuth)
		}
	})

	t.Run("background_refresh_error_preserves_valid_token_and_throttles", func(t *testing.T) {
		srv := newAPIServer(t, "tok1", serveViewer)
		var fail atomic.Bool
		tokens := &controlledTokens{
			started: make(chan int, 8),
			fn: func(_ context.Context, _ int) (string, error) {
				if fail.Load() {
					return "", errors.Join(ErrNoToken, errors.New("temporary keychain error"))
				}
				return "tok1", nil
			},
		}
		clk := newSyncClock()
		r := NewHTTPRunner(HTTPOptions{
			BaseURL:  srv.URL,
			Tokens:   tokens,
			TokenTTL: 15 * time.Minute,
			Now:      clk.now,
		})
		t.Cleanup(r.Close)

		if _, err := r.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		<-tokens.started

		// Enter soft TTL with failing TokenSource: hot path still succeeds with tok1.
		fail.Store(true)
		clk.advance(12*time.Minute + time.Second)
		if _, err := r.GraphQL(ctx, "q", nil); err != nil {
			t.Fatalf("soft-TTL request with failing bg refresh: %v", err)
		}
		<-tokens.started
		waitFor(t, "bg refresh finished", func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return !r.refreshing
		})

		// Immediate follow-up requests stay on cached tok1 and do NOT re-trigger failing
		// refresh within bgRefreshRetry.
		for range 3 {
			if _, err := r.GraphQL(ctx, "q", nil); err != nil {
				t.Fatalf("cached token lost after bg error: %v", err)
			}
		}
		if n := tokens.count(); n != 2 {
			t.Fatalf("throttled retries: calls = %d, want 2", n)
		}

		// After hard TTL expires (total > 15m), synchronous refresh runs and surfaces error.
		clk.advance(3 * time.Minute)
		if _, err := r.GraphQL(ctx, "q", nil); !errors.Is(err, ErrNotAuthenticated) {
			t.Fatalf("after hard TTL with error: err = %v, want ErrNotAuthenticated", err)
		}
	})

	t.Run("forced_sync_refresh_supersedes_inflight_background_refresh", func(t *testing.T) {
		srv := newAPIServer(t, "tok_fresh", serveViewer)
		bgRelease := make(chan struct{})
		tokens := &controlledTokens{
			started: make(chan int, 4),
			fn: func(ctx context.Context, call int) (string, error) {
				switch call {
				case 1:
					return "tok_old", nil
				case 2:
					// Background refresh returns stale token slowly.
					select {
					case <-bgRelease:
						return "tok_stale", nil
					case <-ctx.Done():
						return "", ctx.Err()
					}
				default:
					return "tok_fresh", nil
				}
			},
		}
		clk := newSyncClock()
		r := NewHTTPRunner(HTTPOptions{
			BaseURL:  srv.URL,
			Tokens:   tokens,
			TokenTTL: 15 * time.Minute,
			Now:      clk.now,
		})
		t.Cleanup(r.Close)

		// Seed cache with tok_old via resolveToken directly.
		tok, err := r.resolveToken(ctx, false)
		if err != nil || tok != "tok_old" {
			t.Fatalf("seed: tok=%q err=%v", tok, err)
		}
		<-tokens.started

		// Trigger slow background refresh.
		clk.advance(13 * time.Minute)
		tok, err = r.resolveToken(ctx, false)
		if err != nil || tok != "tok_old" {
			t.Fatalf("soft-TTL read: tok=%q err=%v", tok, err)
		}
		if got := <-tokens.started; got != 2 {
			t.Fatalf("bg call = %d, want 2", got)
		}

		// Synchronous AuthStatus (force=true) resolves tok_fresh while bg refresh is in flight.
		st, err := r.AuthStatus(ctx)
		if err != nil || !st.LoggedIn {
			t.Fatalf("AuthStatus: st=%+v err=%v", st, err)
		}
		<-tokens.started

		// Let the older background refresh finish; it must NOT overwrite tok_fresh.
		close(bgRelease)
		waitFor(t, "stale bg refresh exited", func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return !r.refreshing
		})

		r.mu.Lock()
		gotTok := r.token
		r.mu.Unlock()
		if gotTok != "tok_fresh" {
			t.Fatalf("token after stale bg refresh = %q, want tok_fresh", gotTok)
		}
	})

	t.Run("close_cancels_inflight_background_refresh", func(t *testing.T) {
		var canceled atomic.Bool
		tokens := &controlledTokens{
			started: make(chan int, 4),
			fn: func(ctx context.Context, call int) (string, error) {
				if call == 1 {
					return "tok1", nil
				}
				<-ctx.Done()
				canceled.Store(true)
				return "", ctx.Err()
			},
		}
		clk := newSyncClock()
		r := NewHTTPRunner(HTTPOptions{
			BaseURL:  "http://127.0.0.1:1",
			Tokens:   tokens,
			TokenTTL: 15 * time.Minute,
			Now:      clk.now,
		})

		if _, err := r.resolveToken(ctx, false); err != nil {
			t.Fatal(err)
		}
		<-tokens.started
		clk.advance(13 * time.Minute)
		if _, err := r.resolveToken(ctx, false); err != nil {
			t.Fatal(err)
		}
		<-tokens.started

		done := make(chan struct{})
		go func() {
			r.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("Close did not cancel and drain background token refresh")
		}
		if !canceled.Load() {
			t.Error("background refresh context was not canceled on Close")
		}
	})

	t.Run("latency_before_vs_after_130ms_token_stall", func(t *testing.T) {
		const tokenDelay = 130 * time.Millisecond
		srv := newAPIServer(t, "tok1", serveViewer)
		delayedTokens := &controlledTokens{
			fn: func(_ context.Context, _ int) (string, error) {
				time.Sleep(tokenDelay)
				return "tok1", nil
			},
		}

		// BEFORE (soft refresh disabled via TokenSoftTTL = -1): request after TTL stalls ~130ms.
		clkBefore := newSyncClock()
		rBefore := NewHTTPRunner(HTTPOptions{
			BaseURL:      srv.URL,
			Tokens:       delayedTokens,
			TokenTTL:     15 * time.Minute,
			TokenSoftTTL: -1,
			Now:          clkBefore.now,
		})
		t.Cleanup(rBefore.Close)
		if _, err := rBefore.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		clkBefore.advance(15*time.Minute + time.Second)
		t0 := time.Now()
		if _, err := rBefore.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		beforeDur := time.Since(t0)

		// AFTER (default soft TTL = 12m): request at 12m30s returns cached token immediately
		// while refresh runs off-path, and request at 15m01s ALSO has 0ms stall!
		clkAfter := newSyncClock()
		rAfter := NewHTTPRunner(HTTPOptions{
			BaseURL:  srv.URL,
			Tokens:   delayedTokens,
			TokenTTL: 15 * time.Minute,
			Now:      clkAfter.now,
		})
		t.Cleanup(rAfter.Close)
		if _, err := rAfter.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		clkAfter.advance(12*time.Minute + 30*time.Second)
		t1 := time.Now()
		if _, err := rAfter.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		afterSoftDur := time.Since(t1)
		waitFor(t, "off-path refresh done", func() bool {
			rAfter.mu.Lock()
			defer rAfter.mu.Unlock()
			return !rAfter.refreshing
		})
		// Advance past original 15m mark: token was already refreshed at 12m30s, so 0ms stall!
		clkAfter.advance(3 * time.Minute)
		t2 := time.Now()
		if _, err := rAfter.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		afterPast15mDur := time.Since(t2)

		t.Logf("METRIC token_refresh_latency: before_sync_at_15m=%v after_soft_at_12m30s=%v after_at_15m30s=%v",
			beforeDur.Round(time.Millisecond), afterSoftDur.Round(time.Millisecond), afterPast15mDur.Round(time.Millisecond))
		if beforeDur < tokenDelay {
			t.Errorf("before baseline did not stall as expected: %v < %v", beforeDur, tokenDelay)
		}
		if afterSoftDur >= tokenDelay/2 {
			t.Errorf("soft-TTL request stalled: %v (want < %v)", afterSoftDur, tokenDelay/2)
		}
		if afterPast15mDur >= tokenDelay/2 {
			t.Errorf("post-15m request stalled after off-path refresh: %v (want < %v)", afterPast15mDur, tokenDelay/2)
		}
	})
}

func TestHTTPRunnerWarmConnection(t *testing.T) {
	ctx := context.Background()

	t.Run("warms_http2_pool_for_subsequent_graphql_reuse", func(t *testing.T) {
		var (
			mu       sync.Mutex
			newConns int
			reqs     []struct{ method, path, proto, auth string }
		)
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			reqs = append(reqs, struct{ method, path, proto, auth string }{
				r.Method, r.URL.Path, r.Proto, r.Header.Get("Authorization"),
			})
			mu.Unlock()
			switch r.URL.Path {
			case "/rate_limit":
				w.WriteHeader(http.StatusOK)
			case "/graphql":
				_, _ = w.Write(fixtureBytes("viewer.json"))
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		srv.EnableHTTP2 = true
		srv.Config.ConnState = func(_ net.Conn, st http.ConnState) {
			if st == http.StateNew {
				mu.Lock()
				newConns++
				mu.Unlock()
			}
		}
		srv.StartTLS()
		t.Cleanup(srv.Close)

		tr := srv.Client().Transport.(*http.Transport).Clone()
		tr.IdleConnTimeout = idleConnTimeout
		tr.ForceAttemptHTTP2 = true
		r := NewHTTPRunner(HTTPOptions{
			BaseURL: srv.URL,
			Tokens:  &fakeTokens{tokens: []string{"tok"}},
			Client:  &http.Client{Transport: tr},
		})
		t.Cleanup(r.Close)

		if err := r.WarmConnection(ctx); err != nil {
			t.Fatalf("WarmConnection: %v", err)
		}
		if _, err := r.GraphQL(ctx, "query { viewer { login } }", nil); err != nil {
			t.Fatalf("GraphQL after warm: %v", err)
		}

		mu.Lock()
		defer mu.Unlock()
		if len(reqs) != 2 {
			t.Fatalf("reqs = %d, want 2 (%+v)", len(reqs), reqs)
		}
		if reqs[0].method != http.MethodHead || reqs[0].path != "/rate_limit" || reqs[0].auth != "Bearer tok" || reqs[0].proto != "HTTP/2.0" {
			t.Errorf("warm req = %+v, want HEAD /rate_limit HTTP/2.0 Bearer tok", reqs[0])
		}
		if reqs[1].method != http.MethodPost || reqs[1].path != "/graphql" || reqs[1].proto != "HTTP/2.0" {
			t.Errorf("graphql req = %+v, want POST /graphql HTTP/2.0", reqs[1])
		}
		if newConns != 1 {
			t.Errorf("new TCP/TLS connections = %d, want 1 (POST /graphql must reuse warm HTTP/2 conn)", newConns)
		}
	})

	t.Run("freshness_cooldown_wake_and_auth_guards", func(t *testing.T) {
		var headCalls atomic.Int32
		srv := newAPIServer(t, "tok", func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodHead && r.URL.Path == "/rate_limit" {
				headCalls.Add(1)
				w.WriteHeader(http.StatusOK)
				return
			}
			serveViewer(w, r)
		})
		clk := newSyncClock()
		r := NewHTTPRunner(HTTPOptions{
			BaseURL: srv.URL,
			Tokens:  &fakeTokens{tokens: []string{"tok"}},
			Now:     clk.now,
		})
		t.Cleanup(r.Close)

		// Recent GraphQL call makes connection fresh: WarmConnection is a no-op.
		if _, err := r.GraphQL(ctx, "q", nil); err != nil {
			t.Fatal(err)
		}
		clk.advance(5 * time.Second)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 0 {
			t.Fatalf("fresh conn warmed: headCalls = %d, want 0", n)
		}

		// After warmFreshWindow (15s), connection is aging/cold: WarmConnection warms once.
		clk.advance(15 * time.Second)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 1 {
			t.Fatalf("after fresh window: headCalls = %d, want 1", n)
		}

		// Rapid repeat within warmCooldown (even after CloseIdleConnections): skipped.
		r.CloseIdleConnections()
		clk.advance(5 * time.Second)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 1 {
			t.Fatalf("within cooldown: headCalls = %d, want 1", n)
		}

		// After warmCooldown (20s) + post-wake (lastWake >= lastConnAt): warms again.
		clk.advance(warmCooldown)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 2 {
			t.Fatalf("after cooldown+wake: headCalls = %d, want 2", n)
		}

		// Known rejected token: never sends HEAD /rate_limit.
		r.noteAnswer("tok", http.StatusUnauthorized)
		clk.advance(warmCooldown + warmFreshWindow)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 2 {
			t.Fatalf("known rejected token warmed: headCalls = %d, want 2", n)
		}

		// Closed runner: no-op.
		r.noteAnswer("tok", http.StatusOK)
		r.Close()
		clk.advance(warmCooldown + warmFreshWindow)
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		if n := headCalls.Load(); n != 2 {
			t.Fatalf("closed runner warmed: headCalls = %d, want 2", n)
		}
	})

	t.Run("coalesces_concurrent_warm_calls", func(t *testing.T) {
		release := make(chan struct{})
		started := make(chan struct{}, 1)
		var headCalls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			headCalls.Add(1)
			select {
			case started <- struct{}{}:
			default:
			}
			<-release
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(srv.Close)

		r := NewHTTPRunner(HTTPOptions{
			BaseURL: srv.URL,
			Tokens:  &fakeTokens{tokens: []string{"tok"}},
		})
		t.Cleanup(r.Close)

		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = r.WarmConnection(ctx)
		}()
		<-started

		// Second concurrent warm call returns immediately without sending another request.
		if err := r.WarmConnection(ctx); err != nil {
			t.Fatal(err)
		}
		close(release)
		wg.Wait()
		if n := headCalls.Load(); n != 1 {
			t.Errorf("headCalls = %d, want 1", n)
		}
	})

	t.Run("no_token_sends_no_request", func(t *testing.T) {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			w.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(srv.Close)

		r := NewHTTPRunner(HTTPOptions{
			BaseURL: srv.URL,
			Tokens:  &fakeTokens{err: errors.Join(ErrNoToken, errors.New("logged out"))},
		})
		t.Cleanup(r.Close)

		if err := r.WarmConnection(ctx); !errors.Is(err, ErrNoToken) {
			t.Fatalf("err = %v, want ErrNoToken", err)
		}
		if n := calls.Load(); n != 0 {
			t.Errorf("HTTP calls = %d, want 0", n)
		}
	})
}

type warmerFakeRunner struct {
	*fakeRunner
	warmed atomic.Int32
	ch     chan struct{}
}

func (w *warmerFakeRunner) WarmConnection(context.Context) error {
	w.warmed.Add(1)
	if w.ch != nil {
		select {
		case w.ch <- struct{}{}:
		default:
		}
	}
	return nil
}

func TestPresenceChangedWarmConnection(t *testing.T) {
	now := time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		from, to Presence
		authBad  bool
		paused   bool
		idle     bool
		stopped  bool
		wantWarm bool
	}{
		{"background to foreground warms", PresenceBackground, PresenceForeground, false, false, false, false, true},
		{"none to foreground warms", PresenceNone, PresenceForeground, false, false, false, false, true},
		{"none to background does not warm", PresenceNone, PresenceBackground, false, false, false, false, false},
		{"foreground to background does not warm", PresenceForeground, PresenceBackground, false, false, false, false, false},
		{"unauthenticated does not warm", PresenceBackground, PresenceForeground, true, false, false, false, false},
		{"paused does not warm", PresenceBackground, PresenceForeground, false, true, false, false, false},
		{"idle does not warm", PresenceBackground, PresenceForeground, false, false, true, false, false},
		{"stopped does not warm", PresenceBackground, PresenceForeground, false, false, false, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := &warmerFakeRunner{fakeRunner: &fakeRunner{}, ch: make(chan struct{}, 2)}
			opts := testOptions(openTestDB(t), w, nil)
			opts.Now = func() time.Time { return now }
			if tt.idle {
				opts.Config = func() Config { return Config{PollInterval: time.Minute, Dashboards: false} }
			}
			s, err := New(context.Background(), opts)
			if err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			s.authBad = tt.authBad
			if tt.paused {
				s.pauseUntil = now.Add(time.Minute)
				s.pauseErr = ErrRateLimited
			}
			if tt.stopped {
				s.stopped = context.Canceled
			}
			s.mu.Unlock()

			s.PresenceChanged(tt.from, tt.to)

			if tt.wantWarm {
				select {
				case <-w.ch:
				case <-time.After(2 * time.Second):
					t.Fatal("WarmConnection was not called")
				}
				if got := w.warmed.Load(); got != 1 {
					t.Errorf("warmed = %d, want 1", got)
				}
			} else {
				time.Sleep(30 * time.Millisecond)
				if got := w.warmed.Load(); got != 0 {
					t.Errorf("warmed = %d, want 0", got)
				}
			}
		})
	}
}
