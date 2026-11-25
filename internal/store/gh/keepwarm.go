package gh

import (
	"context"
	"io"
	"net/http"
	"net/http/httptrace"
	"sync/atomic"
	"time"
)

// ConnectionWarmer is an optional interface implemented by runners that pool persistent
// connections (HTTPRunner). The store invokes it asynchronously on presence rise to
// foreground so TCP+TLS+HTTP/2 handshake latency overlaps with pollDebounce or the
// user's first interactive click.
type ConnectionWarmer interface {
	WarmConnection(ctx context.Context) error
}

// runnerCloser is an optional lifecycle hook implemented by runners that own background
// goroutines or persistent transports (HTTPRunner). Store.Run calls Close when it exits.
type runnerCloser interface {
	Close()
}

var (
	_ ConnectionWarmer = (*HTTPRunner)(nil)
	_ runnerCloser     = (*HTTPRunner)(nil)
)

const (
	// warmTimeout bounds one best-effort connection pre-warm request.
	warmTimeout = 5 * time.Second
	// warmFreshWindow skips warming when a connection succeeded recently (after any
	// system wake), since the HTTP/2 pool still holds a live connection until
	// idleConnTimeout (25s).
	warmFreshWindow = 15 * time.Second
	// warmCooldown caps pre-warm attempts across rapid presence toggles (e.g. fast
	// window focus/blur) so at most one warm-up runs per window.
	warmCooldown = 20 * time.Second
	// bgRefreshRetry throttles retries of a failed soft-TTL background token refresh so
	// transient gh failures never spawn a subprocess on every request in [softTTL, TTL).
	bgRefreshRetry = 30 * time.Second
)

// recordConnUse notes that a request completed over the pooled transport at t.
func (r *HTTPRunner) recordConnUse(t time.Time) {
	r.mu.Lock()
	if t.After(r.lastConnAt) {
		r.lastConnAt = t
	}
	r.mu.Unlock()
}

// WarmConnection pre-warms the pooled HTTP/2 connection to GitHub with a zero-rate-limit
// HEAD /rate_limit request (0 body bytes, 0 core/GraphQL rate-limit points on GitHub).
// It is a no-op when the runner is closed, a warm-up is already in flight, a connection
// was used within warmFreshWindow (since the last wake), another warm-up ran within
// warmCooldown, or the current token is known rejected.
func (r *HTTPRunner) WarmConnection(ctx context.Context) error {
	r.mu.Lock()
	if r.closed || r.warming {
		r.mu.Unlock()
		return nil
	}
	now := r.opts.Now()
	if !r.lastConnAt.IsZero() && r.lastConnAt.After(r.lastWake) && now.Sub(r.lastConnAt) < warmFreshWindow {
		r.mu.Unlock()
		return nil
	}
	if !r.lastWarmAt.IsZero() && now.Sub(r.lastWarmAt) < warmCooldown {
		r.mu.Unlock()
		return nil
	}
	r.warming = true
	r.lastWarmAt = now
	r.bgWG.Add(1)
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.warming = false
		r.mu.Unlock()
		r.bgWG.Done()
	}()

	wctx, cancel := context.WithTimeout(ctx, warmTimeout)
	defer cancel()
	stopCancel := context.AfterFunc(r.bgCtx, cancel)
	defer stopCancel()

	tok, err := r.resolveToken(wctx, false)
	if err != nil {
		r.opts.Log.Debug("github warm connection skipped: token unavailable", "err", err)
		return err
	}
	if r.knownRejected(tok) {
		r.opts.Log.Debug("github warm connection skipped: token rejected")
		return nil
	}

	var reused atomic.Bool
	tctx := httptrace.WithClientTrace(wctx, &httptrace.ClientTrace{
		GotConn: func(i httptrace.GotConnInfo) { reused.Store(i.Reused) },
	})
	req, err := http.NewRequestWithContext(tctx, http.MethodHead, r.opts.BaseURL+"/rate_limit", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", r.opts.UserAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	start := r.opts.Now()
	resp, err := r.opts.Client.Do(req)
	if err != nil {
		r.opts.Log.Debug("github warm connection failed",
			"dur", r.opts.Now().Sub(start).Round(time.Millisecond).String(), "err", err)
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()

	end := r.opts.Now()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		r.recordConnUse(end)
	}
	r.opts.Log.Debug("github connection warmed", "status", resp.StatusCode,
		"dur", end.Sub(start).Round(time.Millisecond).String(),
		"reused_conn", reused.Load(), "proto", resp.Proto)
	return nil
}

// warmConnection triggers a best-effort asynchronous connection pre-warm tied to the
// store's lifetime when the runner implements ConnectionWarmer.
func (s *Store) warmConnection() {
	w, ok := s.opts.Runner.(ConnectionWarmer)
	if !ok {
		return
	}
	s.mu.Lock()
	if s.stopped != nil || s.warmClosing {
		s.mu.Unlock()
		return
	}
	baseCtx := s.warmCtx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	s.warmWG.Add(1)
	s.mu.Unlock()
	go func() {
		defer s.warmWG.Done()
		ctx, cancel := context.WithTimeout(baseCtx, warmTimeout)
		defer cancel()
		_ = w.WarmConnection(ctx)
	}()
}

// shutdownRunner cancels any in-flight warm-ups, closes runners implementing runnerCloser
// (HTTPRunner), and waits for warm goroutines to exit before Store.Run returns.
func (s *Store) shutdownRunner() {
	s.mu.Lock()
	s.warmClosing = true
	cancel := s.warmCancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if c, ok := s.opts.Runner.(runnerCloser); ok {
		c.Close()
	}
	s.warmWG.Wait()
}
