package daemon

import (
	"net/http"

	"github.com/alexwaumann/code-foundry/internal/preview"
)

// withMedia serves the media route (preview.MediaHandler, docs/notes/file-previews-2-daemon.md)
// on the API listener ahead of next, outside CORS and the bearer check: a <video src> sends
// no header, so the grant in its URL is the credential. Pages never reach it as their own
// origin, and get no CORS headers from it.
func withMedia(media, next http.Handler) http.Handler {
	m := http.NewServeMux()
	m.Handle(preview.MediaPrefix, media)
	m.Handle("/", next)
	return m
}
