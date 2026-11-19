package preview

import (
	"net"
	"strconv"
	"strings"
)

// Each grant has an origin of its own on the pages listener, http://<grant>.localhost:<port>
// (docs/notes/page-preview-serving.md), where / is the grant's directory. A page's
// root-absolute URLs (/assets/index.js, the default of most bundlers, href="/about.html",
// <base href="/">) then name files of its own tree, as on any static server, rather than the
// pages listener's root, where nothing is. The host carries the grant as the path did, so a
// grant reads exactly what it read before, and pages of different grants are different
// origins. macOS resolves every *.localhost name to loopback, and WebKit and Go do too; the
// app's App Transport Security lets the webview load plain HTTP from them (the localhost
// exception in gui/build/darwin/Info.*.plist).

// hostSuffix is what follows the grant in a grant's host name.
const hostSuffix = ".localhost"

// GrantOrigin is the origin of grant on the pages listener at port.
func GrantOrigin(grant string, port int) string {
	return "http://" + grant + hostSuffix + ":" + strconv.Itoa(port)
}

// GrantURL is the URL of rel (slash-separated, relative to the grant's directory) on
// grant's own origin, the pages listener at port.
func GrantURL(grant, rel string, port int) string {
	return GrantOrigin(grant, port) + "/" + escapePath(rel)
}

// HostGrant is the grant a request's Host names, <grant>.localhost with a port or none, and
// that port ("" without one); false for any other host. The grant is only well formed: the
// handler looks it up.
func HostGrant(host string) (grant, port string, ok bool) {
	name, p, err := net.SplitHostPort(host)
	if err != nil {
		if strings.Contains(host, ":") {
			return "", "", false
		}
		name, p = host, ""
	}
	g, ok := strings.CutSuffix(strings.ToLower(name), hostSuffix)
	if !ok || !grantID(g) {
		return "", "", false
	}
	return g, p, true
}

// grantID reports whether s has the form of a grant id (mint): 32 lower-case hex digits.
func grantID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := range len(s) {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
