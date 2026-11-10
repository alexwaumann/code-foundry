package preview

import (
	_ "embed"
	"net/http"
)

// A page shown in the app's frame cannot open a window, show a dialog or save a file
// (the GUI's host has none of those for a frame), and a link that left the frame would
// show a site with none of the browser's sign-ins and no way back. frame.js makes up for
// that in the page itself (docs/notes/page-frame-links.md): the daemon writes it, inline,
// into the head of every HTML document a frame navigates to, after the paint tag when
// there is one. A document the page reads with fetch() is served as written.

//go:embed frame.js
var frameJS []byte

var frameTag = append(append([]byte("<script>"), frameJS...), "</script>"...)

// navigated reports whether r loads a document into a frame or a window, by its
// Sec-Fetch-Dest (fetch() and XMLHttpRequest send "empty"). A client that sends none (a
// WebKit before 16.4) is taken to only for a thread's page, which the frame asks for with
// ThemedParam.
func navigated(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Dest") {
	case "document", "iframe", "frame":
		return true
	case "":
		return r.URL.Query().Get(ThemedParam) == "1"
	}
	return false
}
