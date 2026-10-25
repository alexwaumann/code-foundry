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
	"slices"
	"strconv"
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

// loopbackHandler is what the API's TCP listener serves: everything behind CORS and the
// bearer token. The paths the pages listener serves (pagesHandler) are 404 here, token or
// not: a page loads them from its own origin, never the API's. pagesPort is that
// listener's port, whose origin CORS refuses even when listed in devOrigins
// (allowedOrigin).
func loopbackHandler(token string, pagePrefixes []string, pagesPort int, devOrigins []string, rest http.Handler) http.Handler {
	m := http.NewServeMux()
	for _, prefix := range pagePrefixes {
		m.Handle(prefix, http.NotFoundHandler())
	}
	m.Handle("/", cors(pagesPort, devOrigins, requireBearer(token, rest)))
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
// `wails3 dev`) call the bearer-protected API, and with it, only in dev mode
// (`daemon --dev`), the dev frontend in a browser at the loopback origins devOrigins lists
// (EnvDevOrigins, docs/notes/phase1e-gui.md). The bearer token is the boundary, but no
// other origin is reflected: not `null` (an opaque-origin page,
// docs/notes/preview-scope-floor.md), not this daemon's pages origin (loopback on
// pagesPort, which a page has once its frame is same-origin with its own URL,
// docs/notes/bridge-1-daemon.md), and not any other loopback port, which may be another
// daemon's pages origin: a page served by a test daemon beside this one must not be able
// to call this daemon's API even holding its token (docs/notes/bridge-fix-crosshome.md).
// A request from another origin gets no CORS headers, so the browser blocks it (a
// preflight falls through to the bearer check and is 401). Preflights are answered before
// auth because browsers never attach Authorization to them.
func cors(pagesPort int, devOrigins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !allowedOrigin(origin, pagesPort, devOrigins) {
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
// webview (wails://localhost, any port), or one of devOrigins (canonical, ParseDevOrigins)
// unless it is on the pages listener's port, whatever loopback name it uses (a page may
// navigate its frame to http://localhost:<pages port>/preview/...).
func allowedOrigin(origin string, pagesPort int, devOrigins []string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.User != nil || (u.Path != "" && u.Path != "/") {
		return false
	}
	if u.Scheme == "wails" {
		return u.Hostname() == "localhost"
	}
	c, ok := canonicalOrigin(u)
	return ok && (pagesPort == 0 || originPort(u) != pagesPort) && slices.Contains(devOrigins, c)
}

// EnvDevOrigins lists the loopback origins a dev daemon (`daemon --dev`) lets call its
// API, comma separated: a port stands for http://127.0.0.1:<port> and
// http://localhost:<port>, anything else is an http(s) origin on localhost, 127.0.0.1 or
// [::1]. Unset, --dev allows DefaultDevOrigins. Without --dev the API allows no loopback
// origin and this is ignored.
const EnvDevOrigins = "CODE_FOUNDRY_DEV_ORIGINS"

// DefaultDevOrigins is what --dev allows without EnvDevOrigins: the Vite dev server's
// port (gui/frontend/vite.config.ts, WAILS_VITE_PORT's default).
const DefaultDevOrigins = "9245"

// ParseDevOrigins parses an EnvDevOrigins list into canonical origins
// (scheme://host:port, the host lowercased and a v6 one bracketed).
func ParseDevOrigins(s string) ([]string, error) {
	var out []string
	for item := range strings.SplitSeq(s, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if port, err := strconv.Atoi(item); err == nil {
			if port <= 0 || port > 65535 {
				return nil, fmt.Errorf("%s: port %d is out of range", EnvDevOrigins, port)
			}
			out = append(out, "http://127.0.0.1:"+item, "http://localhost:"+item)
			continue
		}
		u, err := url.Parse(item)
		if err != nil || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("%s: %q is not an origin", EnvDevOrigins, item)
		}
		c, ok := canonicalOrigin(u)
		if !ok {
			return nil, fmt.Errorf("%s: %q is not an http(s) origin on localhost, 127.0.0.1 or [::1]", EnvDevOrigins, item)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no origins in %q", EnvDevOrigins, s)
	}
	return out, nil
}

// canonicalOrigin is u as scheme://host:port when it is an http(s) origin on a loopback
// name; false otherwise.
func canonicalOrigin(u *url.URL) (string, bool) {
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "localhost", "127.0.0.1":
	case "::1":
		host = "[::1]"
	default:
		return "", false
	}
	port := originPort(&url.URL{Scheme: scheme, Host: u.Host})
	if port <= 0 || port > 65535 {
		return "", false
	}
	return scheme + "://" + host + ":" + strconv.Itoa(port), true
}

// originPort is u's port, the scheme's default when it names none; 0 when malformed.
func originPort(u *url.URL) int {
	p := u.Port()
	if p == "" {
		if u.Scheme == "https" {
			return 443
		}
		return 80
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		return 0
	}
	return n
}
