package gh

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestSleepJump(t *testing.T) {
	tests := []struct {
		name      string
		wallDelta time.Duration
		monoDelta time.Duration
		wantJump  bool
		wantDur   time.Duration
	}{
		{
			name: "normal awake tick", wallDelta: 5 * time.Second, monoDelta: 5 * time.Second,
			wantJump: false,
		},
		{
			name: "small NTP forward drift below skew threshold", wallDelta: 7 * time.Second, monoDelta: 5 * time.Second,
			wantJump: false,
		},
		{
			name: "NTP backward step never triggers", wallDelta: -30 * time.Second, monoDelta: 5 * time.Second,
			wantJump: false,
		},
		{
			name: "macOS sleep mono paused on tick", wallDelta: 5*time.Minute + 2*time.Second, monoDelta: 2 * time.Second,
			wantJump: true, wantDur: 5 * time.Minute,
		},
		{
			name: "macOS sleep mono paused before tick (opportunistic skew)", wallDelta: 30 * time.Second, monoDelta: 1 * time.Second,
			wantJump: true, wantDur: 29 * time.Second,
		},
		{
			name: "exact skew threshold triggers", wallDelta: 15 * time.Second, monoDelta: 5 * time.Second,
			wantJump: true, wantDur: 10 * time.Second,
		},
		{
			name: "busy worker slow tick without mono skew never triggers", wallDelta: 30 * time.Second, monoDelta: 30 * time.Second,
			wantJump: false,
		},
		{
			name: "long equal wall and mono does not trigger", wallDelta: 5 * time.Minute, monoDelta: 5 * time.Minute,
			wantJump: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotDur, gotJump := sleepJump(tt.wallDelta, tt.monoDelta)
			if gotJump != tt.wantJump || gotDur != tt.wantDur {
				t.Errorf("sleepJump(%v, %v) = (%v, %v), want (%v, %v)",
					tt.wallDelta, tt.monoDelta, gotDur, gotJump, tt.wantDur, tt.wantJump)
			}
		})
	}
}

func TestSleepDetectorNoDoubleFire(t *testing.T) {
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	cur := wakeSample{wall: t0, mono: t0}
	det := newSleepDetector(func() wakeSample { return cur })

	// Normal awake checkSkew does not fire.
	cur = wakeSample{wall: t0.Add(3 * time.Second), mono: t0.Add(3 * time.Second)}
	if _, ok := det.checkSkew(); ok {
		t.Fatal("unexpected wake while awake")
	}

	// Simulate macOS sleep: wall jumps +5m while mono only advances +2s.
	cur = wakeSample{wall: t0.Add(5*time.Minute + 2*time.Second), mono: t0.Add(2 * time.Second)}
	if jump, ok := det.checkSkew(); !ok || jump != 5*time.Minute {
		t.Fatalf("checkSkew = (%v, %v), want (5m, true)", jump, ok)
	}
	// Heartbeat tick 3s later must not double-fire.
	cur = wakeSample{wall: cur.wall.Add(3 * time.Second), mono: cur.mono.Add(3 * time.Second)}
	if jump, ok := det.checkTick(); ok {
		t.Fatalf("checkTick double-fired after checkSkew: jump=%v", jump)
	}

	// Slow awake period (equal wall and mono advance, e.g. busy worker executing a 30s
	// timeout) must NOT trigger wake on either checkSkew or checkTick.
	cur = wakeSample{wall: cur.wall.Add(30 * time.Second), mono: cur.mono.Add(30 * time.Second)}
	if _, ok := det.checkSkew(); ok {
		t.Fatal("checkSkew triggered without skew")
	}
	if jump, ok := det.checkTick(); ok {
		t.Fatalf("checkTick falsely triggered on busy worker without skew: jump=%v", jump)
	}
}

func TestBusyWorkerDoesNotTriggerWakeOrClearBackoff(t *testing.T) {
	t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	cur := wakeSample{wall: t0, mono: t0}
	now := t0

	runner := &dropperFakeRunner{fakeRunner: &fakeRunner{}}
	opts := testOptions(openTestDB(t), runner, nil)
	opts.Now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	opts.wake = &wakeConfig{
		sample: func() wakeSample {
			mu.Lock()
			defer mu.Unlock()
			return cur
		},
	}
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate active network backoff after consecutive timeouts.
	s.mu.Lock()
	s.pauseUntil = t0.Add(2 * time.Minute)
	s.pauseErr = ErrNetwork
	s.globalFailures = 4
	s.mu.Unlock()

	// Advance both wall and monotonic clocks by 30s (e.g., Store.Run was busy executing a
	// 30s timeout, NOT asleep).
	mu.Lock()
	cur = wakeSample{wall: t0.Add(30 * time.Second), mono: t0.Add(30 * time.Second)}
	now = cur.wall
	mu.Unlock()

	s.checkWakeTick()

	if drops := runner.drops.Load(); drops != 0 {
		t.Fatalf("CloseIdleConnections called %d times on busy tick, want 0", drops)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.globalFailures != 4 {
		t.Fatalf("globalFailures = %d, want 4 (must not reset without sleep skew)", s.globalFailures)
	}
	if s.pauseUntil.IsZero() || !errors.Is(s.pauseErr, ErrNetwork) {
		t.Fatalf("network pause was cleared on busy tick: pauseUntil=%v pauseErr=%v", s.pauseUntil, s.pauseErr)
	}
}

func TestIsMutationDoc(t *testing.T) {
	tests := []struct {
		name string
		doc  string
		want bool
	}{
		{"plain query", "query Viewer { viewer { login } }", false},
		{"shorthand query", "{ viewer { login } }", false},
		{"query mentioning mutation in comment", "# not a mutation\nquery Viewer { viewer { login } }", false},
		{"query mentioning mutation in string", `query Search { search(query: "mutation") { issueCount } }`, false},
		{"query with field named mutation", "query Q { node { mutation } }", false},
		{"plain mutation", "mutation Close($id: ID!) { closePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", true},
		{"mutation with leading comment", "# comment\n  mutation Foo { bar }", true},
		{"mutation after fragment", "fragment F on PullRequest { id }\nmutation Merge($id: ID!) { mergePullRequest(input: {pullRequestId: $id}) { pullRequest { ...F } } }", true},
		{"subscription", "subscription OnUpdate { updated }", true},
		{"test shorthand", "q", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isMutationDoc(tt.doc); got != tt.want {
				t.Errorf("isMutationDoc(%q) = %v, want %v", tt.doc, got, tt.want)
			}
		})
	}
	// Every embedded query agrees with isMutation.
	qs, err := loadQueries()
	if err != nil {
		t.Fatal(err)
	}
	for name, doc := range qs {
		if got, want := isMutationDoc(doc), isMutation(doc); got != want {
			t.Errorf("embedded query %s: isMutationDoc=%v, isMutation=%v", name, got, want)
		}
	}
}

func TestIsConnResetErr(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"EOF", io.EOF, true},
		{"wrapped EOF", fmt.Errorf("post: %w", io.EOF), true},
		{"unexpected EOF", io.ErrUnexpectedEOF, true},
		{"ECONNRESET", &net.OpError{Op: "read", Err: syscall.ECONNRESET}, true},
		{"EPIPE", &net.OpError{Op: "write", Err: syscall.EPIPE}, true},
		{"ECONNABORTED", &net.OpError{Op: "read", Err: syscall.ECONNABORTED}, true},
		{"net.ErrClosed", net.ErrClosed, true},
		{"http2 client conn lost", errors.New("http2: client connection lost"), true},
		{"http2 goaway", errors.New("http2: server sent GOAWAY and closed the connection"), true},
		{"ECONNREFUSED is not reset", &net.OpError{Op: "dial", Err: syscall.ECONNREFUSED}, false},
		{"context canceled", context.Canceled, false},
		{"deadline exceeded", context.DeadlineExceeded, false},
		{"generic error", errors.New("tls: bad certificate"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isConnResetErr(tt.err); got != tt.want {
				t.Errorf("isConnResetErr(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// halfOpenServer serves requests normally, except when dropsLeft > 0 on a matching
// connection (either reused-only or any connection) it hijacks and closes/RSTs the TCP
// socket before writing any HTTP response bytes.
type halfOpenServer struct {
	*httptest.Server
	mu         sync.Mutex
	seenConn   map[string]bool
	dropsLeft  int
	reusedOnly bool
	rst        bool
	dropped    atomic.Int32
	handled    atomic.Int32
}

func newHalfOpenServer(t *testing.T, rst bool, handle func(w http.ResponseWriter, r *http.Request, body []byte)) *halfOpenServer {
	t.Helper()
	hs := &halfOpenServer{seenConn: map[string]bool{}, rst: rst}
	hs.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		hs.mu.Lock()
		reused := hs.seenConn[r.RemoteAddr]
		hs.seenConn[r.RemoteAddr] = true
		drop := hs.dropsLeft > 0 && (!hs.reusedOnly || reused)
		if drop {
			hs.dropsLeft--
		}
		hs.mu.Unlock()
		if drop {
			hs.dropped.Add(1)
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					if hs.rst {
						if tc, ok := conn.(*net.TCPConn); ok {
							_ = tc.SetLinger(0)
						}
					}
					_ = conn.Close()
					return
				}
			}
		}
		hs.handled.Add(1)
		handle(w, r, b)
	}))
	t.Cleanup(hs.Close)
	return hs
}

func (hs *halfOpenServer) armDrop(n int, reusedOnly bool) {
	hs.mu.Lock()
	hs.dropsLeft = n
	hs.reusedOnly = reusedOnly
	hs.mu.Unlock()
}

func TestHTTPRunnerRetryOnStaleConnReset(t *testing.T) {
	ctx := context.Background()

	for _, tc := range []struct {
		name string
		rst  bool
	}{
		{"EOF", false},
		{"ECONNRESET", true},
	} {
		t.Run("graphql_read_retries_once_"+tc.name, func(t *testing.T) {
			hs := newHalfOpenServer(t, tc.rst, func(w http.ResponseWriter, r *http.Request, _ []byte) {
				serveViewer(w, r)
			})
			r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
			// Warm keep-alive pool.
			if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); err != nil {
				t.Fatal(err)
			}
			hs.armDrop(1, true)
			data, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil)
			if err != nil || len(data) == 0 {
				t.Fatalf("read after stale conn reset: data=%d err=%v, want success", len(data), err)
			}
			if hs.dropped.Load() != 1 || hs.handled.Load() != 2 {
				t.Errorf("dropped=%d handled=%d, want 1, 2", hs.dropped.Load(), hs.handled.Load())
			}
		})

		t.Run("rest_get_retries_once_"+tc.name, func(t *testing.T) {
			hs := newHalfOpenServer(t, tc.rst, func(w http.ResponseWriter, r *http.Request, _ []byte) {
				serveViewer(w, r)
			})
			r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
			if _, err := r.REST(ctx, "search/commits", nil); err != nil {
				t.Fatal(err)
			}
			hs.armDrop(1, true)
			if _, err := r.REST(ctx, "search/commits", nil); err != nil {
				t.Fatalf("REST GET after stale conn reset: err=%v, want nil", err)
			}
			if hs.dropped.Load() != 1 || hs.handled.Load() != 2 {
				t.Errorf("dropped=%d handled=%d, want 1, 2", hs.dropped.Load(), hs.handled.Load())
			}
		})

		t.Run("rest_raw_retries_once_"+tc.name, func(t *testing.T) {
			hs := newHalfOpenServer(t, tc.rst, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				w.Header().Set("Content-Type", "text/plain")
				_, _ = w.Write([]byte("diff"))
			})
			r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
			if _, err := r.RESTRaw(ctx, "repos/o/r/pulls/1", nil, "application/vnd.github.diff", 1024); err != nil {
				t.Fatal(err)
			}
			hs.armDrop(1, true)
			res, err := r.RESTRaw(ctx, "repos/o/r/pulls/1", nil, "application/vnd.github.diff", 1024)
			if err != nil || string(res.Body) != "diff" {
				t.Fatalf("RESTRaw after stale conn reset: res=%+v err=%v", res, err)
			}
			if hs.dropped.Load() != 1 || hs.handled.Load() != 2 {
				t.Errorf("dropped=%d handled=%d, want 1, 2", hs.dropped.Load(), hs.handled.Load())
			}
		})

		t.Run("auth_status_retries_once_"+tc.name, func(t *testing.T) {
			hs := newHalfOpenServer(t, tc.rst, func(w http.ResponseWriter, r *http.Request, _ []byte) {
				serveViewer(w, r)
			})
			r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
			if _, err := r.AuthStatus(ctx); err != nil {
				t.Fatal(err)
			}
			hs.armDrop(1, true)
			st, err := r.AuthStatus(ctx)
			if err != nil || !st.LoggedIn {
				t.Fatalf("AuthStatus after stale conn reset: st=%+v err=%v", st, err)
			}
		})
	}

	t.Run("graphql_mutation_never_retried", func(t *testing.T) {
		hs := newHalfOpenServer(t, true, func(w http.ResponseWriter, r *http.Request, _ []byte) {
			serveViewer(w, r)
		})
		r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		hs.armDrop(1, true)
		_, err := r.GraphQL(ctx, "mutation ClosePullRequest($id: ID!) { closePullRequest(input: {pullRequestId: $id}) { clientMutationId } }", map[string]any{"id": "PR_1"})
		if !errors.Is(err, ErrNetwork) {
			t.Fatalf("mutation err = %v, want ErrNetwork", err)
		}
		if hs.dropped.Load() != 1 || hs.handled.Load() != 1 {
			t.Errorf("mutation was retried! dropped=%d handled=%d, want 1, 1", hs.dropped.Load(), hs.handled.Load())
		}
	})

	t.Run("rest_write_never_retried", func(t *testing.T) {
		hs := newHalfOpenServer(t, true, func(w http.ResponseWriter, r *http.Request, _ []byte) {
			_, _ = w.Write([]byte(`{}`))
		})
		r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		if _, err := r.REST(ctx, "repos/o/r", nil); err != nil {
			t.Fatal(err)
		}
		hs.armDrop(1, true)
		_, err := r.RESTWrite(ctx, http.MethodDelete, "repos/o/r/git/refs/heads/feat", nil)
		if !errors.Is(err, ErrNetwork) {
			t.Fatalf("RESTWrite err = %v, want ErrNetwork", err)
		}
		if hs.dropped.Load() != 1 || hs.handled.Load() != 1 {
			t.Errorf("RESTWrite was retried! dropped=%d handled=%d, want 1, 1", hs.dropped.Load(), hs.handled.Load())
		}
	})

	t.Run("both_attempts_fail_returns_ErrNetwork_after_single_retry", func(t *testing.T) {
		hs := newHalfOpenServer(t, true, func(w http.ResponseWriter, r *http.Request, _ []byte) {
			serveViewer(w, r)
		})
		r := NewHTTPRunner(HTTPOptions{BaseURL: hs.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		// Drop both the reused attempt AND the fresh retry attempt.
		hs.armDrop(5, false)
		_, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil)
		if !errors.Is(err, ErrNetwork) {
			t.Fatalf("err = %v, want ErrNetwork", err)
		}
		if hs.dropped.Load() != 2 || hs.handled.Load() != 1 {
			t.Errorf("dropped=%d handled=%d, want 2 (1 initial + 1 retry), 1", hs.dropped.Load(), hs.handled.Load())
		}
	})

	t.Run("mid_body_reset_after_headers_never_retried", func(t *testing.T) {
		var calls atomic.Int32
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if calls.Add(1) == 1 {
				_, _ = w.Write(fixtureBytes("viewer.json"))
				return
			}
			// Send HTTP 200 headers with Content-Length larger than body, then reset socket.
			w.Header().Set("Content-Length", "1000")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"data":`))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
				}
			}
		}))
		defer srv.Close()
		r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); !errors.Is(err, ErrNetwork) {
			t.Fatalf("err = %v, want ErrNetwork", err)
		}
		if calls.Load() != 2 {
			t.Errorf("calls = %d, want 2 (no retry after headers arrived)", calls.Load())
		}
	})

	t.Run("wake_grace_retries_fresh_conn_for_reads_only", func(t *testing.T) {
		hs := newHalfOpenServer(t, true, func(w http.ResponseWriter, r *http.Request, _ []byte) {
			serveViewer(w, r)
		})
		now := time.Unix(1_800_000_000, 0)
		r := NewHTTPRunner(HTTPOptions{
			BaseURL: hs.URL,
			Tokens:  &fakeTokens{tokens: []string{"tok"}},
			Now:     func() time.Time { return now },
		})
		// Mark wake (arms wakeGraceWindow). Connection is NOT reused (fresh dial).
		r.CloseIdleConnections()
		hs.armDrop(1, false)
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); err != nil {
			t.Fatalf("read within wake grace failed: %v", err)
		}
		if hs.dropped.Load() != 1 || hs.handled.Load() != 1 {
			t.Errorf("dropped=%d handled=%d, want 1, 1", hs.dropped.Load(), hs.handled.Load())
		}
		// Mutation within wake grace is STILL never retried.
		r.CloseIdleConnections()
		hs.armDrop(1, false)
		if _, err := r.GraphQL(ctx, "mutation Close($id: ID!) { closePullRequest(input:{pullRequestId:$id}) { clientMutationId } }", map[string]any{"id": "PR_1"}); !errors.Is(err, ErrNetwork) {
			t.Fatalf("mutation within wake grace: err = %v, want ErrNetwork", err)
		}
		if hs.handled.Load() != 1 {
			t.Errorf("mutation within wake grace was retried: handled=%d", hs.handled.Load())
		}
		// Past wake grace window, non-reused connection reset is NOT retried.
		now = now.Add(wakeGraceWindow + time.Second)
		r.opts.Client.CloseIdleConnections()
		hs.armDrop(1, false)
		if _, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil); !errors.Is(err, ErrNetwork) {
			t.Fatalf("read past wake grace on fresh conn: err = %v, want ErrNetwork", err)
		}
	})
}

// TestStoreDeadKeepAliveNoNetworkPause verifies end-to-end with a real HTTPRunner that a
// half-open keep-alive reset on a GraphQL read retries transparently on a fresh socket
// with zero errors and zero 15-second global network pause.
func TestStoreDeadKeepAliveNoNetworkPause(t *testing.T) {
	for _, tc := range []struct {
		name string
		rst  bool
	}{
		{"EOF_half_open", false},
		{"ECONNRESET_half_open", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hs := newHalfOpenServer(t, tc.rst, func(w http.ResponseWriter, r *http.Request, body []byte) {
				var payload struct {
					Query string `json:"query"`
				}
				_ = json.Unmarshal(body, &payload)
				if m := opRE.FindStringSubmatch(payload.Query); m != nil && m[1] == "PullRequest" {
					_, _ = w.Write(fixtureBytes("pull_request_14586_page1.json"))
					return
				}
				_, _ = w.Write(fixtureBytes("viewer.json"))
			})
			runner := NewHTTPRunner(HTTPOptions{
				BaseURL: hs.URL,
				Tokens:  &fakeTokens{tokens: []string{"tok"}},
			})
			opts := testOptions(openTestDB(t), runner, nil)
			opts.MinGap = time.Millisecond
			opts.NetworkBackoff = DefaultNetworkBackoff
			opts.MaxBackoff = DefaultMaxBackoff
			opts.PollInterval = 5 * time.Minute
			s := startStore(t, opts)

			waitFor(t, "initial poll", func() bool { return hs.handled.Load() >= 1 })
			hs.armDrop(1, true)

			ctx := context.Background()
			t1 := time.Now()
			_, err1 := s.PullRequest(ctx, "o/r", 101)
			d1 := time.Since(t1)

			s.mu.Lock()
			pauseUntil := s.pauseUntil
			s.mu.Unlock()

			t2 := time.Now()
			_, err2 := s.PullRequest(ctx, "o/r", 102)
			d2 := time.Since(t2)

			t.Logf("AFTER [%s]: dropped=%d | read1_err=%v dur=%v | pause_set=%v | read2_err=%v dur=%v | handled=%d",
				tc.name, hs.dropped.Load(), err1, d1.Round(time.Microsecond), !pauseUntil.IsZero(),
				err2, d2.Round(time.Microsecond), hs.handled.Load())

			if err1 != nil {
				t.Fatalf("read1 failed: %v", err1)
			}
			if !pauseUntil.IsZero() {
				t.Fatalf("unexpected network pause until %v", pauseUntil)
			}
			if err2 != nil {
				t.Fatalf("read2 failed: %v", err2)
			}
			if hs.dropped.Load() != 1 {
				t.Errorf("dropped = %d, want 1", hs.dropped.Load())
			}
		})
	}
}

type dropperFakeRunner struct {
	*fakeRunner
	drops atomic.Int32
}

func (d *dropperFakeRunner) CloseIdleConnections() { d.drops.Add(1) }

func TestStoreWakeRecovery(t *testing.T) {
	t.Run("drops_conns_clears_network_pause_and_polls_foreground", func(t *testing.T) {
		g := newFakeGitHub()
		g.setRepo("o/r", &fakeRepo{branch: "main", sha: "s1"})
		f := &dropperFakeRunner{fakeRunner: (&fakeRunner{}).serve(g)}

		t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
		var sampleMu sync.Mutex
		cur := wakeSample{wall: t0, mono: t0}
		ticks := make(chan time.Time, 1)

		opts := testOptions(openTestDB(t), f, nil)
		opts.PollInterval = 5 * time.Minute
		opts.NetworkBackoff = DefaultNetworkBackoff
		opts.MaxBackoff = DefaultMaxBackoff
		opts.Presence = func() Presence { return PresenceForeground }
		opts.wake = &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		}
		s := startStore(t, opts)
		waitFor(t, "initial poll", func() bool { return f.count("Poll") == 1 })

		// Simulate a transient network pause triggered right as laptop slept.
		s.mu.Lock()
		s.pauseUntil = s.opts.Now().Add(DefaultNetworkBackoff)
		s.pauseErr = ErrNetwork
		s.globalFailures = 2
		s.mu.Unlock()

		// Simulate a 5-minute macOS sleep (wall +5m, mono +2s) and deliver one heartbeat tick.
		sampleMu.Lock()
		cur = wakeSample{wall: t0.Add(5*time.Minute + 2*time.Second), mono: t0.Add(2 * time.Second)}
		sampleMu.Unlock()
		ticks <- cur.wall

		waitFor(t, "immediate post-wake poll", func() bool { return f.count("Poll") >= 2 })
		if drops := f.drops.Load(); drops != 1 {
			t.Errorf("CloseIdleConnections calls = %d, want 1", drops)
		}
		s.mu.Lock()
		paused := s.pausedLocked()
		s.mu.Unlock()
		if paused != nil {
			t.Errorf("stale network pause not cleared: %v", paused)
		}
		// Subsequent interactive read succeeds cleanly.
		g.addPR(fakePR("PR_99", "o/r", 99, time.Now()), sectionAuthored)
		if _, err := s.FullPullRequest(context.Background(), "o/r", 99, true); err != nil {
			t.Fatalf("post-wake interactive read failed: %v", err)
		}
		t.Logf("AFTER [wake_jump]: drops=%d polls=%d pause=%v post_wake_read_err=<nil>",
			f.drops.Load(), f.count("Poll"), paused)
	})

	t.Run("preserves_rate_limit_pause_across_wake", func(t *testing.T) {
		g := newFakeGitHub()
		f := &dropperFakeRunner{fakeRunner: (&fakeRunner{}).serve(g)}
		t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
		var sampleMu sync.Mutex
		cur := wakeSample{wall: t0, mono: t0}
		ticks := make(chan time.Time, 1)

		opts := testOptions(openTestDB(t), f, nil)
		opts.PollInterval = 5 * time.Minute
		opts.wake = &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		}
		s := startStore(t, opts)
		waitFor(t, "initial poll", func() bool { return f.count("Poll") == 1 })

		// Active rate-limit pause still 10 minutes in the future.
		rlErr := &RateLimitError{Secondary: true, Msg: "secondary rate limit"}
		s.mu.Lock()
		s.pauseUntil = s.opts.Now().Add(10 * time.Minute)
		s.pauseErr = rlErr
		s.mu.Unlock()

		sampleMu.Lock()
		cur = wakeSample{wall: t0.Add(2 * time.Minute), mono: t0.Add(2 * time.Second)}
		sampleMu.Unlock()
		ticks <- cur.wall

		waitFor(t, "CloseIdleConnections on wake", func() bool { return f.drops.Load() == 1 })
		time.Sleep(50 * time.Millisecond)
		if n := f.count("Poll"); n != 1 {
			t.Errorf("polls = %d, want 1 (rate-limit pause must not be bypassed)", n)
		}
		if _, err := s.PullRequest(context.Background(), "o/r", 1); !errors.Is(err, ErrRateLimited) {
			t.Errorf("read during rate-limit pause after wake: err = %v, want ErrRateLimited", err)
		}
	})

	t.Run("preserves_auth_pause_across_wake", func(t *testing.T) {
		f := &dropperFakeRunner{fakeRunner: &fakeRunner{}}
		f.set(func(string, map[string]any) (json.RawMessage, error) {
			return nil, fmt.Errorf("%w: Bad credentials (HTTP 401)", ErrNotAuthenticated)
		})
		f.auth = func() (AuthStatus, error) { return AuthStatus{Error: "Bad credentials"}, nil }
		t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
		var sampleMu sync.Mutex
		cur := wakeSample{wall: t0, mono: t0}
		ticks := make(chan time.Time, 1)

		opts := testOptions(openTestDB(t), f, nil)
		opts.AuthRetry = time.Hour
		opts.MaxBackoff = time.Hour
		opts.wake = &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		}
		s := startStore(t, opts)
		waitFor(t, "auth paused", func() bool { return !s.Snapshot().Viewer.Authenticated })
		_, authBefore := f.snapshot()

		sampleMu.Lock()
		cur = wakeSample{wall: t0.Add(2 * time.Minute), mono: t0.Add(2 * time.Second)}
		sampleMu.Unlock()
		ticks <- cur.wall

		waitFor(t, "CloseIdleConnections on wake", func() bool { return f.drops.Load() == 1 })
		time.Sleep(50 * time.Millisecond)
		_, authAfter := f.snapshot()
		s.mu.Lock()
		authBad := s.authBad
		s.mu.Unlock()
		if !authBad || authAfter != authBefore {
			t.Errorf("authBad=%v authCalls=%d->%d, want auth pause preserved", authBad, authBefore, authAfter)
		}
	})

	t.Run("background_presence_does_not_force_poll_on_wake", func(t *testing.T) {
		g := newFakeGitHub()
		f := &dropperFakeRunner{fakeRunner: (&fakeRunner{}).serve(g)}
		t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
		var sampleMu sync.Mutex
		cur := wakeSample{wall: t0, mono: t0}
		ticks := make(chan time.Time, 1)

		opts := testOptions(openTestDB(t), f, nil)
		opts.PollInterval = 5 * time.Minute
		opts.Presence = func() Presence { return PresenceBackground }
		opts.wake = &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		}
		_ = startStore(t, opts)
		waitFor(t, "initial poll", func() bool { return f.count("Poll") == 1 })

		sampleMu.Lock()
		cur = wakeSample{wall: t0.Add(2 * time.Minute), mono: t0.Add(2 * time.Second)}
		sampleMu.Unlock()
		ticks <- cur.wall

		waitFor(t, "CloseIdleConnections on wake", func() bool { return f.drops.Load() == 1 })
		time.Sleep(50 * time.Millisecond)
		if n := f.count("Poll"); n != 1 {
			t.Errorf("background wake polls = %d, want 1", n)
		}
	})

	t.Run("opportunistic_skew_clears_net_pause_before_tick", func(t *testing.T) {
		g := newFakeGitHub()
		g.addPR(fakePR("PR_7", "o/r", 7, time.Now()), sectionAuthored)
		f := &dropperFakeRunner{fakeRunner: (&fakeRunner{}).serve(g)}
		t0 := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
		var sampleMu sync.Mutex
		cur := wakeSample{wall: t0, mono: t0}
		ticks := make(chan time.Time) // never fires

		opts := testOptions(openTestDB(t), f, nil)
		opts.PollInterval = 5 * time.Minute
		opts.wake = &wakeConfig{
			tickInterval: 5 * time.Second,
			ticks:        ticks,
			sample: func() wakeSample {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				return cur
			},
		}
		s := startStore(t, opts)
		waitFor(t, "initial poll", func() bool { return f.count("Poll") == 1 })

		// Pre-sleep network pause.
		s.mu.Lock()
		s.pauseUntil = s.opts.Now().Add(DefaultNetworkBackoff)
		s.pauseErr = ErrNetwork
		s.mu.Unlock()

		// Laptop wakes; user clicks before any heartbeat tick arrives.
		sampleMu.Lock()
		cur = wakeSample{wall: t0.Add(3 * time.Minute), mono: t0.Add(1 * time.Second)}
		sampleMu.Unlock()

		if _, err := s.FullPullRequest(context.Background(), "o/r", 7, true); err != nil {
			t.Fatalf("interactive read immediately on lid-open failed: %v", err)
		}
		if f.drops.Load() != 1 {
			t.Errorf("CloseIdleConnections calls = %d, want 1", f.drops.Load())
		}
	})
}
