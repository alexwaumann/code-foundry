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
	o.UserAgent = cmp.Or(o.UserAgent, "code-foundry")
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &HTTPRunner{opts: o}
}

// idleConnTimeout drops our idle connections before GitHub does. api.github.com closes
// an HTTP/2 connection after ~30s idle (measured 2026-10: reused after 28s, new after
// 31s), so reusing one near that edge could race the server's close, and a POST is not
// retried on a dead connection. Requests of one poll come seconds apart and reuse; the
// poll itself (60s) reconnects, ~0.2-0.4s once a minute.
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
	res, err := r.do(ctx, http.MethodPost, r.opts.BaseURL+"/graphql", body)
	if err != nil {
		return nil, err
	}
	return parseGraphQLResponse(res)
}

// REST implements RESTRunner: GET <BaseURL>/<path>?<params>.
func (r *HTTPRunner) REST(ctx context.Context, path string, params map[string]string) (json.RawMessage, error) {
	u := r.opts.BaseURL + "/" + strings.TrimPrefix(path, "/")
	if len(params) > 0 {
		q := url.Values{}
		for k, v := range params {
			q.Set(k, v)
		}
		u += "?" + q.Encode()
	}
	res, err := r.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if !res.ok() {
		return nil, classifyHTTP(res)
	}
	return res.body, nil
}

// AuthStatus implements Runner. It resolves the token afresh and validates it with
// GET /user (one REST core point; GraphQL's budget is untouched). A missing or rejected
// token is reported in AuthStatus, not as an error; transport failures are errors.
func (r *HTTPRunner) AuthStatus(ctx context.Context) (AuthStatus, error) {
	tok, err := r.resolveToken(ctx, true)
	if err != nil {
		if errors.Is(err, ErrNoToken) {
			return AuthStatus{Error: err.Error()}, nil
		}
		return AuthStatus{}, err
	}
	res, err := r.send(ctx, http.MethodGet, r.opts.BaseURL+"/user", nil, tok)
	if err != nil {
		return AuthStatus{}, err
	}
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
func (r *HTTPRunner) do(ctx context.Context, method, u string, body []byte) (httpResult, error) {
	tok, err := r.resolveToken(ctx, false)
	if err != nil {
		return httpResult{}, notAuthenticated(err)
	}
	res, err := r.send(ctx, method, u, body, tok)
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
	return r.send(ctx, method, u, body, fresh)
}

func notAuthenticated(err error) error {
	if errors.Is(err, ErrNoToken) {
		return fmt.Errorf("%w: %w", ErrNotAuthenticated, err)
	}
	return err
}

// resolveToken returns the cached token, or asks the TokenSource when there is none,
// it is older than TokenTTL, or force is set.
func (r *HTTPRunner) resolveToken(ctx context.Context, force bool) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.opts.Now()
	if !force && r.token != "" && now.Sub(r.tokenAt) < r.opts.TokenTTL {
		return r.token, nil
	}
	start := now
	tok, err := r.opts.Tokens.Token(ctx)
	r.opts.Log.Debug("github token resolved", "dur", r.opts.Now().Sub(start).Round(time.Millisecond).String(),
		"forced", force, "err", err)
	if err != nil {
		r.token = ""
		return "", err
	}
	r.token, r.tokenAt = tok, r.opts.Now()
	return tok, nil
}

// httpResult is a completed HTTP exchange.
type httpResult struct {
	status int
	header http.Header
	body   []byte
}

func (h httpResult) ok() bool { return h.status >= 200 && h.status < 300 }

// send performs one request within Timeout. Transport failures are ErrNetwork, except
// cancellation of ctx itself, which is returned as is.
func (r *HTTPRunner) send(ctx context.Context, method, u string, body []byte, tok string) (httpResult, error) {
	cctx, cancel := context.WithTimeout(ctx, r.opts.Timeout)
	defer cancel()
	var reused bool
	cctx = httptrace.WithClientTrace(cctx, &httptrace.ClientTrace{
		GotConn: func(i httptrace.GotConnInfo) { reused = i.Reused },
	})
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(cctx, method, u, rd)
	if err != nil {
		return httpResult{}, fmt.Errorf("github: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", r.opts.UserAgent)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	start := r.opts.Now()
	resp, err := r.opts.Client.Do(req)
	var b []byte
	if err == nil {
		b, err = io.ReadAll(io.LimitReader(resp.Body, maxBody))
		resp.Body.Close()
	}
	if err != nil {
		if cerr := ctx.Err(); cerr != nil {
			return httpResult{}, fmt.Errorf("github request: %w", cerr)
		}
		return httpResult{}, fmt.Errorf("%w: %w", ErrNetwork, err)
	}
	h := resp.Header
	r.opts.Log.Debug("github http", "method", method, "path", req.URL.Path, "status", resp.StatusCode,
		"dur", r.opts.Now().Sub(start).Round(time.Millisecond).String(), "reused_conn", reused,
		"proto", resp.Proto, "bytes", len(b),
		"rl_resource", h.Get("X-Ratelimit-Resource"), "rl_remaining", h.Get("X-Ratelimit-Remaining"))
	return httpResult{status: resp.StatusCode, header: h, body: b}, nil
}

// parseGraphQLResponse turns a /graphql response into data or a classified error. A
// body with GraphQL errors is classified by them even alongside data (GitHub answers
// NOT_FOUND and RATE_LIMITED with HTTP 200); with data as well (and not rate limited)
// the data comes back with a *PartialError. Non-2xx without an errors array is
// classified by status.
func parseGraphQLResponse(res httpResult) (json.RawMessage, error) {
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
