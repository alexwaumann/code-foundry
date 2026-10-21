// Package preview serves files to the File tab's HTML preview. The frame cannot send the
// daemon's bearer token (an <iframe src> carries no headers), so the GUI asks
// FilesystemService.PreviewFile for a grant: an unguessable id bound to one directory
// tree (the registered checkout holding the file, else its directory) or, when that
// directory is too broad for the Floor (home itself, an ancestor of the config home), to
// the one file. The grant goes in the URL and is the credential for
// GET /preview/<grant>/<path> on the loopback listener, mounted outside the bearer check.
// A grant reads only its tree, never above it, outside the home directory or inside a
// guarded folder (symlinks resolved), and lasts until the daemon stops.
//
// The page loads with the frame's sandbox (scripts on, same-origin off) and a CSP sandbox
// header that keeps it opaque even if its URL is opened in a browser, so it cannot become
// same-origin with the daemon; the other routes still need the bearer token anyway.
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
	if g.floor.Guarded(file) || !fsx.Within(g.floor.Home(), file) {
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

// Dir returns the directory a grant serves (the file's directory for a one-file grant).
func (g *Grants) Dir(id string) (string, bool) {
	e, ok := g.lookup(id)
	return e.dir, ok
}

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
// for a one-file grant). A file whose symlinks lead outside the home directory or into a
// guarded folder (the Floor: the config home's token and database, ~/.ssh), or a path
// above the grant's directory, is 404 like a missing one. A directory serves its
// index.html. Responses are never cached (the thread edits these files), carry no
// referrer, so the grant does not leak to the sites a page loads from, and allow any
// origin: the page is opaque-origin and reads its own files with fetch().
func Handler(g *Grants, log *slog.Logger) http.Handler {
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
		p, err := resolve(g.floor, e.dir, rel)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				log.Warn("preview read failed", "path", rel, "err", err)
			}
			http.NotFound(w, r)
			return
		}
		serve(w, r, p)
	})
}

// resolve maps a request path to the regular file it names under dir, or ErrNotExist.
func resolve(floor Floor, dir, rel string) (string, error) {
	clean := path.Clean("/" + rel)
	p := filepath.Join(dir, filepath.FromSlash(clean))
	if !fsx.Within(dir, p) {
		return "", fs.ErrNotExist
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	if !fsx.Within(floor.Home(), real) || floor.Guarded(real) {
		return "", fs.ErrNotExist
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return resolve(floor, dir, path.Join(clean, "index.html"))
	}
	if !fi.Mode().IsRegular() {
		return "", fs.ErrNotExist
	}
	return real, nil
}

func serve(w http.ResponseWriter, r *http.Request, p string) {
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
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
	h.Set("Content-Type", contentType(p, head[:n]))
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads")
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
