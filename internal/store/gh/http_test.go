package gh

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func header(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

// wantRL describes the expected *RateLimitError; nil means "not a rate limit".
type wantRL struct {
	secondary  bool
	retryAfter time.Duration
	resetAt    int64
}

func checkRateLimit(t *testing.T, err error, want *wantRL) {
	t.Helper()
	var rle *RateLimitError
	if !errors.As(err, &rle) {
		if want != nil {
			t.Errorf("err = %v, want a RateLimitError", err)
		}
		return
	}
	if want == nil {
		t.Errorf("err = %v, want no RateLimitError", err)
		return
	}
	if rle.Secondary != want.secondary || rle.RetryAfter != want.retryAfter {
		t.Errorf("rate limit = %+v, want %+v", rle, want)
	}
	if (want.resetAt == 0) != rle.ResetAt.IsZero() || (want.resetAt != 0 && rle.ResetAt.Unix() != want.resetAt) {
		t.Errorf("resetAt = %v, want unix %d", rle.ResetAt, want.resetAt)
	}
}

func TestClassifyHTTP(t *testing.T) {
	secondary := `{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits"}`
	tests := []struct {
		name    string
		status  int
		header  http.Header
		body    string
		want    error // nil: an unclassified error (per-repo backoff)
		rl      *wantRL
		message string
	}{
		{"bad credentials", 401, nil, "@http_401_bad_credentials.json", ErrNotAuthenticated, nil, "Bad credentials (HTTP 401)"},
		{"secondary with retry-after", 403, header("Retry-After", "30"), secondary, ErrRateLimited,
			&wantRL{secondary: true, retryAfter: 30 * time.Second}, "secondary rate limit"},
		{"secondary without retry-after", 403, nil, secondary, ErrRateLimited, &wantRL{secondary: true}, ""},
		{"primary by header", 403, header("X-Ratelimit-Remaining", "0", "X-Ratelimit-Reset", "1791000000"),
			`{"message":"API rate limit exceeded for user ID 1."}`, ErrRateLimited, &wantRL{resetAt: 1791000000}, ""},
		{"primary by message", 403, nil, `{"message":"API rate limit exceeded for user ID 1."}`, ErrRateLimited, &wantRL{}, ""},
		{"429", 429, nil, "", ErrRateLimited, &wantRL{secondary: true}, "Too Many Requests (HTTP 429)"},
		{"403 retry-after only", 403, header("Retry-After", "5"), `{"message":"slow down"}`, ErrRateLimited,
			&wantRL{secondary: true, retryAfter: 5 * time.Second}, ""},
		{"403 permissions", 403, header("X-Ratelimit-Remaining", "4999"),
			`{"message":"Resource not accessible by integration"}`, ErrPermissionDenied, nil, "Resource not accessible by integration (HTTP 403)"},
		{"404", 404, nil, `{"message":"Not Found"}`, ErrNotFound, nil, "Not Found (HTTP 404)"},
		{"502 graphql timeout", 502, nil, "", ErrServerTimeout, nil, "Bad Gateway (HTTP 502)"},
		{"504", 504, nil, "", ErrServerTimeout, nil, ""},
		{"503", 503, nil, "<html>unicorn</html>", ErrNetwork, nil, "Service Unavailable (HTTP 503)"},
		{"500", 500, nil, `{"message":"Server Error"}`, nil, nil, "Server Error (HTTP 500)"},
		{"422 search validation", 422, nil, `{"message":"Validation Failed"}`, nil, nil, "Validation Failed (HTTP 422)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(tt.body)
			if f, ok := strings.CutPrefix(tt.body, "@"); ok {
				body = fixture(t, f)
			}
			err := classifyHTTP(httpResult{status: tt.status, header: cmpHeader(tt.header), body: body})
			if err == nil {
				t.Fatal("nil error")
			}
			if tt.want != nil && !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
			if tt.want == nil && (isGlobal(err) || errors.Is(err, ErrNotFound) || errors.Is(err, ErrServerTimeout)) {
				t.Errorf("err = %v, want unclassified", err)
			}
			checkRateLimit(t, err, tt.rl)
			if !strings.Contains(err.Error(), tt.message) {
				t.Errorf("err = %q, want it to contain %q", err, tt.message)
			}
		})
	}
}

func cmpHeader(h http.Header) http.Header {
	if h == nil {
		return http.Header{}
	}
	return h
}

func TestParseGraphQLResponse(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		header  http.Header
		body    string
		wantErr error
		rl      *wantRL
	}{
		{"ok", 200, nil, "@viewer.json", nil, nil},
		// GitHub answers NOT_FOUND with HTTP 200 and data alongside the errors.
		{"repo not found", 200, nil, "@graphql_repo_not_found.json", ErrNotFound, nil},
		{"pr not found", 200, nil, "@graphql_pr_not_found.json", ErrNotFound, nil},
		{"rate limited, budget exhausted", 200, header("X-Ratelimit-Remaining", "0", "X-Ratelimit-Reset", "1791000000"),
			"@graphql_rate_limited_synthetic.json", ErrRateLimited, &wantRL{resetAt: 1791000000}},
		{"rate limited, retry-after", 403, header("Retry-After", "60"),
			"@graphql_rate_limited_synthetic.json", ErrRateLimited, &wantRL{retryAfter: time.Minute}},
		{"secondary RATE_LIMITED", 200, nil,
			`{"errors":[{"type":"RATE_LIMITED","message":"You have exceeded a secondary rate limit."}]}`,
			ErrRateLimited, &wantRL{secondary: true}},
		{"secondary by status", 403, nil,
			`{"message":"You have exceeded a secondary rate limit.","documentation_url":"x"}`,
			ErrRateLimited, &wantRL{secondary: true}},
		{"bad credentials", 401, nil, "@http_401_bad_credentials.json", ErrNotAuthenticated, nil},
		{"graphql timeout", 502, nil, "", ErrServerTimeout, nil},
		{"service unavailable", 503, nil, "", ErrNetwork, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := []byte(tt.body)
			if f, ok := strings.CutPrefix(tt.body, "@"); ok {
				body = fixture(t, f)
			}
			data, err := parseGraphQLResponse(httpResult{status: tt.status, header: cmpHeader(tt.header), body: body})
			if tt.wantErr == nil {
				if err != nil || len(data) == 0 {
					t.Errorf("data=%d bytes err=%v", len(data), err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want %v", err, tt.wantErr)
			}
			checkRateLimit(t, err, tt.rl)
		})
	}
	for _, body := range []string{"not json", `{"data":null}`, `{}`} {
		if _, err := parseGraphQLResponse(httpResult{status: 200, body: []byte(body)}); err == nil || isGlobal(err) {
			t.Errorf("%s: err = %v, want a non-global error", body, err)
		}
	}
	// FORBIDDEN fails the request as permission denied, not globally.
	_, err := parseGraphQLResponse(httpResult{status: 200,
		body: []byte(`{"data":{"x":1},"errors":[{"type":"FORBIDDEN","message":"nope"}]}`)})
	if !errors.Is(err, ErrPermissionDenied) || isGlobal(err) || !strings.Contains(err.Error(), "nope") {
		t.Errorf("FORBIDDEN: err = %v", err)
	}
	// Other types fail it unclassified.
	_, err = parseGraphQLResponse(httpResult{status: 200,
		body: []byte(`{"data":{"x":1},"errors":[{"type":"SOMETHING_ELSE","message":"odd"}]}`)})
	if err == nil || isGlobal(err) || errors.Is(err, ErrPermissionDenied) || !strings.Contains(err.Error(), "odd") {
		t.Errorf("unknown type: err = %v", err)
	}
	// With data alongside the errors, the data comes back too, with a *PartialError
	// that places each error under its top-level field.
	data, err := parseGraphQLResponse(httpResult{status: 200, body: fixture(t, "graphql_repo_not_found.json")})
	var pe *PartialError
	if !errors.As(err, &pe) || len(data) == 0 || !errors.Is(pe.At("repository"), ErrNotFound) ||
		pe.At("rateLimit") != nil || pe.Unplaced() != nil {
		t.Errorf("partial: data=%s err=%v", data, err)
	}
	// Without data it is a plain error.
	if _, err := parseGraphQLResponse(httpResult{status: 200,
		body: []byte(`{"data":null,"errors":[{"type":"NOT_FOUND","message":"gone"}]}`)}); isPartial(err) || !errors.Is(err, ErrNotFound) {
		t.Errorf("null data: err = %v", err)
	}
}

// fakeTokens hands out tokens in order (repeating the last) and counts calls.
type fakeTokens struct {
	mu     sync.Mutex
	tokens []string
	err    error
	calls  int
}

func (f *fakeTokens) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	i := min(f.calls-1, len(f.tokens)-1)
	return f.tokens[i], nil
}

func (f *fakeTokens) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// recorded is one request the test server received.
type recorded struct {
	method, path, query, auth, accept, ua, apiVersion, contentType string
	body                                                           []byte
}

// apiServer is an httptest server that accepts only the token in valid and serves the
// response handler returns for authorized requests.
type apiServer struct {
	*httptest.Server
	mu    sync.Mutex
	valid string
	reqs  []recorded
}

func newAPIServer(t *testing.T, valid string, handle func(w http.ResponseWriter, r *http.Request)) *apiServer {
	t.Helper()
	s := &apiServer{valid: valid}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.reqs = append(s.reqs, recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"),
			r.Header.Get("Accept"), r.Header.Get("User-Agent"), r.Header.Get("X-GitHub-Api-Version"),
			r.Header.Get("Content-Type"), b})
		valid := s.valid
		s.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+valid {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write(fixtureBytes("http_401_bad_credentials.json"))
			return
		}
		handle(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *apiServer) requests() []recorded {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recorded(nil), s.reqs...)
}

// fixtureBytes reads a testdata file from a server goroutine (no *testing.T there).
func fixtureBytes(name string) []byte {
	b, _ := os.ReadFile(filepath.Join("testdata", name))
	return b
}

func serveViewer(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/graphql":
		_, _ = w.Write(fixtureBytes("viewer.json"))
	case "/user":
		_, _ = w.Write([]byte(`{"login":"octocat","id":1}`))
	case "/search/commits":
		_, _ = w.Write([]byte(`{"total_count":81,"items":[]}`))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}
}

func TestHTTPRunnerRequests(t *testing.T) {
	ctx := context.Background()
	srv := newAPIServer(t, "tok1", serveViewer)
	tokens := &fakeTokens{tokens: []string{"tok1"}}
	r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL + "/", Tokens: tokens, UserAgent: "code-foundry/test"})

	data, err := r.GraphQL(ctx, "query Viewer { viewer { login } }",
		map[string]any{"owner": "o", "name": "true", "first": 25, "flag": false, "after": nil})
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Viewer Viewer `json:"viewer"`
	}
	if err := json.Unmarshal(data, &v); err != nil || v.Viewer.Login != "octocat" {
		t.Errorf("viewer = %+v, %v", v, err)
	}
	body, err := r.REST(ctx, "search/commits", map[string]string{"q": "author:@me author-date:2026-10-01..2026-10-31", "per_page": "1"})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := decodeSearchTotal(body); err != nil || n != 81 {
		t.Errorf("total = %d, %v", n, err)
	}
	if _, err := r.REST(ctx, "/repos/o/missing", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: err = %v, want ErrNotFound", err)
	}

	if n := tokens.count(); n != 1 {
		t.Errorf("token resolutions = %d, want 1 (cached)", n)
	}
	reqs := srv.requests()
	if len(reqs) != 3 {
		t.Fatalf("requests = %d", len(reqs))
	}
	g := reqs[0]
	if g.method != "POST" || g.path != "/graphql" || g.auth != "Bearer tok1" || g.accept != "application/vnd.github+json" ||
		g.ua != "code-foundry/test" || g.apiVersion != "2022-11-28" || g.contentType != "application/json" {
		t.Errorf("graphql request = %+v", g)
	}
	var sent struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.Unmarshal(g.body, &sent); err != nil {
		t.Fatal(err)
	}
	// Strings stay strings ("true"), numbers and bools stay typed, nil is omitted.
	want := map[string]any{"owner": "o", "name": "true", "first": float64(25), "flag": false}
	if sent.Query != "query Viewer { viewer { login } }" || len(sent.Variables) != len(want) {
		t.Errorf("sent = %+v", sent)
	}
	for k, v := range want {
		if sent.Variables[k] != v {
			t.Errorf("variable %s = %#v, want %#v", k, sent.Variables[k], v)
		}
	}
	rest := reqs[1]
	if rest.method != "GET" || rest.path != "/search/commits" ||
		rest.query != "per_page=1&q=author%3A%40me+author-date%3A2026-10-01..2026-10-31" || rest.contentType != "" {
		t.Errorf("rest request = %+v", rest)
	}
	if reqs[2].path != "/repos/o/missing" {
		t.Errorf("leading slash: path = %q", reqs[2].path)
	}
}

func TestHTTPRunnerTokenRefresh(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name       string
		valid      string
		tokens     []string
		tokenErr   error
		wantErr    error
		wantReqs   int
		wantTokens int
	}{
		{"401 then refreshed token works", "tok2", []string{"tok1", "tok2"}, nil, nil, 2, 2},
		{"401 and gh has the same token: no retry", "other", []string{"tok1"}, nil, ErrNotAuthenticated, 1, 2},
		{"401 twice", "other", []string{"tok1", "tok2"}, nil, ErrNotAuthenticated, 2, 2},
		{"no token: no request", "tok1", nil, errors.Join(ErrNoToken, errors.New("no oauth token found for github.com")),
			ErrNotAuthenticated, 0, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newAPIServer(t, tt.valid, serveViewer)
			tokens := &fakeTokens{tokens: tt.tokens, err: tt.tokenErr}
			r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: tokens})
			_, err := r.GraphQL(ctx, "query Viewer { viewer { login } }", nil)
			if tt.wantErr == nil && err != nil || tt.wantErr != nil && !errors.Is(err, tt.wantErr) {
				t.Errorf("err = %v, want %v", err, tt.wantErr)
			}
			if n := len(srv.requests()); n != tt.wantReqs {
				t.Errorf("requests = %d, want %d", n, tt.wantReqs)
			}
			if n := tokens.count(); n != tt.wantTokens {
				t.Errorf("token resolutions = %d, want %d", n, tt.wantTokens)
			}
		})
	}

	t.Run("refreshed token is kept", func(t *testing.T) {
		srv := newAPIServer(t, "tok2", serveViewer)
		tokens := &fakeTokens{tokens: []string{"tok1", "tok2"}}
		r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: tokens})
		for range 3 {
			if _, err := r.GraphQL(ctx, "q", nil); err != nil {
				t.Fatal(err)
			}
		}
		if n, reqs := tokens.count(), len(srv.requests()); n != 2 || reqs != 4 {
			t.Errorf("token resolutions = %d, requests = %d; want 2, 4", n, reqs)
		}
	})

	t.Run("token TTL", func(t *testing.T) {
		srv := newAPIServer(t, "tok1", serveViewer)
		tokens := &fakeTokens{tokens: []string{"tok1"}}
		now := time.Unix(1_800_000_000, 0)
		r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: tokens, TokenTTL: time.Minute,
			Now: func() time.Time { return now }})
		_, _ = r.GraphQL(ctx, "q", nil)
		now = now.Add(59 * time.Second)
		_, _ = r.GraphQL(ctx, "q", nil)
		if n := tokens.count(); n != 1 {
			t.Errorf("within TTL: resolutions = %d", n)
		}
		now = now.Add(2 * time.Second)
		_, _ = r.GraphQL(ctx, "q", nil)
		if n := tokens.count(); n != 2 {
			t.Errorf("after TTL: resolutions = %d", n)
		}
	})
}

func TestHTTPRunnerRateLimitHeaders(t *testing.T) {
	srv := newAPIServer(t, "tok", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"You have exceeded a secondary rate limit."}`))
	})
	r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok"}}})
	_, err := r.GraphQL(context.Background(), "q", nil)
	checkRateLimit(t, err, &wantRL{secondary: true, retryAfter: 7 * time.Second})
	_, err = r.REST(context.Background(), "search/commits", nil)
	checkRateLimit(t, err, &wantRL{secondary: true, retryAfter: 7 * time.Second})
}

func TestHTTPRunnerNetworkFailures(t *testing.T) {
	tokens := &fakeTokens{tokens: []string{"tok"}}

	t.Run("connection refused", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		r := NewHTTPRunner(HTTPOptions{BaseURL: url, Tokens: tokens})
		_, err := r.GraphQL(context.Background(), "q", nil)
		if !errors.Is(err, ErrNetwork) {
			t.Errorf("err = %v, want ErrNetwork", err)
		}
		if _, err := r.REST(context.Background(), "x", nil); !errors.Is(err, ErrNetwork) {
			t.Errorf("REST err = %v, want ErrNetwork", err)
		}
	})

	slow := func(t *testing.T) string {
		release := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-release:
			case <-r.Context().Done():
			}
		}))
		t.Cleanup(func() { close(release); srv.Close() })
		return srv.URL
	}

	t.Run("request timeout", func(t *testing.T) {
		r := NewHTTPRunner(HTTPOptions{BaseURL: slow(t), Tokens: tokens, Timeout: 50 * time.Millisecond})
		start := time.Now()
		_, err := r.GraphQL(context.Background(), "q", nil)
		if !errors.Is(err, ErrNetwork) || !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 2*time.Second {
			t.Errorf("err = %v after %v", err, time.Since(start))
		}
	})

	t.Run("caller cancels", func(t *testing.T) {
		r := NewHTTPRunner(HTTPOptions{BaseURL: slow(t), Tokens: tokens})
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		_, err := r.GraphQL(ctx, "q", nil)
		if errors.Is(err, ErrNetwork) || !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("err = %v, want the caller's context error, not ErrNetwork", err)
		}
	})
}

func TestHTTPRunnerAuthStatus(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name      string
		valid     string
		tokens    *fakeTokens
		want      AuthStatus
		wantError string
	}{
		{"ok", "tok", &fakeTokens{tokens: []string{"tok"}}, AuthStatus{LoggedIn: true, Login: "octocat"}, ""},
		{"rejected", "other", &fakeTokens{tokens: []string{"tok"}}, AuthStatus{}, "Bad credentials (HTTP 401)"},
		{"no token", "tok", &fakeTokens{err: errors.Join(ErrNoToken, errors.New("no oauth token found for github.com"))},
			AuthStatus{}, "no oauth token found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newAPIServer(t, tt.valid, serveViewer)
			r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: tt.tokens})
			for i := 1; i <= 2; i++ {
				st, err := r.AuthStatus(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if st.LoggedIn != tt.want.LoggedIn || st.Login != tt.want.Login || !strings.Contains(st.Error, tt.wantError) ||
					(tt.wantError == "") != (st.Error == "") {
					t.Errorf("status = %+v, want %+v with error %q", st, tt.want, tt.wantError)
				}
				// Every check asks gh again: that is how a new login is noticed.
				if n := tt.tokens.count(); n != i {
					t.Errorf("token resolutions = %d, want %d", n, i)
				}
			}
			for _, req := range srv.requests() {
				if req.method != "GET" || req.path != "/user" {
					t.Errorf("request = %s %s, want GET /user", req.method, req.path)
				}
			}
		})
	}

	t.Run("network failure is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.NotFoundHandler())
		url := srv.URL
		srv.Close()
		r := NewHTTPRunner(HTTPOptions{BaseURL: url, Tokens: &fakeTokens{tokens: []string{"tok"}}})
		if _, err := r.AuthStatus(ctx); !errors.Is(err, ErrNetwork) {
			t.Errorf("err = %v, want ErrNetwork", err)
		}
	})
}
