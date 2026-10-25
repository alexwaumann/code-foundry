package daemon

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// The pages listener (docs/notes/bridge-1-daemon.md) serves what an HTML page the model
// shows loads without a credential: the preview route (its grant is in the URL) and /cf/
// (the theme and the bridge script). It serves nothing else, and the API listener none of
// it. The split gives pages an origin of their own, http://127.0.0.1:<pages port>, which
// CORS on the API listener refuses (allowedOrigin), so a page holding a leaked token still
// cannot call the API. The port is kept in pages.port and tried again on the next start,
// so a page's origin survives restarts. Its localStorage does not survive the app's: WebKit
// keeps a cross-site frame's storage in memory for the session, so cf.storage is kept by
// the daemon instead (docs/notes/bridge-fix-storage.md).

// listenPages binds the pages listener on loopback: the port in file when it is still
// free, else a new one. A missing, unreadable or taken port is not an error.
func listenPages(log *slog.Logger, file string) (net.Listener, error) {
	if port, ok := lastPagesPort(log, file); ok {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			return ln, nil
		}
		log.Info("the pages listener's last port is taken; pages get a new origin", "port", port, "err", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen pages: %w", err)
	}
	return ln, nil
}

// lastPagesPort reads the port the pages listener had last time; false without a usable one.
func lastPagesPort(log *slog.Logger, file string) (int, bool) {
	raw, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Warn("read pages port", "path", file, "err", err)
		}
		return 0, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || port <= 0 || port > 65535 {
		log.Warn("ignoring a malformed pages port", "path", file, "content", strings.TrimSpace(string(raw)))
		return 0, false
	}
	return port, true
}

// pagesOrigin is the origin pages are served from.
func pagesOrigin(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

// pagesHandler is what the pages listener serves: routes, keyed by path prefix, each
// setting its own headers; every other path is 404.
func pagesHandler(routes map[string]http.Handler) http.Handler {
	m := http.NewServeMux()
	for prefix, h := range routes {
		m.Handle(prefix, h)
	}
	m.Handle("/", http.NotFoundHandler())
	return m
}
