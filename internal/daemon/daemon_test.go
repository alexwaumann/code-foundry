package daemon

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestLockIsExclusive(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "daemon.lock")
	sock := filepath.Join(t.TempDir(), "none.sock")
	first, _, err := acquireLock(ctx, path, sock, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := acquireLock(ctx, path, sock, 0); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second acquire err = %v, want ErrAlreadyRunning", err)
	}
	if err := first.release(); err != nil {
		t.Fatal(err)
	}
	again, w, err := acquireLock(ctx, path, sock, 0)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	if w.busy {
		t.Fatalf("free lock reported busy: %+v", w)
	}
	_ = again.release()
}

// An auto-started daemon (LockWait) waits out a previous daemon that is still closing
// its stores (no socket), but not one that answers or never lets go.
func TestLockWait(t *testing.T) {
	tests := []struct {
		name      string
		wait      time.Duration
		releaseIn time.Duration // 0: the holder keeps the lock
		listen    bool          // the holder answers on the socket
		wantErr   bool
		wantMsg   string
		maxTime   time.Duration
	}{
		{name: "holder shutting down", wait: 3 * time.Second, releaseIn: 300 * time.Millisecond, maxTime: 2 * time.Second},
		{name: "holder never lets go", wait: 400 * time.Millisecond, wantErr: true, wantMsg: "still held by pid", maxTime: 2 * time.Second},
		{name: "holder answers", wait: 3 * time.Second, listen: true, wantErr: true, maxTime: time.Second},
		{name: "no wait", wantErr: true, maxTime: time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			dir, err := os.MkdirTemp("/tmp", "cf-lock-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(dir) })
			path, sock := filepath.Join(dir, "daemon.lock"), filepath.Join(dir, "daemon.sock")
			holder, _, err := acquireLock(ctx, path, sock, 0)
			if err != nil {
				t.Fatal(err)
			}
			if tt.listen {
				ln, err := net.Listen("unix", sock)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = ln.Close() })
			}
			if tt.releaseIn > 0 {
				time.AfterFunc(tt.releaseIn, func() { _ = holder.release() })
			} else {
				t.Cleanup(func() { _ = holder.release() })
			}
			start := time.Now()
			l, w, err := acquireLock(ctx, path, sock, tt.wait)
			if took := time.Since(start); took > tt.maxTime {
				t.Errorf("took %s, want under %s", took, tt.maxTime)
			}
			if tt.wantErr {
				if !errors.Is(err, ErrAlreadyRunning) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want ErrAlreadyRunning containing %q", err, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = l.release() }()
			if !w.busy || w.holder != os.Getpid() || w.waited < tt.releaseIn/2 {
				t.Fatalf("wait = %+v, want busy, holder %d, waited about %s", w, os.Getpid(), tt.releaseIn)
			}
		})
	}
}

func TestNewToken(t *testing.T) {
	a, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := newToken()
	if len(a) != 64 || a == b {
		t.Fatalf("tokens %q %q: want 64 hex chars, distinct", a, b)
	}
}

func TestWriteFileAtomicPerms(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon.token")
	if err := writeFileAtomic(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %o, want 600", fi.Mode().Perm())
	}
}

func TestLoopbackHandlerServesNoPageRoutes(t *testing.T) {
	rest := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := loopbackHandler("secret", []string{"/preview/", "/cf/", "/cf/bridge.js"}, 4242, nil, rest)
	tests := []struct {
		name, path, auth string
		want             int
	}{
		{"rpc without token", "/codefoundry.v1.ThreadService/List", "", http.StatusUnauthorized},
		{"rpc with token", "/codefoundry.v1.ThreadService/List", "Bearer secret", http.StatusOK},
		// The pages listener's paths are 404 on the API's, token or not.
		{"preview without token", "/preview/abc/index.html", "", http.StatusNotFound},
		{"preview with token", "/preview/abc/index.html", "Bearer secret", http.StatusNotFound},
		{"theme stylesheet", "/cf/theme.css", "", http.StatusNotFound},
		{"bridge script", "/cf/bridge.js", "Bearer secret", http.StatusNotFound},
		{"preview-ish path outside the prefix", "/previewx", "", http.StatusUnauthorized},
		{"cf-ish path outside the prefix", "/cfx/theme.css", "", http.StatusUnauthorized},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestPagesHandlerServesOnlyPageRoutes(t *testing.T) {
	routes := map[string]http.Handler{
		"/preview/":     http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }),
		"/cf/":          http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) }),
		"/cf/bridge.js": http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) }),
	}
	h := pagesHandler(routes)
	tests := []struct {
		name, path, auth string
		want             int
	}{
		{"preview", "/preview/abc/index.html", "", http.StatusTeapot},
		{"theme", "/cf/theme.css", "", http.StatusAccepted},
		{"bridge, the more specific route", "/cf/bridge.js", "", http.StatusCreated},
		{"rpc", "/codefoundry.v1.ThreadService/List", "", http.StatusNotFound},
		{"rpc with a token", "/codefoundry.v1.CommandService/Invoke", "Bearer secret", http.StatusNotFound},
		{"root", "/", "", http.StatusNotFound},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			if tc.auth != "" {
				req.Header.Set("Authorization", tc.auth)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestRequireBearerAndCORS(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	// Through loopbackHandler, so the test covers CORS being mounted on the API side. The
	// pages port is 9300; dev is `daemon --dev` with the dev frontend on 9245 and the
	// pages port listed by mistake.
	devOrigins, err := ParseDevOrigins("9245, 9300, https://[::1]:5173")
	if err != nil {
		t.Fatal(err)
	}
	prod := loopbackHandler("secret", []string{"/preview/"}, 9300, nil, ok)
	dev := loopbackHandler("secret", []string{"/preview/"}, 9300, devOrigins, ok)
	preflight := func(origin string) map[string]string {
		return map[string]string{"Origin": origin, "Access-Control-Request-Method": "POST"}
	}
	withToken := func(origin string) map[string]string {
		return map[string]string{"Authorization": "Bearer secret", "Origin": origin}
	}
	tests := []struct {
		name       string
		dev        bool
		method     string
		header     map[string]string
		wantStatus int
		wantACAO   string
	}{
		{"no token", false, http.MethodPost, nil, http.StatusUnauthorized, ""},
		{"wrong token", false, http.MethodPost, map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized, ""},
		{"wrong scheme", false, http.MethodPost, map[string]string{"Authorization": "Basic secret"}, http.StatusUnauthorized, ""},
		{"right token", false, http.MethodPost, map[string]string{"Authorization": "Bearer secret"}, http.StatusTeapot, ""},
		{"bare OPTIONS needs auth", false, http.MethodOptions, nil, http.StatusUnauthorized, ""},
		// The Wails webview, always.
		{"wails", false, http.MethodPost, withToken("wails://localhost"), http.StatusTeapot, "wails://localhost"},
		{"wails without token", false, http.MethodPost, map[string]string{"Origin": "wails://localhost"}, http.StatusUnauthorized, "wails://localhost"},
		{"wails3 dev", false, http.MethodPost, withToken("wails://localhost:9245"), http.StatusTeapot, "wails://localhost:9245"},
		{"wails preflight skips auth", false, http.MethodOptions, preflight("wails://localhost"), http.StatusNoContent, "wails://localhost"},
		{"wails in dev mode", true, http.MethodPost, withToken("wails://localhost"), http.StatusTeapot, "wails://localhost"},
		{"wails scheme, other host", true, http.MethodOptions, preflight("wails://evil.example"), http.StatusUnauthorized, ""},
		// No loopback origin outside dev mode: the dev frontend's, this daemon's pages
		// origin, another daemon's pages origin (docs/notes/bridge-fix-crosshome.md).
		{"dev frontend without --dev", false, http.MethodOptions, preflight("http://127.0.0.1:9245"), http.StatusUnauthorized, ""},
		{"dev frontend without --dev, token", false, http.MethodPost, withToken("http://localhost:9245"), http.StatusTeapot, ""},
		{"pages origin", false, http.MethodOptions, preflight("http://127.0.0.1:9300"), http.StatusUnauthorized, ""},
		{"another daemon's pages origin", false, http.MethodOptions, preflight("http://127.0.0.1:57191"), http.StatusUnauthorized, ""},
		{"another daemon's pages origin, token", false, http.MethodPost, withToken("http://127.0.0.1:57191"), http.StatusTeapot, ""},
		{"arbitrary loopback port", false, http.MethodOptions, preflight("http://localhost:3000"), http.StatusUnauthorized, ""},
		// Dev mode: the listed origins only.
		{"dev frontend", true, http.MethodPost, withToken("http://127.0.0.1:9245"), http.StatusTeapot, "http://127.0.0.1:9245"},
		{"dev frontend as localhost", true, http.MethodOptions, preflight("http://localhost:9245"), http.StatusNoContent, "http://localhost:9245"},
		{"dev frontend as ::1, not listed", true, http.MethodOptions, preflight("http://[::1]:9245"), http.StatusUnauthorized, ""},
		{"dev frontend over https, not listed", true, http.MethodOptions, preflight("https://127.0.0.1:9245"), http.StatusUnauthorized, ""},
		{"a listed origin", true, http.MethodOptions, preflight("https://[::1]:5173"), http.StatusNoContent, "https://[::1]:5173"},
		{"arbitrary loopback port in dev", true, http.MethodOptions, preflight("http://127.0.0.1:9301"), http.StatusUnauthorized, ""},
		{"another daemon's pages origin in dev", true, http.MethodOptions, preflight("http://127.0.0.1:57191"), http.StatusUnauthorized, ""},
		// The pages origin, under any loopback name, never, even when listed.
		{"pages origin in dev", true, http.MethodOptions, preflight("http://127.0.0.1:9300"), http.StatusUnauthorized, ""},
		{"pages origin in dev, token", true, http.MethodPost, withToken("http://127.0.0.1:9300"), http.StatusTeapot, ""},
		{"pages port as localhost in dev", true, http.MethodOptions, preflight("http://localhost:9300"), http.StatusUnauthorized, ""},
		{"pages port as ::1 in dev", true, http.MethodOptions, preflight("http://[::1]:9300"), http.StatusUnauthorized, ""},
		{"pages port over https in dev", true, http.MethodOptions, preflight("https://127.0.0.1:9300"), http.StatusUnauthorized, ""},
		// An opaque-origin page and the web, never.
		{"null origin preflight", true, http.MethodOptions, preflight("null"), http.StatusUnauthorized, ""},
		{"null origin with token", true, http.MethodPost, withToken("null"), http.StatusTeapot, ""},
		{"null origin, prod", false, http.MethodOptions, preflight("null"), http.StatusUnauthorized, ""},
		{"web origin", true, http.MethodOptions, preflight("https://evil.example"), http.StatusUnauthorized, ""},
		{"localhost lookalike", true, http.MethodOptions, preflight("http://localhost.evil.example:9245"), http.StatusUnauthorized, ""},
		{"file origin", true, http.MethodOptions, preflight("file://"), http.StatusUnauthorized, ""},
		{"origin with a path", true, http.MethodOptions, preflight("http://127.0.0.1:9245/x"), http.StatusUnauthorized, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/codefoundry.v1.HealthService/Ping", nil)
			for k, v := range tt.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h := prod
			if tt.dev {
				h = dev
			}
			h.ServeHTTP(rec, req)
			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
			}
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != tt.wantACAO {
				t.Errorf("ACAO = %q, want %q", got, tt.wantACAO)
			}
		})
	}
}

func TestParseDevOrigins(t *testing.T) {
	tests := []struct {
		in      string
		want    []string
		wantErr bool
	}{
		{"9245", []string{"http://127.0.0.1:9245", "http://localhost:9245"}, false},
		{" 9245 , 9247 ", []string{"http://127.0.0.1:9245", "http://localhost:9245", "http://127.0.0.1:9247", "http://localhost:9247"}, false},
		{"http://LOCALHOST:5173", []string{"http://localhost:5173"}, false},
		{"https://127.0.0.1", []string{"https://127.0.0.1:443"}, false},
		{"http://[::1]:8080/", []string{"http://[::1]:8080"}, false},
		{"", nil, true},
		{",", nil, true},
		{"0", nil, true},
		{"70000", nil, true},
		{"https://example.com:9245", nil, true},
		{"http://192.168.1.2:9245", nil, true},
		{"wails://localhost", nil, true},
		{"null", nil, true},
		{"http://127.0.0.1:9245/app", nil, true},
		{"http://u@127.0.0.1:9245", nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseDevOrigins(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
