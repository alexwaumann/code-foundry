package daemon

import (
	"net"
	"net/http"
	"strconv"
	"strings"
)

// loopbackHost serves a TCP listener's requests only when their Host names it: a loopback
// name (127.0.0.1, localhost, [::1]) with the listener's port, or with none. Anything else
// is 421, before CORS, the bearer check or a grant. A browser sends the Host of the URL it
// loads, so a web page whose own name a DNS rebinding pointed at 127.0.0.1 sends its own
// name and gets nothing, even holding a token or a grant (docs/notes/bridge-fix-floor.md).
// The CLI, the Wails webview and pages all use http://127.0.0.1:<port>.
func loopbackHost(port int, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(r.Host, port) {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// allowedHost reports whether host (a request's Host) is a loopback name with port or
// with no port.
func allowedHost(host string, port int) bool {
	name, p, err := net.SplitHostPort(host)
	if err != nil {
		// No port: a bare name, or a bracketed v6 address (never a bare one).
		name, p = host, ""
		if v6, ok := strings.CutPrefix(host, "["); ok {
			if name, ok = strings.CutSuffix(v6, "]"); !ok {
				return false
			}
		} else if strings.Contains(host, ":") {
			return false
		}
	}
	switch strings.ToLower(name) {
	case "127.0.0.1", "localhost", "::1":
	default:
		return false
	}
	return p == "" || p == strconv.Itoa(port)
}
