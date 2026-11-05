package daemon

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/capability"
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/theme"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

const tunnelToken = "daemon-secret"

// tunnelRig is the three listeners as Run composes them, on real sockets. The ports are
// bound first: each origin and Host below names them.
type tunnelRig struct {
	apiPort, pagesPort int
	api, pages, unix   string // ws:// URLs' roots; unix's host is a placeholder
	unixClient         *http.Client
	scoped, revoked    string
	// reached counts the calls that got past auth to the Connect handler.
	reached atomic.Int64
}

func tcpListener(t *testing.T) (net.Listener, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln, ln.Addr().(*net.TCPAddr).Port
}

func serveOn(t *testing.T, ln net.Listener, h http.Handler) {
	t.Helper()
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
}

func newTunnelRig(t *testing.T, level slog.Level, devOrigins func(pagesPort int) []string) *tunnelRig {
	t.Helper()
	r := &tunnelRig{}
	apiLn, apiPort := tcpListener(t)
	pagesLn, pagesPort := tcpListener(t)
	r.apiPort, r.pagesPort = apiPort, pagesPort
	r.api = "ws://127.0.0.1:" + strconv.Itoa(apiPort)
	r.pages = "ws://127.0.0.1:" + strconv.Itoa(pagesPort)

	path, attach := wstunneltest.Attach(func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		r.reached.Add(1)
		return s.Send(wstunneltest.Output([]byte("hello")))
	})
	mux := http.NewServeMux()
	mux.Handle(path, attach)

	caps := capability.NewRegistry(nil)
	var err error
	if r.scoped, _, err = caps.Issue(capability.Scope{Search: "q-0123456789ab"}, time.Minute); err != nil {
		t.Fatal(err)
	}
	var revoke func()
	if r.revoked, revoke, err = caps.Issue(capability.Scope{Search: "q-0123456789ac"}, time.Minute); err != nil {
		t.Fatal(err)
	}
	revoke()

	log := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: level}))
	routes := newPageRoutes(preview.NewGrants(preview.Floor{}), theme.NewLive(), log)
	prefixes := make([]string, 0, len(routes))
	for p := range routes {
		prefixes = append(prefixes, p)
	}
	dev := devOrigins(pagesPort)
	tunnel := newTunnel(log, tunnelToken, caps, pagesPort, dev, mux)
	serveOn(t, apiLn, logRequests(log, "loopback", loopbackHost(apiPort, loopbackHandler(tunnelToken, caps, prefixes, pagesPort, dev, mux, tunnel))))
	serveOn(t, pagesLn, logRequests(log, "pages", loopbackHost(pagesPort, pagesHandler(routes))))

	dir, err := os.MkdirTemp("/tmp", "cf-ws-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	unixLn, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	serveOn(t, unixLn, logRequests(log, "unix", mux))
	r.unix = "ws://unix"
	r.unixClient = &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", sock)
	}}}
	return r
}

type tunnelCase struct {
	name, value string
	ok          bool
}

// origins are every Origin the tunnel must tell apart. dev is 9245, listed by the rig;
// pages and api are the rig's listeners.
func tunnelOrigins(r *tunnelRig) []tunnelCase {
	pages, api := strconv.Itoa(r.pagesPort), strconv.Itoa(r.apiPort)
	return []tunnelCase{
		{"wails", "wails://localhost", true},
		{"wails dev port", "wails://localhost:9245", true},
		{"dev origin", "http://127.0.0.1:9245", true},
		{"dev origin localhost", "http://localhost:9245", true},

		{"absent", "", false},
		{"null", "null", false},
		{"pages origin", "http://127.0.0.1:" + pages, false},
		{"pages origin by name", "http://localhost:" + pages, false},
		{"api origin", "http://127.0.0.1:" + api, false},
		{"other loopback port", "http://127.0.0.1:9246", false},
		{"https dev port", "https://127.0.0.1:9245", false},
		{"ws scheme", "ws://127.0.0.1:9245", false},
		{"web", "https://evil.example", false},
		{"web with the dev port", "http://evil.example:9245", false},
		{"wails host elsewhere", "wails://evil.example", false},
		{"wails host suffix", "wails://localhost.evil.example", false},
		{"wails userinfo", "wails://localhost@evil.example", false},
		{"wails with user", "wails://evil@localhost", false},
		{"wails path", "wails://localhost/x", false},
		{"wails opaque", "wails:localhost", false},
		{"wails upper host", "wails://LOCALHOST", false},
		{"scheme suffix", "wailss://localhost", false},
		{"scheme prefix", "xwails://localhost", false},
		{"scheme dash", "wails-dev://localhost", false},
		{"http localhost", "http://localhost", false},
		{"file", "file://", false},
		{"two origins in one", "wails://localhost, http://evil.example", false},
	}
}

func tunnelHosts(port int) []tunnelCase {
	p := strconv.Itoa(port)
	return []tunnelCase{
		{"ip", "127.0.0.1:" + p, true},
		{"name", "localhost:" + p, true},
		{"v6", "[::1]:" + p, true},
		{"no port", "127.0.0.1", true},

		{"web", "evil.example", false},
		{"web with the port", "evil.example:" + p, false},
		{"other port", "127.0.0.1:1", false},
		{"suffix", "127.0.0.1.evil.example:" + p, false},
	}
}

func (r *tunnelRig) tokens() []struct {
	name, token string
	want        int
} {
	return []struct {
		name, token string
		want        int
	}{
		{"daemon token", tunnelToken, http.StatusOK},
		// A scoped token reaches no stream: requireBearer's AllowProcedure, on the path
		// without /stream.
		{"scoped token", r.scoped, http.StatusForbidden},
		{"revoked scoped token", r.revoked, http.StatusUnauthorized},
		{"wrong token", "not-the-token", http.StatusUnauthorized},
		{"no token", "", http.StatusUnauthorized},
	}
}

// Every Origin × Host × listener, at both log levels (logRequests wraps the writer at debug
// only, and the socket must hijack through it), then each token where the upgrade succeeds.
// A refused upgrade means the token is never read: it holds with any token at all.
func TestTunnelBoundary(t *testing.T) {
	for _, level := range []slog.Level{slog.LevelInfo, slog.LevelDebug} {
		t.Run(level.String(), func(t *testing.T) {
			r := newTunnelRig(t, level, func(pagesPort int) []string {
				// The pages origin is listed on purpose: allowedOrigin still refuses it.
				return []string{"http://127.0.0.1:9245", "http://localhost:9245", pagesOrigin(pagesPort)}
			})
			listeners := []struct {
				name, root string
				port       int
				client     *http.Client
				status     func(host, origin tunnelCase) int
			}{
				{"loopback", r.api, r.apiPort, nil, func(host, origin tunnelCase) int {
					switch {
					case !host.ok:
						return http.StatusMisdirectedRequest
					case !origin.ok:
						return http.StatusForbidden
					}
					return http.StatusSwitchingProtocols
				}},
				{"pages", r.pages, r.pagesPort, nil, func(host, _ tunnelCase) int {
					if !host.ok {
						return http.StatusMisdirectedRequest
					}
					return http.StatusNotFound
				}},
				{"unix", r.unix, r.apiPort, r.unixClient, func(tunnelCase, tunnelCase) int { return http.StatusNotFound }},
			}
			for _, l := range listeners {
				for _, origin := range tunnelOrigins(r) {
					for _, host := range tunnelHosts(l.port) {
						name := fmt.Sprintf("%s/%s/%s", l.name, origin.name, host.name)
						want := l.status(host, origin)
						ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
						d := wstunneltest.Dial{URL: l.root + "/stream" + wstunneltest.Stream, Host: host.value, HTTPClient: l.client}
						if origin.value != "" {
							d.Origins = []string{origin.value}
						}
						if want != http.StatusSwitchingProtocols {
							before := r.reached.Load()
							if _, resp, err := d.Open(ctx); err == nil || resp == nil || resp.StatusCode != want {
								t.Errorf("%s: resp %v, err %v, want %d", name, resp, err, want)
							}
							if r.reached.Load() != before {
								t.Errorf("%s: reached the handler", name)
							}
							cancel()
							continue
						}
						for _, tok := range r.tokens() {
							checkTunnelToken(ctx, t, name+"/"+tok.name, r, d, tok.token, tok.want)
						}
						cancel()
					}
				}
			}
		})
	}
}

// checkTunnelToken opens d, sends token in the head, and reads the outcome: a failed check
// comes back as the head's status, since a browser cannot read a failed upgrade's.
func checkTunnelToken(ctx context.Context, t *testing.T, name string, r *tunnelRig, d wstunneltest.Dial, token string, want int) {
	t.Helper()
	before := r.reached.Load()
	c, _, err := d.Open(ctx)
	if err != nil {
		t.Errorf("%s: %v", name, err)
		return
	}
	defer func() { _ = c.Conn.CloseNow() }()
	body, err := wstunneltest.Body(&v1.AttachRequest{Id: "t-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, wstunneltest.Headers(token), body); err != nil {
		t.Errorf("%s: %v", name, err)
		return
	}
	head, err := c.ReadHead(ctx)
	if err != nil {
		t.Errorf("%s: %v", name, err)
		return
	}
	if head.Status != want {
		t.Errorf("%s: head status %d, want %d", name, head.Status, want)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("%s: close %v, want 1000", name, code)
	}
	if got, reached := r.reached.Load() != before, want == http.StatusOK; got != reached {
		t.Errorf("%s: reached the handler = %v, want %v", name, got, reached)
	}
}

// Two Origin headers are refused whichever comes first: nothing can check one and use the
// other. The rig's table sends one each.
func TestTunnelRefusesTwoOrigins(t *testing.T) {
	r := newTunnelRig(t, slog.LevelInfo, func(int) []string { return nil })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, origins := range [][]string{{"wails://localhost", "https://evil.example"}, {"https://evil.example", "wails://localhost"}} {
		_, resp, err := wstunneltest.Dial{URL: r.api + "/stream" + wstunneltest.Stream, Origins: origins}.Open(ctx)
		if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Errorf("%v: resp %v, err %v", origins, resp, err)
		}
	}
}

// The token counts only in the head: not on the upgrade, not as a subprotocol.
func TestTunnelTokenOnlyInTheHead(t *testing.T) {
	r := newTunnelRig(t, slog.LevelInfo, func(int) []string { return nil })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := r.api + "/stream" + wstunneltest.Stream
	origin := []string{"wails://localhost"}
	tests := []struct {
		name string
		d    wstunneltest.Dial
	}{
		{"Authorization on the upgrade", wstunneltest.Dial{URL: url, Origins: origin, Header: http.Header{"Authorization": {"Bearer " + tunnelToken}}}},
		{"token as a subprotocol", wstunneltest.Dial{URL: url, Origins: origin, Subprotocols: []string{tunnelToken, "Bearer." + tunnelToken}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			checkTunnelToken(ctx, t, tc.name, r, tc.d, "", http.StatusUnauthorized)
		})
	}
}

// Through the whole loopback handler: nothing under /stream gets anywhere but the tunnel,
// and the tunnel only upgrades. Each request has a good Origin and the real token; no
// handler is reached.
func TestTunnelPathsReachNothingElse(t *testing.T) {
	var hit atomic.Int64
	rest := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit.Add(1) })
	caps := capability.NewRegistry(nil)
	h := loopbackHandler(tunnelToken, caps, []string{"/preview/", "/cf/"}, 4242, nil, rest,
		newTunnel(slog.New(slog.DiscardHandler), tunnelToken, caps, 4242, nil, rest))
	stream := "/stream" + wstunneltest.Stream
	tests := []struct {
		name, method, target string
		want                 int
	}{
		{"stream without an upgrade", http.MethodGet, stream, http.StatusUpgradeRequired},
		{"POST without an upgrade", http.MethodPost, stream, http.StatusUpgradeRequired},
		{"unary", http.MethodPost, "/stream" + wstunneltest.Unary, http.StatusNotFound},
		{"preview under the prefix", http.MethodGet, "/stream/preview/grant/index.html", http.StatusNotFound},
		{"theme under the prefix", http.MethodGet, "/stream/cf/theme.css", http.StatusNotFound},
		// ServeMux redirects to the cleaned path, which only names it; a socket does not follow.
		{"dot segments", http.MethodGet, "/stream/../preview/grant/index.html", http.StatusTemporaryRedirect},
		{"encoded dot segments", http.MethodGet, "/stream/%2e%2e/cf/theme.css", http.StatusNotFound},
		{"doubled slash", http.MethodGet, "/stream//cf/theme.css", http.StatusTemporaryRedirect},
		{"no trailing slash", http.MethodGet, "/stream", http.StatusTemporaryRedirect},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.target, nil)
			req.Header.Set("Origin", "wails://localhost")
			req.Header.Set("Authorization", "Bearer "+tunnelToken)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
			if hit.Load() != 0 {
				t.Error("reached a handler")
			}
		})
	}
}

// A refused upgrade logs its origin at Info, and neither a token nor a head value is ever
// logged, at debug either.
func TestTunnelLogHasNoToken(t *testing.T) {
	var buf lockedLog
	log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	path, attach := wstunneltest.Attach(func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		return s.Send(wstunneltest.Output([]byte("hello")))
	})
	mux := http.NewServeMux()
	mux.Handle(path, attach)
	caps := capability.NewRegistry(nil)
	tunnel := newTunnel(log, tunnelToken, caps, 4242, nil, mux)
	srv := httptest.NewServer(logRequests(log, "loopback", loopbackHandler(tunnelToken, caps, nil, 4242, nil, mux, tunnel)))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/stream" + wstunneltest.Stream
	if _, _, err := (wstunneltest.Dial{URL: url, Origins: []string{"https://evil.example"}}).Open(ctx); err == nil {
		t.Fatal("dial with a bad origin worked")
	}
	c, _, err := wstunneltest.Dial{URL: url, Origins: []string{"wails://localhost"}}.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	body, err := wstunneltest.Body(&v1.AttachRequest{Id: "t-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, wstunneltest.Headers(tunnelToken), body); err != nil {
		t.Fatal(err)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("close %v", code)
	}
	if err := tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	logs := buf.String()
	for _, want := range []string{"tunnel refused", "https://evil.example", "tunnel open", "tunnel closed"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %q: %s", want, logs)
		}
	}
	if strings.Contains(logs, tunnelToken) || strings.Contains(logs, "Bearer") {
		t.Errorf("a token reached the log: %s", logs)
	}
}

// lockedLog is a log buffer the server's goroutines write.
type lockedLog struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
