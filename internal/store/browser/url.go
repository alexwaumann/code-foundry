package browser

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// maxURL bounds what a surface will navigate to.
const maxURL = 8 << 10

// ErrBadURL is every refused address: only http and https reach Chrome.
var ErrBadURL = errors.New("not an http or https address")

// schemeAt finds what a typed address says its scheme is: "javascript" in javascript:x.
var schemeAt = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)

// hostPort is the one thing with a colon that is not a scheme: localhost:5173/x.
var hostPort = regexp.MustCompile(`^[a-zA-Z0-9.-]+:[0-9]{1,5}(?:[/?#].*)?$`)

// refused are schemes that hostPort would otherwise read as a host, like javascript:1.
var refused = []string{"about", "blob", "chrome", "chrome-extension", "chrome-untrusted", "data", "devtools", "file", "filesystem", "javascript", "view-source", "vbscript", "ws", "wss"}

// CheckURL is the rule every address passes before Chrome sees it, from the address bar or
// from view.panel.browser: an absolute http or https URL with a host and no credentials. It
// returns the URL as it will be sent. The refusal never quotes the address.
func CheckURL(raw string) (string, error) {
	if len(raw) > maxURL {
		return "", fmt.Errorf("%w: too long", ErrBadURL)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", ErrBadURL
	}
	if s := strings.ToLower(u.Scheme); s != "http" && s != "https" {
		return "", ErrBadURL
	}
	if u.Hostname() == "" || u.Opaque != "" {
		return "", ErrBadURL
	}
	if u.User != nil {
		return "", fmt.Errorf("%w: it carries a user name or password", ErrBadURL)
	}
	return u.String(), nil
}

// NormalizeURL reads what a person types in an address bar and hands it to CheckURL: a bare
// host gets https, a local one http, and anything naming another scheme is refused.
func NormalizeURL(typed string) (string, error) {
	s := strings.TrimSpace(typed)
	if s == "" || strings.ContainsAny(s, " \t\r\n") {
		return "", ErrBadURL
	}
	scheme, _, named := strings.Cut(s, ":")
	if schemeAt.MatchString(s) && named {
		if slices.Contains(refused, strings.ToLower(scheme)) {
			return "", ErrBadURL
		}
		if !hostPort.MatchString(s) {
			return CheckURL(s)
		}
	}
	s = strings.TrimPrefix(s, "//")
	if local(s) {
		return CheckURL("http://" + s)
	}
	return CheckURL("https://" + s)
}

// local reports a loopback host, where a dev server speaks plain http.
func local(s string) bool {
	u, err := url.Parse("http://" + s)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// allowedPage reports whether a page Chrome ended up on is one a surface may show. Chrome
// keeps pages from navigating to these; this is the check behind it, and what a viewer is
// told when it ever fails. about:blank and Chrome's error pages are its own.
func allowedPage(raw string) bool {
	if raw == "" || raw == "about:blank" || strings.HasPrefix(raw, "chrome-error://") {
		return true
	}
	scheme, _, ok := strings.Cut(raw, ":")
	if !ok {
		return false
	}
	switch strings.ToLower(scheme) {
	case "http", "https", "blob", "data", "about":
		return true
	}
	return false
}

// webScheme matches an address whose authority can carry a user name: Chrome writes the scheme
// in lower case.
var webScheme = regexp.MustCompile(`^https?://`)

// shownURL is a page's address as a viewer may see it, with any user name and password gone. A
// page can navigate itself to http://bank.example%2Flogin:x@evil.test/, and the address bar must
// not lead with words the page chose. Done by hand and not by url.Parse, which refuses some of
// what Chrome accepts, and what it refuses would then show raw.
func shownURL(raw string) string {
	head := webScheme.FindString(raw)
	if head == "" {
		return raw
	}
	rest := raw[len(head):]
	end := strings.IndexAny(rest, `/?#\`)
	if end < 0 {
		end = len(rest)
	}
	if at := strings.LastIndexByte(rest[:end], '@'); at >= 0 {
		return head + rest[at+1:]
	}
	return raw
}

// siteOf is the domain an address is registered under, which a viewer keeps visible however long
// the host: "example.co.uk" for https://a.b.example.co.uk/. An IP address or a single-label host
// has none and is itself; an address with no host has nothing to show.
func siteOf(raw string) string {
	u, err := url.Parse(shownURL(raw))
	if err != nil {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return ""
	}
	if net.ParseIP(host) != nil {
		return host
	}
	if site, err := publicsuffix.EffectiveTLDPlusOne(host); err == nil {
		return site
	}
	return host
}
