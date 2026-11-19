package main

import "testing"

func TestNavigationVerdict(t *testing.T) {
	const built = "wails://wails/"
	const dev = "wails://wails:9245/"
	tests := []struct {
		name      string
		appURL    string
		target    string
		mainFrame bool
		want      navVerdict
	}{
		{"a route in the built app", built, "wails://wails/threads/abc", true, navAllow},
		{"a reload of the built app", built, built, true, navAllow},
		{"a fragment in the built app", built, "wails://wails/#guide", true, navAllow},
		{"origin compared without case", built, "WAILS://Wails/x", true, navAllow},
		{"a route under gui-dev", dev, "wails://wails:9245/settings", true, navAllow},
		{"another port is another origin", dev, "wails://wails:9999/", true, navRefuse},
		{"the built origin from gui-dev", dev, "wails://wails/", true, navRefuse},
		{"a GitHub pull request (WebKit's Open Link)", built, "https://github.com/o/r/pull/1", true, navOpenInBrowser},
		{"a plain http page", built, "http://example.com/", true, navOpenInBrowser},
		{"a loopback page", built, "http://127.0.0.1:4321/page.html", true, navOpenInBrowser},
		{"a file", built, "file:///Users/someone/notes.md", true, navRefuse},
		{"about:blank", built, "about:blank", true, navRefuse},
		{"a data URL", built, "data:text/html,<b>x</b>", true, navRefuse},
		{"a blob URL", built, "blob:wails://wails/1234", true, navRefuse},
		{"mailto", built, "mailto:someone@example.com", true, navRefuse},
		{"javascript", built, "javascript:alert(1)", true, navRefuse},
		{"http with no host", built, "http:///path", true, navRefuse},
		{"unparseable", built, "http://[::1", true, navRefuse},
		{"a sub-frame goes anywhere", built, "https://example.com/", false, navAllow},
		{"a sub-frame on a file", built, "about:srcdoc", false, navAllow},
		{"no app URL: nothing to compare with", "", "https://example.com/", true, navAllow},
		{"app URL without a host", "about:blank", "https://example.com/", true, navAllow},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := navigationVerdict(tt.appURL, tt.target, tt.mainFrame); got != tt.want {
				t.Fatalf("navigationVerdict(%q, %q, %v) = %v, want %v", tt.appURL, tt.target, tt.mainFrame, got, tt.want)
			}
		})
	}
}
