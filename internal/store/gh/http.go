package gh

import (
	"bytes"
	"cmp"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultAPIURL is github.com's API root. GitHub Enterprise Server is out of scope.
const DefaultAPIURL = "https://api.github.com"

// DefaultCallTimeout bounds one request, including reading the body. GitHub abandons
// GraphQL queries after ~10s of server time (HTTP 502), so 30s means the network is
// stuck.
const DefaultCallTimeout = 30 * time.Second

// DefaultTokenTTL is how long a resolved token is used before `gh auth token` is asked
// again, so `gh auth switch` or `gh auth login` as someone else is picked up without a
// 401 (the previous token usually stays valid).
const DefaultTokenTTL = 15 * time.Minute

// maxBody caps a response body. The largest real responses (a 100-check PR page) are a
// few hundred KiB.
const maxBody = 32 << 20

// HTTPOptions configures an HTTPRunner. Zero values take the defaults.
type HTTPOptions struct {
	// BaseURL is the API root without a trailing slash; DefaultAPIURL when empty.
	BaseURL string
	// Tokens resolves the token; GhToken{} (gh from $PATH or Homebrew) when nil.
	Tokens TokenSource
	// Client sends requests; a keep-alive client from newHTTPClient when nil.
	Client *http.Client
	// Timeout bounds each request; DefaultCallTimeout when zero.
	Timeout time.Duration
	// TokenTTL is how long a token is reused; DefaultTokenTTL when zero.
	TokenTTL time.Duration
	// TokenSoftTTL is when HTTPRunner starts a background token refresh while still
	// returning the cached token immediately. Zero defaults to 4/5 of TokenTTL (12m
	// for DefaultTokenTTL); negative or >= TokenTTL disables background refresh.
	TokenSoftTTL time.Duration
	// UserAgent identifies the daemon to GitHub; "code-foundry" when empty.
	UserAgent string
	Log       *slog.Logger
	// Now is injectable for tests.
	Now func() time.Time
}

// HTTPRunner talks to GitHub's GraphQL and REST APIs over one long-lived HTTP client,
// with the token gh resolves. It implements Runner and RESTRunner. Safe for concurrent
// use, although the store calls it from its single worker.
type HTTPRunner struct {
	opts HTTPOptions

	mu      sync.Mutex
	token   string
	tokenAt time.Time
	// refreshing is true while a single soft-TTL background token refresh is in flight.
	refreshing bool
	// refreshFailAt throttles retries after a failed background refresh until hard TTL.
	refreshFailAt time.Time
	// tokenGen increments on every synchronous token update or clear so an older
	// in-flight background refresh never overwrites a newer synchronous resolution.
	tokenGen uint64
	// rejected is the last token GitHub answered 401 to, at rejectedAt: AuthStatus
	// does not ask GitHub about it again until rejectedRecheck has passed.
	rejected   string
	rejectedAt time.Time
	// lastWake is when CloseIdleConnections was last called on system wake (sleepwake.go).
	lastWake time.Time
	// Keep-warm state (keepwarm.go).
	lastConnAt time.Time
	lastWarmAt time.Time
	warming    bool
	// bgCtx/bgCancel/bgWG bound and drain background token refreshes and warm-ups on Close.
	bgCtx    context.Context
	bgCancel context.CancelFunc
	bgWG     sync.WaitGroup
	closed   bool
}

// rejectedRecheck is how long AuthStatus trusts GitHub's 401 for a token before asking
// about the same token again (a different token is asked about at once).
const rejectedRecheck = 15 * time.Minute

// noteAnswer remembers whether GitHub rejected tok (status 401).
func (r *HTTPRunner) noteAnswer(tok string, status int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case status == http.StatusUnauthorized:
		r.rejected, r.rejectedAt = tok, r.opts.Now()
	case tok == r.rejected && status >= 200 && status < 300:
		r.rejected = ""
	}
}

// knownRejected reports whether GitHub rejected tok within rejectedRecheck.
func (r *HTTPRunner) knownRejected(tok string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return tok == r.rejected && r.opts.Now().Sub(r.rejectedAt) < rejectedRecheck
}

var (
	_ Runner     = (*HTTPRunner)(nil)
	_ RESTRunner = (*HTTPRunner)(nil)
)

// NewHTTPRunner returns a runner; the token is resolved on first use.
func NewHTTPRunner(o HTTPOptions) *HTTPRunner {
	o.BaseURL = strings.TrimSuffix(cmp.Or(o.BaseURL, DefaultAPIURL), "/")
	if o.Tokens == nil {
		o.Tokens = GhToken{}
	}
	if o.Client == nil {
		o.Client = newHTTPClient()
	}
	if o.Timeout <= 0 {
		o.Timeout = DefaultCallTimeout
	}
	if o.TokenTTL <= 0 {
		o.TokenTTL = DefaultTokenTTL
	}
	switch {
	case o.TokenSoftTTL == 0:
		o.TokenSoftTTL = o.TokenTTL * 4 / 5
	case o.TokenSoftTTL < 0 || o.TokenSoftTTL > o.TokenTTL:
		o.TokenSoftTTL = o.TokenTTL
	}
	o.UserAgent = cmp.Or(o.UserAgent, "code-foundry")
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	bgCtx, bgCancel := context.WithCancel(context.Background())
	return &HTTPRunner{
		opts:     o,
		bgCtx:    bgCtx,
		bgCancel: bgCancel,
	}
}

// Close cancels any in-flight background token refresh or connection warm-up, waits for
// them to finish, and drops idle HTTP connections. Safe to call multiple times.
func (r *HTTPRunner) Close() {
	r.mu.Lock()
	r.closed = true
	r.mu.Unlock()
	r.bgCancel()
	r.bgWG.Wait()
	r.opts.Client.CloseIdleConnections()
}

// idleConnTimeout drops our idle connections before GitHub does. api.github.com closes
// an HTTP/2 connection after ~30s idle (measured 2026-10: reused after 28s, new after
// 31s; re-verified 2026-11: even with HTTP/2 PINGs at 15s and 20s ACKed by GitHub,
// api.github.com still sends GOAWAY NO_ERROR and closes the connection ~30-32s after
// the last HTTP stream, see docs/notes/perf-gh-http2-keepwarm.md). Keeping 25s avoids
// racing the server's close while WarmConnection (keepwarm.go) pre-warms on foreground
// presence rise.
const idleConnTimeout = 25 * time.Second

// newHTTPClient keeps connections to api.github.com alive between the requests of a
// poll. The store sends one request at a time, so a couple of idle connections is
// plenty.
func newHTTPClient() *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = 4
	t.MaxIdleConnsPerHost = 2
	t.IdleConnTimeout = idleConnTimeout
	t.TLSHandshakeTimeout = 10 * time.Second
	t.ResponseHeaderTimeout = DefaultCallTimeout
	t.ExpectContinueTimeout = 0
	t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	t.ForceAttemptHTTP2 = true
	// Timeouts are per request (context), so the client itself has none.
	return &http.Client{Transport: t}
}

// graphQLRequest is the POST /graphql body.
type graphQLRequest struct {
	Query     string         `json:"query"`
	Variables map[string]any `json:"variables,omitempty"`
}

// GraphQL implements Runner. Nil variables are omitted, as the query declares them
// optional.
func (r *HTTPRunner) GraphQL(ctx context.Context, query string, vars map[string]any) (json.RawMessage, error) {
	req := graphQLRequest{Query: query}
	for k, v := range vars {
		if v == nil {
			continue
		}
		if req.Variables == nil {
			req.Variables = map[string]any{}
		}
		req.Variables[k] = v
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("github graphql: encode request: %w", err)
	}
	res, err := r.do(ctx, http.MethodPost, r.opts.BaseURL+"/graphql", body, sendOpts{idempotent: !isMutationDoc(query)})
	if err != nil {
		return nil, err
	}
	return parseGraphQLResponse(res)
}

// REST implements RESTRunner: GET <BaseURL>/<path>?<params>.
func (r *HTTPRunner) REST(ctx context.Context, path string, params map[string]string) (json.RawMessage, error) {
	res, err := r.do(ctx, http.MethodGet, r.restURL(path, params), nil, sendOpts{idempotent: true})
	if err != nil {
		return nil, err
	}
	if !res.ok() {
		return nil, classifyHTTP(res)
	}
	return res.body, nil
}

// restURL is <BaseURL>/<path>?<params>.
func (r *HTTPRunner) restURL(path string, params map[string]string) string {
	u := r.opts.BaseURL + "/" + strings.TrimPrefix(path, "/")
	if len(params) > 0 {
		q := url.Values{}
		for k, v := range params {
			q.Set(k, v)
		}
		u += "?" + q.Encode()
	}
	return u
}

// AuthStatus implements Runner. It resolves the token afresh and validates it with
// GET /user (one REST core point; GraphQL's budget is untouched), except a token GitHub
// rejected within rejectedRecheck, which is reported rejected without a request. A
// missing or rejected token is reported in AuthStatus, not as an error; transport
// failures are errors.
func (r *HTTPRunner) AuthStatus(ctx context.Context) (AuthStatus, error) {
	tok, err := r.resolveToken(ctx, true)
	if err != nil {
		if errors.Is(err, ErrNoToken) {
			return AuthStatus{Error: err.Error()}, nil
		}
		return AuthStatus{}, err
	}
	if r.knownRejected(tok) {
		return AuthStatus{Error: "GitHub rejected the token gh has (gh auth login replaces it)"}, nil
	}
	res, err := r.send(ctx, http.MethodGet, r.opts.BaseURL+"/user", nil, tok, sendOpts{idempotent: true})
	if err != nil {
		return AuthStatus{}, err
	}
	r.noteAnswer(tok, res.status)
	switch {
	case res.status == http.StatusUnauthorized:
		return AuthStatus{Error: httpMessage(res)}, nil
	case !res.ok():
		return AuthStatus{}, classifyHTTP(res)
	}
	var u struct {
		Login string `json:"login"`
	}
	if err := json.Unmarshal(res.body, &u); err != nil || u.Login == "" {
		return AuthStatus{}, fmt.Errorf("github: decode /user: %w", cmp.Or(err, errors.New("no login")))
	}
	return AuthStatus{LoggedIn: true, Login: u.Login}, nil
}

// do sends a request with the cached token. On 401 it resolves the token again and,
// when gh now has a different one, retries once. A token that cannot be resolved is
// ErrNotAuthenticated.
func (r *HTTPRunner) do(ctx context.Context, method, u string, body []byte, o sendOpts) (httpResult, error) {
	tok, err := r.resolveToken(ctx, false)
	if err != nil {
		return httpResult{}, notAuthenticated(err)
	}
	res, err := r.send(ctx, method, u, body, tok, o)
	if err == nil {
		r.noteAnswer(tok, res.status)
	}
	if err != nil || res.status != http.StatusUnauthorized {
		return res, err
	}
	fresh, err := r.resolveToken(ctx, true)
	if err != nil {
		return httpResult{}, notAuthenticated(err)
	}
	if fresh == tok {
		r.opts.Log.Debug("github rejected the token; gh has no other", "status", res.status)
		return res, nil
	}
	r.opts.Log.Info("github rejected the token; retrying with the one gh has now")
	res, err = r.send(ctx, method, u, body, fresh, o)
	if err == nil {
		r.noteAnswer(fresh, res.status)
	}
	return res, err
}

func notAuthenticated(err error) error {
	if errors.Is(err, ErrNoToken) {
		return fmt.Errorf("%w: %w", ErrNotAuthenticated, err)
	}
	return err
}

// resolveToken returns the cached token, or asks the TokenSource when there is none,
// it is older than TokenTTL, or force is set. When a cached token is still within
// TokenTTL but at or past TokenSoftTTL, the cached token is returned immediately while
// at most one background goroutine refreshes it off the request path.
func (r *HTTPRunner) resolveToken(ctx context.Context, force bool) (string, error) {
	r.mu.Lock()
	now := r.opts.Now()
	if !force && r.token != "" {
		age := now.Sub(r.tokenAt)
		if age < r.opts.TokenTTL {
			tok := r.token
			if age >= r.opts.TokenSoftTTL && !r.refreshing && !r.closed &&
				(r.refreshFailAt.IsZero() || now.Sub(r.refreshFailAt) >= bgRefreshRetry) {
				r.refreshing = true
				gen := r.tokenGen
				r.bgWG.Add(1)
				go r.refreshTokenBackground(gen)
			}
			r.mu.Unlock()
			return tok, nil
		}
	}
	gen := r.tokenGen
	r.mu.Unlock()

	start := now
	tok, err := r.opts.Tokens.Token(ctx)
	end := r.opts.Now()
	r.opts.Log.Debug("github token resolved", "dur", end.Sub(start).Round(time.Millisecond).String(),
		"forced", force, "err", err)

	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		if r.tokenGen == gen {
			r.token = ""
			r.tokenGen++
		}
		return "", err
	}
	r.token, r.tokenAt = tok, end
	r.tokenGen++
	r.refreshFailAt = time.Time{}
	return tok, nil
}

// refreshTokenBackground refreshes the cached token off the request path. On error the
// still-valid cached token is preserved until TokenTTL expires; if a synchronous
// resolution happened meanwhile (tokenGen changed) the stale result is discarded.
func (r *HTTPRunner) refreshTokenBackground(gen uint64) {
	defer r.bgWG.Done()
	ctx, cancel := context.WithTimeout(r.bgCtx, DefaultTokenTimeout)
	defer cancel()

	start := r.opts.Now()
	tok, err := r.opts.Tokens.Token(ctx)
	end := r.opts.Now()

	r.mu.Lock()
	defer r.mu.Unlock()
	r.refreshing = false
	if err != nil {
		r.refreshFailAt = end
		r.opts.Log.Debug("github background token refresh failed",
			"dur", end.Sub(start).Round(time.Millisecond).String(), "err", err)
		return
	}
	if r.tokenGen != gen {
		r.opts.Log.Debug("github background token refresh discarded",
			"dur", end.Sub(start).Round(time.Millisecond).String())
		return
	}
	changed := tok != r.token
	r.token, r.tokenAt = tok, end
	r.tokenGen++
	r.refreshFailAt = time.Time{}
	r.opts.Log.Debug("github token refreshed in background",
		"dur", end.Sub(start).Round(time.Millisecond).String(), "changed", changed)
}

// httpResult is a completed HTTP exchange.
type httpResult struct {
	status int
	header http.Header
	body   []byte
	// truncated: the body was longer than sendOpts.limit, and body holds the first
	// limit bytes.
	truncated bool
}

// sendOpts varies a request from the JSON default.
type sendOpts struct {
	// accept is the Accept header; application/vnd.github+json when empty.
	accept string
	// limit caps the body read (maxBody when zero); a longer body sets truncated.
	limit int64
	// idempotent marks read-only requests (GraphQL queries, REST GET) that are safe to
	// retry once on a fresh connection when a pooled or post-wake socket resets before
	// any response arrives. Mutations and REST writes leave this false.
	idempotent bool
}

func (h httpResult) ok() bool { return h.status >= 200 && h.status < 300 }

// send performs one request within Timeout, retrying once on a fresh connection for
// read-only requests that fail before any response arrives due to a stale/reset socket.
// Transport failures are ErrNetwork, except cancellation of ctx itself, which is
// returned as is.
func (r *HTTPRunner) send(ctx context.Context, method, u string, body []byte, tok string, o sendOpts) (httpResult, error) {
	res, err, retry := r.sendOnce(ctx, method, u, body, tok, o, true)
	if retry {
		r.opts.Client.CloseIdleConnections()
		res, err, _ = r.sendOnce(ctx, method, u, body, tok, o, false)
	}
	return res, err
}

func (r *HTTPRunner) sendOnce(ctx context.Context, method, u string, body []byte, tok string, o sendOpts, allowRetry bool) (httpResult, error, bool) {
	cctx, cancel := context.WithTimeout(ctx, r.opts.Timeout)
	defer cancel()
	var reused, gotFirstByte atomic.Bool
	cctx = httptrace.WithClientTrace(cctx, &httptrace.ClientTrace{
		GotConn:              func(i httptrace.GotConnInfo) { reused.Store(i.Reused) },
		GotFirstResponseByte: func() { gotFirstByte.Store(true) },
	})
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(cctx, method, u, rd)
	if err != nil {
		return httpResult{}, fmt.Errorf("github: build request: %w", err), false
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", r.opts.UserAgent)
	req.Header.Set("Accept", cmp.Or(o.accept, "application/vnd.github+json"))
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	start := r.opts.Now()
	resp, err := r.opts.Client.Do(req)
	limit := cmp.Or(o.limit, maxBody)
	var b []byte
	if err == nil {
		b, err = io.ReadAll(io.LimitReader(resp.Body, limit+1)) // one more byte tells a longer body
		resp.Body.Close()
	}
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return httpResult{}, fmt.Errorf("github request: %w", cerr), false
		}
		if allowRetry && resp == nil && r.shouldRetryConnReset(o.idempotent, reused.Load(), gotFirstByte.Load(), r.opts.Now(), err) {
			r.opts.Log.Debug("github http retrying read after connection reset",
				"method", method, "path", req.URL.Path, "reused_conn", reused.Load(), "err", err)
			return httpResult{}, nil, true
		}
		return httpResult{}, fmt.Errorf("%w: %w", ErrNetwork, err), false
	}
	end := r.opts.Now()
	r.recordConnUse(end)
	h := resp.Header
	r.opts.Log.Debug("github http", "method", method, "path", req.URL.Path, "status", resp.StatusCode,
		"dur", end.Sub(start).Round(time.Millisecond).String(), "reused_conn", reused.Load(),
		"proto", resp.Proto, "bytes", len(b),
		"rl_resource", h.Get("X-Ratelimit-Resource"), "rl_remaining", h.Get("X-Ratelimit-Remaining"))
	res := httpResult{status: resp.StatusCode, header: h, body: b}
	if int64(len(b)) > limit {
		res.body, res.truncated = b[:limit], true
	}
	return res, nil, false
}

// parseGraphQLResponse turns a /graphql response into data or a classified error. A
// body with GraphQL errors is classified by them even alongside data (GitHub answers
// NOT_FOUND and RATE_LIMITED with HTTP 200); with data as well (and not rate limited)
// the data comes back with a *PartialError. Non-2xx without an errors array is
// classified by status, and so is a 502 or 504 with one: GitHub's timeout, which the
// poll answers by shrinking the query.
func parseGraphQLResponse(res httpResult) (json.RawMessage, error) {
	if res.status == http.StatusBadGateway || res.status == http.StatusGatewayTimeout {
		return nil, classifyHTTP(res)
	}
	var resp graphQLResponse
	jsonErr := json.Unmarshal(res.body, &resp)
	if res.status != http.StatusUnauthorized && jsonErr == nil && len(resp.Errors) > 0 {
		err := classifyGraphQLErrors(resp.Errors)
		var rle *RateLimitError
		if errors.As(err, &rle) {
			applyRateLimitHeaders(rle, res.header)
			return nil, err
		}
		if res.ok() && len(resp.Data) > 0 && string(resp.Data) != "null" {
			return resp.Data, &PartialError{Errors: resp.Errors}
		}
		return nil, err
	}
	if !res.ok() {
		return nil, classifyHTTP(res)
	}
	if jsonErr != nil {
		return nil, fmt.Errorf("github graphql: decode response: %w", jsonErr)
	}
	if len(resp.Data) == 0 || string(resp.Data) == "null" {
		return nil, errors.New("github graphql: response has no data")
	}
	return resp.Data, nil
}

// classifyHTTP maps a non-2xx response to the store's typed errors. Rate limits follow
// GitHub's documented signals: x-ratelimit-remaining: 0 is the primary limit (wait for
// x-ratelimit-reset); a "secondary rate limit" message, retry-after, or 429 is a
// secondary limit.
func classifyHTTP(res httpResult) error {
	msg := httpMessage(res)
	lower := strings.ToLower(msg)
	switch res.status {
	case http.StatusUnauthorized:
		return fmt.Errorf("%w: %s", ErrNotAuthenticated, msg)
	case http.StatusForbidden, http.StatusTooManyRequests:
		if rle := rateLimitFromHTTP(res.status, res.header, lower, msg); rle != nil {
			return rle
		}
		if res.status == http.StatusForbidden {
			// Permissions, SSO enforcement, a missing scope.
			return fmt.Errorf("%w: %s", ErrPermissionDenied, msg)
		}
	case http.StatusNotFound:
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	case http.StatusBadGateway, http.StatusGatewayTimeout:
		return fmt.Errorf("%w: %s", ErrServerTimeout, msg)
	case http.StatusServiceUnavailable:
		return fmt.Errorf("%w: %s", ErrNetwork, msg)
	}
	return fmt.Errorf("github: %s", msg)
}

// rateLimitFromHTTP returns the rate-limit error a 403/429 represents, or nil when it
// is some other refusal (permissions, SSO enforcement).
func rateLimitFromHTTP(status int, h http.Header, lower, msg string) *RateLimitError {
	var rle *RateLimitError
	switch {
	case strings.Contains(lower, "secondary rate limit"), strings.Contains(lower, "abuse"):
		rle = &RateLimitError{Secondary: true, Msg: msg}
	case h.Get("X-Ratelimit-Remaining") == "0", strings.Contains(lower, "rate limit exceeded"):
		rle = &RateLimitError{Msg: msg}
	case status == http.StatusTooManyRequests, h.Get("Retry-After") != "":
		rle = &RateLimitError{Secondary: true, Msg: msg}
	default:
		return nil
	}
	applyRateLimitHeaders(rle, h)
	return rle
}

// applyRateLimitHeaders records retry-after, and x-ratelimit-reset when the budget is
// exhausted (x-ratelimit-remaining: 0).
func applyRateLimitHeaders(rle *RateLimitError, h http.Header) {
	if s, err := strconv.Atoi(strings.TrimSpace(h.Get("Retry-After"))); err == nil && s > 0 {
		rle.RetryAfter = time.Duration(s) * time.Second
	}
	if h.Get("X-Ratelimit-Remaining") != "0" {
		return
	}
	if s, err := strconv.ParseInt(strings.TrimSpace(h.Get("X-Ratelimit-Reset")), 10, 64); err == nil && s > 0 {
		rle.ResetAt = time.Unix(s, 0)
	}
}

// httpMessage is GitHub's error message with the status, like gh prints it:
// "Bad credentials (HTTP 401)".
func httpMessage(res httpResult) string {
	var body struct {
		Message string `json:"message"`
	}
	msg := ""
	if json.Unmarshal(res.body, &body) == nil {
		msg = firstLine(body.Message)
	}
	if msg == "" {
		msg = http.StatusText(res.status)
	}
	return fmt.Sprintf("%s (HTTP %d)", msg, res.status)
}
