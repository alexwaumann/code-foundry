// Package preview serves files to the File tab's HTML preview. The frame cannot send the
// daemon's bearer token (an <iframe src> carries no headers), so the GUI asks
// FilesystemService.PreviewFile for a grant: an unguessable id bound to one directory
// tree (the registered checkout holding the file, else its directory) or, when that
// directory is too broad for the Floor (home itself, a temp folder, an ancestor of the
// config home), to the one file. The grant goes in the URL and is the credential for
// GET /preview/<grant>/<path> on the loopback listener, mounted outside the bearer check.
// A grant reads only its tree, never above it, outside the home directory and the temp
// folders or inside a guarded folder (symlinks resolved), and lasts until the daemon stops.
// A grant in a temp folder reads only its own tree, and what is in a temp folder only such a
// grant reads: anyone can plant a link there, or swap a file for one mid-read (open.go).
//
// The route is served on the daemon's pages listener, not the API's
// (docs/notes/bridge-1-daemon.md). Its CSP sandbox keeps scripts and forms on and allows
// same-origin, so a page in a frame (whose sandbox allows it too) has the pages origin,
// http://127.0.0.1:<pages port>, and its storage, across reloads and restarts. That origin
// is never the API's: the API listens on another port and its CORS refuses the pages
// origin, so a page cannot call it even holding a token.
package preview

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// Prefix is the route the handler is mounted on.
const Prefix = "/preview/"

// ErrGuarded is returned for a grant the Floor forbids.
var ErrGuarded = errors.New("preview: path is guarded")

// Grants maps grant ids to what each may serve: a directory tree, or one file. One grant
// per tree or file: asking again returns the same id. Every grant clears the Floor.
type Grants struct {
	floor Floor
	mu    sync.Mutex
	byKey map[entry]string
	byID  map[string]entry
}

// entry is what a grant serves: the tree dir, or only file (in dir) when file is set.
type entry struct{ dir, file string }

// NewGrants returns an empty grant table whose grants clear floor.
func NewGrants(floor Floor) *Grants {
	return &Grants{floor: floor, byKey: map[entry]string{}, byID: map[string]entry{}}
}

// Allows reports whether dir may be a grant's whole tree (Floor.ScopeOK).
func (g *Grants) Allows(dir string) bool { return g.floor.ScopeOK(dir) }

// Guarded reports whether no grant may serve p (Floor.Guarded).
func (g *Grants) Guarded(p string) bool { return g.floor.Guarded(p) }

// ConfigHome is Floor.InConfigHome: whether a write may not reach p.
func (g *Grants) ConfigHome(p string) bool { return g.floor.InConfigHome(p) }

// Grant returns the id that serves the tree dir (absolute, cleaned), minting one on first
// use; ErrGuarded when the Floor does not allow dir as a tree.
func (g *Grants) Grant(dir string) (string, error) {
	if !g.floor.ScopeOK(dir) {
		return "", fmt.Errorf("%w: %s", ErrGuarded, dir)
	}
	return g.mint(entry{dir: dir})
}

// GrantFile returns the id that serves file (absolute, cleaned) and nothing else, for a
// file whose directory may not be a tree; ErrGuarded when the file itself is guarded.
func (g *Grants) GrantFile(file string) (string, error) {
	if g.floor.Guarded(file) || !g.floor.reaches(file) {
		return "", fmt.Errorf("%w: %s", ErrGuarded, file)
	}
	return g.mint(entry{dir: filepath.Dir(file), file: file})
}

func (g *Grants) mint(e entry) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if id, ok := g.byKey[e]; ok {
		return id, nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("preview: mint grant: %w", err)
	}
	id := hex.EncodeToString(b)
	g.byKey[e], g.byID[id] = id, e
	return id, nil
}

func (g *Grants) lookup(id string) (entry, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e, ok := g.byID[id]
	return e, ok
}

// CSP is the sandbox every served file runs in: the frame's own (the GUI's HtmlFrame) can
// only narrow it. allow-same-origin gives a page the pages origin and its storage; never
// allow-top-navigation, so a page cannot replace the app.
const CSP = "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"

// URL is the root-relative URL of rel (slash-separated, relative to the grant's
// directory) under grant.
func URL(grant, rel string) string {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		segs[i] = escapeSegment(s)
	}
	return Prefix + grant + "/" + strings.Join(segs, "/")
}

// escapeSegment percent-encodes one path segment the way a URL path needs ("#", "?",
// "%" and spaces included), leaving the unreserved and sub-delimiter characters alone.
func escapeSegment(s string) string {
	var b strings.Builder
	for i := range len(s) {
		c := s[i]
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9',
			c == '-', c == '.', c == '_', c == '~', c == '!', c == '$', c == '&', c == '\'',
			c == '(', c == ')', c == '*', c == '+', c == ',', c == ';', c == '=', c == ':', c == '@':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// Handler serves GET /preview/<grant>/<path> from the grant's directory (only its file,
// for a one-file grant). A file whose symlinks lead out of home for a home grant, out of the
// tree for a temp grant (open) or into a guarded folder (the Floor: the config home's token and
// database, ~/.ssh, compared by file identity, so a folded spelling or a hard link is no way
// around it), or a path above the grant's directory, is 404 like a missing one. A directory serves its
// index.html. Responses are never cached (the thread edits these files), carry no
// referrer, so the grant does not leak to the sites a page loads from, and allow any
// origin: a page reads its own files with fetch(), and a frame that is not same-origin
// (an older sandbox, a page opened elsewhere) must still be able to. An HTML document asked
// for with ThemedParam is painted in paint's theme (paint.go); a nil paint paints nothing.
func Handler(g *Grants, paint Paint, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Any origin, on errors too, so a page's fetch() sees a 404 rather than a CORS failure.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		grant, rel, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, Prefix), "/")
		if !ok || grant == "" {
			http.NotFound(w, r)
			return
		}
		e, ok := g.lookup(grant)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if e.file != "" && filepath.Join(e.dir, filepath.FromSlash(path.Clean("/"+rel))) != e.file {
			http.NotFound(w, r)
			return
		}
		f, p, err := open(g.floor, e, rel)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				log.Warn("preview read failed", "path", rel, "err", err)
			}
			http.NotFound(w, r)
			return
		}
		defer func() { _ = f.Close() }()
		var tag []byte
		if paint != nil && r.URL.Query().Get(ThemedParam) == "1" {
			tag = paintTag(paint())
		}
		serve(w, r, f, p, tag)
	})
}

// serve writes the open file f, whose real path is p; an HTML document gets tag (paint.go)
// when tag is not nil.
func serve(w http.ResponseWriter, r *http.Request, f *os.File, p string, tag []byte) {
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	head := make([]byte, fsx.BinarySniff)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	ctype := contentType(p, head[:n])
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", CSP)
	if tag != nil && strings.HasPrefix(ctype, "text/html") && servePainted(w, r, f, fi, tag) {
		return
	}
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// contentType is fsx.DetectMIME with a UTF-8 charset on text types that name none, so
// the page's text is not read as Latin-1 when it has no <meta charset>.
func contentType(name string, head []byte) string {
	t := fsx.DetectMIME(name, head)
	if strings.HasPrefix(t, "text/") && !strings.Contains(t, "charset") {
		t += "; charset=utf-8"
	}
	return t
}
