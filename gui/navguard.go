package main

import (
	"net/url"
	"strings"
)

// The app's window must never leave the app: WebKit's own context menu ("Open Link" on a
// selection that holds a link), a link dragged onto the page, or a link the page forgot to
// handle would otherwise replace the app in its main frame, with no way back but the
// menu's Back item (docs/notes/link-menu-nav-guard.md). Wails sets its own
// WKNavigationDelegate and decides no navigation policy, so navguard_darwin.go adds that
// decision to it and asks navigationVerdict for each navigation.

// navVerdict is what becomes of one navigation.
type navVerdict int

const (
	// navAllow lets the navigation go ahead.
	navAllow navVerdict = iota
	// navRefuse cancels it.
	navRefuse
	// navOpenInBrowser cancels it and opens its URL in the default browser instead: a web
	// page the user meant to see, just not in place of the app.
	navOpenInBrowser
)

func (v navVerdict) String() string {
	switch v {
	case navAllow:
		return "allow"
	case navRefuse:
		return "refuse"
	case navOpenInBrowser:
		return "open in browser"
	}
	return "unknown"
}

// navigationVerdict decides a navigation in a guarded webview. appURL is the page the
// window loaded (its origin is the app's: wails://wails in a built app, wails://wails:<port>
// under `make gui-dev`); target is where the navigation goes; mainFrame is whether it
// replaces the window's own page. A sub-frame (the HTML preview, plugin pages) and a
// navigation in the app's own origin (a route, a reload) go ahead; anything else in the
// main frame is cancelled, and opened in the browser when it is a web page.
func navigationVerdict(appURL, target string, mainFrame bool) navVerdict {
	if !mainFrame {
		return navAllow
	}
	app, err := url.Parse(appURL)
	if err != nil || app.Scheme == "" || app.Host == "" {
		// No origin to compare with: the guard was installed on a page with none. Refusing
		// here would strand a window that has not loaded the app yet.
		return navAllow
	}
	to, err := url.Parse(target)
	if err != nil {
		return navRefuse
	}
	if sameOrigin(app, to) {
		return navAllow
	}
	switch strings.ToLower(to.Scheme) {
	case "http", "https":
		if to.Host != "" {
			return navOpenInBrowser
		}
	}
	return navRefuse
}

// sameOrigin compares scheme, host and port, ignoring case.
func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}
