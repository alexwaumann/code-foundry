package daemon

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bridge"
	"github.com/alexwaumann/code-foundry/internal/pagelib"
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The pages listener (docs/notes/bridge-1-daemon.md) serves what an HTML page the model
// shows loads without a credential: each grant's files on the grant's own host,
// http://<grant>.localhost:<pages port> (preview.GrantOrigin, docs/notes/page-preview-serving.md),
// the preview route (/preview/<grant>/) on a loopback name, and /cf/ (the theme, the bridge
// script and the page library) on both. It serves nothing else, and the API listener none of
// it. The split gives pages origins of their own, on the pages port, which CORS on the API
// listener refuses (allowedOrigin), so a page holding a leaked token still cannot call the
// API. The port is kept in pages.port and tried again on the next start, and a page grant's
// id is derived from a secret kept in pages.key (pagesKey), so a page's origin, and the
// storage WebKit keeps for it, survive a daemon restart. Its localStorage does not survive the
// app's: WebKit keeps a cross-site frame's storage in memory for the session, so cf.storage is
// kept by the daemon instead (docs/notes/bridge-fix-storage.md).

// pagesKey reads the secret page grants' ids are derived from (preview.Grants.WithKey), kept
// in file like the daemon token (0600, in the config home, which no grant may read), or makes
// and writes a new one when there is none or it is not 32 hex-encoded bytes. A new key gives
// every page a new origin once; a key that cannot be written is still used for this run.
func pagesKey(log *slog.Logger, file string) ([]byte, error) {
	raw, err := os.ReadFile(file)
	if err == nil {
		if key, derr := hex.DecodeString(strings.TrimSpace(string(raw))); derr == nil && len(key) == 32 {
			return key, nil
		}
		log.Warn("replacing a malformed pages key; pages get new origins", "path", file)
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Warn("read pages key; pages get new origins", "path", file, "err", err)
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate pages key: %w", err)
	}
	if err := writeFileAtomic(file, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		log.Warn("write pages key; pages get new origins at the next start", "path", file, "err", err)
	}
	return key, nil
}

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

// themePaint is what a thread's page is painted in before its own styles load
// (preview.Paint, docs/notes/inline-page-frame.md): the published theme's scheme and
// surface, none before the GUI publishes.
func themePaint(live *theme.Live) preview.Paint {
	return func() (string, string) {
		f, ok := live.Current()
		if !ok {
			return "", ""
		}
		return f.Scheme, f.Vars["--cf-surface"]
	}
}

// pagesOrigin is the pages listener's origin on a loopback name (the preview route's);
// a grant's own is preview.GrantOrigin.
func pagesOrigin(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

// newPageRoutes is what a page loads without a credential, by path prefix (the most
// specific wins): the preview (its grant in the URL), the theme, the bridge script and the
// page library's files (a route each); none reveals anything.
func newPageRoutes(grants *preview.Grants, liveTheme *theme.Live, log *slog.Logger) map[string]http.Handler {
	routes := map[string]http.Handler{
		preview.Prefix:    preview.Handler(grants, themePaint(liveTheme), log.With("component", "preview")),
		theme.FramePrefix: theme.FrameHandler(liveTheme),
		bridge.Path:       bridge.Handler(),
	}
	maps.Copy(routes, pagelib.Routes())
	return routes
}

// grantHost is what a grant's own host on the pages listener serves (preview.GrantOrigin):
// the grant's files at the root, and, at a path the grant has no file at, missing (the /cf/
// routes).
func grantHost(grants *preview.Grants, liveTheme *theme.Live, log *slog.Logger) func(missing http.Handler) http.Handler {
	return func(missing http.Handler) http.Handler {
		return preview.HandlerMissing(grants, themePaint(liveTheme), missing, log.With("component", "preview"))
	}
}

// pagesHandler is what the pages listener serves. On a loopback name: routes, keyed by path
// prefix, each setting its own headers; every other path is 404. On a grant's own host
// (<grant>.localhost): own, given the routes other than the preview route for the paths the
// grant has no file at; a nil own serves 404 there.
func pagesHandler(routes map[string]http.Handler, own func(missing http.Handler) http.Handler) http.Handler {
	m, cf := http.NewServeMux(), http.NewServeMux()
	for prefix, h := range routes {
		m.Handle(prefix, h)
		if prefix != preview.Prefix {
			cf.Handle(prefix, h)
		}
	}
	m.Handle("/", http.NotFoundHandler())
	cf.Handle("/", http.NotFoundHandler())
	var grant http.Handler = http.NotFoundHandler()
	if own != nil {
		grant = own(cf)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := preview.HostGrant(r.Host); ok {
			grant.ServeHTTP(w, r)
			return
		}
		m.ServeHTTP(w, r)
	})
}
