package daemon

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLockIsExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "daemon.lock")
	first, err := acquireLock(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireLock(path); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second acquire err = %v, want ErrAlreadyRunning", err)
	}
	if err := first.release(); err != nil {
		t.Fatal(err)
	}
	again, err := acquireLock(path)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	_ = again.release()
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
	h := cors(requireBearer("secret", ok))
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
		{"preflight skips auth", http.MethodOptions,
			map[string]string{"Origin": "http://localhost:9245", "Access-Control-Request-Method": "POST"}, http.StatusNoContent, "http://localhost:9245"},
		{"bare OPTIONS needs auth", http.MethodOptions, nil, http.StatusUnauthorized, ""},
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
