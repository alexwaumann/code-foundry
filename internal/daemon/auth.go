package daemon

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// newToken returns 32 random bytes, hex encoded.
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// writeFileAtomic writes data to path with perm via a temp file and rename, so readers
// never observe a partial file.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// requireBearer rejects requests whose Authorization header does not carry token.
func requireBearer(token string, next http.Handler) http.Handler {
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="code-foundry"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// loopbackHandler is what the TCP listener serves: the open routes, keyed by path prefix,
// and behind CORS and the bearer token everything else. The open routes are what a page in
// the HTML preview loads, which cannot send a header: the preview (preview.Prefix), whose
// credential is the grant in its URL (package preview), and the frame stylesheet
// (theme.FramePrefix), which reveals only colours. Each sets its own CORS header.
func loopbackHandler(token string, open map[string]http.Handler, rest http.Handler) http.Handler {
	m := http.NewServeMux()
	for prefix, h := range open {
		m.Handle(prefix, h)
	}
	m.Handle("/", cors(requireBearer(token, rest)))
	return m
}

// Headers a Connect/gRPC-Web browser client sends and reads. Mirrors connectrpc.com/cors.
var (
	corsAllowHeaders = strings.Join([]string{
		"Authorization", "Content-Type", "Connect-Protocol-Version", "Connect-Timeout-Ms",
		"Connect-Accept-Encoding", "Connect-Content-Encoding", "Grpc-Timeout", "X-Grpc-Web",
		"X-User-Agent",
	}, ", ")
	corsExposeHeaders = strings.Join([]string{
		"Grpc-Status", "Grpc-Message", "Grpc-Status-Details-Bin", "Connect-Content-Encoding",
		"Content-Encoding", "Connect-Accept-Encoding", "Grpc-Accept-Encoding", "Grpc-Encoding",
	}, ", ")
)

// cors lets the Wails webview (origin wails://localhost, or wails://localhost:9245 in
// `wails3 dev`) and a dev frontend in a browser (http://localhost:<port> or
// http://127.0.0.1:<port>, docs/notes/phase1e-gui.md) call the bearer-protected API.
// The bearer token is the boundary, but no other origin is reflected, `null` least of
// all: the HTML preview's pages run with an opaque origin and must not be able to call
// the API even with a token in hand (docs/notes/preview-scope-floor.md). A request from
// another origin gets no CORS headers, so the browser blocks it (a preflight falls
// through to the bearer check and is 401). Preflights are answered before auth because
// browsers never attach Authorization to them.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !allowedOrigin(origin) {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Add("Vary", "Origin")
		h.Set("Access-Control-Allow-Origin", origin)
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			h.Add("Vary", "Access-Control-Request-Method")
			h.Add("Vary", "Access-Control-Request-Headers")
			h.Set("Access-Control-Allow-Methods", "GET, POST")
			h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
			h.Set("Access-Control-Max-Age", "7200")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.Set("Access-Control-Expose-Headers", corsExposeHeaders)
		next.ServeHTTP(w, r)
	})
}

// allowedOrigin reports whether a browser page at origin may call the API: the Wails
// webview (wails://localhost, any port) or a page served from loopback over http(s).
func allowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || (u.Path != "" && u.Path != "/") {
		return false
	}
	switch u.Scheme {
	case "wails":
		return u.Hostname() == "localhost"
	case "http", "https":
		switch u.Hostname() {
		case "localhost", "127.0.0.1", "::1":
			return true
		}
	}
	return false
}
