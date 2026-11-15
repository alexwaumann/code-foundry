package preview

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// The media route streams one video or audio file to the File tab's player
// (docs/notes/file-previews-2-daemon.md). A <video src> or <audio src> sends no header, so,
// as for a page, the credential is a grant in the URL: FilesystemService.StreamFile mints
// one per file in the same table as the preview's, and GET /media/<grant>/<name> serves it
// with Range support. Unlike a preview grant it is not held to the Floor but to ReadFile's
// own rules, asked again on every request (fsx.OpenMedia): the file the path leads to
// now, under home or a temp folder, symlinks resolved, and a media type by name, both the
// path's and the real file's. It runs no script and reads no other file, so it gives
// nothing ReadFile does not, and only a media type is ever served: this is no file server.
//
// It is mounted on the API listener, outside the bearer check, not on the pages listener:
// a page there has that listener's origin and could fetch a media grant's bytes as its
// own, while from it the API listener is another origin that sends no CORS headers.

// MediaPrefix is the route MediaHandler is mounted on.
const MediaPrefix = "/media/"

// ErrNotMedia is GrantMedia's refusal of a file that is not video or audio.
var ErrNotMedia = errors.New("preview: not a video or audio file")

// GrantMedia returns the id that streams the media file at path (absolute, cleaned, as
// asked: symlinks are followed on each request) on the media route, minting one on first
// use; ErrNotMedia when its name is no media type (fsx.MediaType). Whether the file may be
// read is asked when it is served, not here.
func (g *Grants) GrantMedia(path string) (string, error) {
	if _, ok := fsx.MediaType(path); !ok || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", fmt.Errorf("%w: %s", ErrNotMedia, path)
	}
	return g.mint(entry{dir: filepath.Dir(path), file: path, media: true})
}

// MediaURL is the root-relative URL that streams the file at path under the media grant.
// The name is the file's own, so the URL says what it is; the route checks it.
func MediaURL(grant, path string) string {
	return MediaPrefix + grant + "/" + escapeSegment(filepath.Base(path))
}

// MediaHandler serves GET and HEAD /media/<grant>/<name>: the media grant's file, whole or
// the ranges asked (http.ServeContent: 206, and 416 for a range past the end), however
// large. Anything else is 404 alike: an unknown grant, a grant of the preview's, a name that
// is not the file's, and a file fsx.OpenMedia refuses now (gone, a directory, not regular,
// out of reach, a link to something that is no media, kept closed by macOS). Responses are
// never cached (the file can change under the same URL), carry no referrer, are not
// sniffed, and run in a sandbox if opened as a document. They send no CORS headers: a
// media element needs none, and no page may read the bytes.
func MediaHandler(g *Grants, log *slog.Logger) http.Handler {
	roots := g.floor.roots()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		grant, name, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, MediaPrefix), "/")
		if !ok || grant == "" {
			http.NotFound(w, r)
			return
		}
		e, ok := g.lookup(grant)
		if !ok || !e.media || name != filepath.Base(e.file) {
			http.NotFound(w, r)
			return
		}
		f, c, err := fsx.OpenMedia(roots, "", e.file)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				log.Debug("media read refused", "path", e.file, "err", err)
			}
			http.NotFound(w, r)
			return
		}
		defer func() { _ = f.Close() }()
		h := w.Header()
		h.Set("Content-Type", c.MIMEType)
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "sandbox")
		http.ServeContent(w, r, name, c.ModifiedAt, f)
	})
}
