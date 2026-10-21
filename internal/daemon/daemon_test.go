package daemon

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

func TestLoopbackHandlerPreviewNeedsNoBearer(t *testing.T) {
	previewH := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	rest := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := loopbackHandler("secret", previewH, rest)
	tests := []struct {
		name, path, auth string
		want             int
	}{
		{"preview without token", "/preview/abc/index.html", "", http.StatusTeapot},
		{"preview root without token", "/preview/", "", http.StatusTeapot},
		{"rpc without token", "/codefoundry.v1.ThreadService/List", "", http.StatusUnauthorized},
		{"rpc with token", "/codefoundry.v1.ThreadService/List", "Bearer secret", http.StatusOK},
		{"preview-ish path outside the prefix", "/previewx", "", http.StatusUnauthorized},
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
	// Through loopbackHandler, so the test covers CORS being mounted on the API side.
	h := loopbackHandler("secret", http.NotFoundHandler(), ok)
	tests := []struct {
		name       string
		method     string
		header     map[string]string
		wantStatus int
		wantACAO   string
	}{
		{"no token", http.MethodPost, nil, http.StatusUnauthorized, ""},
		{"wrong token", http.MethodPost, map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized, ""},
		{"wrong scheme", http.MethodPost, map[string]string{"Authorization": "Basic secret"}, http.StatusUnauthorized, ""},
		{"right token", http.MethodPost, map[string]string{"Authorization": "Bearer secret"}, http.StatusTeapot, ""},
		{"right token with origin", http.MethodPost,
			map[string]string{"Authorization": "Bearer secret", "Origin": "wails://localhost"}, http.StatusTeapot, "wails://localhost"},
		{"wrong token with origin", http.MethodPost,
			map[string]string{"Origin": "wails://localhost"}, http.StatusUnauthorized, "wails://localhost"},
		{"wails3 dev origin", http.MethodPost,
			map[string]string{"Authorization": "Bearer secret", "Origin": "wails://localhost:9245"}, http.StatusTeapot, "wails://localhost:9245"},
		{"dev browser origin", http.MethodPost,
			map[string]string{"Authorization": "Bearer secret", "Origin": "http://127.0.0.1:9245"}, http.StatusTeapot, "http://127.0.0.1:9245"},
		{"preflight skips auth", http.MethodOptions,
			map[string]string{"Origin": "http://localhost:9245", "Access-Control-Request-Method": "POST"}, http.StatusNoContent, "http://localhost:9245"},
		{"bare OPTIONS needs auth", http.MethodOptions, nil, http.StatusUnauthorized, ""},
		// An opaque-origin page (the HTML preview's sandboxed frame) is never let in,
		// even holding the token.
		{"null origin preflight", http.MethodOptions,
			map[string]string{"Origin": "null", "Access-Control-Request-Method": "POST"}, http.StatusUnauthorized, ""},
		{"null origin with token", http.MethodPost,
			map[string]string{"Authorization": "Bearer secret", "Origin": "null"}, http.StatusTeapot, ""},
		{"web origin preflight", http.MethodOptions,
			map[string]string{"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}, http.StatusUnauthorized, ""},
		{"localhost lookalike", http.MethodOptions,
			map[string]string{"Origin": "http://localhost.evil.example", "Access-Control-Request-Method": "POST"}, http.StatusUnauthorized, ""},
		{"wails scheme, other host", http.MethodOptions,
			map[string]string{"Origin": "wails://evil.example", "Access-Control-Request-Method": "POST"}, http.StatusUnauthorized, ""},
		{"file origin", http.MethodOptions,
			map[string]string{"Origin": "file://", "Access-Control-Request-Method": "POST"}, http.StatusUnauthorized, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/codefoundry.v1.HealthService/Ping", nil)
			for k, v := range tt.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
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
