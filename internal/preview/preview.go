// Package preview serves files to the File tab's HTML preview. The frame cannot send the
// daemon's bearer token (an <iframe src> carries no headers), so the GUI asks
// FilesystemService.PreviewFile for a grant: an unguessable id bound to one directory
// tree (the registered checkout holding the file, else its directory). The grant goes in
// the URL and is the credential for GET /preview/<grant>/<path> on the loopback
// listener, mounted outside the bearer check. A grant reads only its tree, never above it
// or outside the home directory (symlinks resolved), and lasts until the daemon stops.
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

// Grants maps grant ids to the directory each may serve. One grant per directory: asking
// again for the same directory returns the same id.
type Grants struct {
	mu    sync.Mutex
	byDir map[string]string
	byID  map[string]string
}

// NewGrants returns an empty grant table.
func NewGrants() *Grants {
	return &Grants{byDir: map[string]string{}, byID: map[string]string{}}
}

// Grant returns the id that serves dir (absolute, cleaned), minting one on first use.
func (g *Grants) Grant(dir string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if id, ok := g.byDir[dir]; ok {
		return id, nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("preview: mint grant: %w", err)
	}
	id := hex.EncodeToString(b)
	g.byDir[dir], g.byID[id] = id, dir
	return id, nil
}

// Dir returns the directory a grant serves.
func (g *Grants) Dir(id string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	dir, ok := g.byID[id]
	return dir, ok
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

// Handler serves GET /preview/<grant>/<path> from the grant's directory. root is the
// home directory, resolved (fsx.ResolveRoot): a file whose symlinks lead outside it, or
// above the grant's directory, is 404 like a missing one. A directory serves its
// index.html. Responses are never cached (the thread edits these files) and carry no
// referrer, so the grant does not leak to the sites a page loads from.
func Handler(root string, g *Grants, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		dir, ok := g.Dir(grant)
		if !ok {
			http.NotFound(w, r)
			return
		}
		p, err := resolve(root, dir, rel)
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
func resolve(root, dir, rel string) (string, error) {
	clean := path.Clean("/" + rel)
	p := filepath.Join(dir, filepath.FromSlash(clean))
	if !fsx.Within(dir, p) {
		return "", fs.ErrNotExist
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", err
	}
	if !fsx.Within(root, real) {
		return "", fs.ErrNotExist
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return resolve(root, dir, path.Join(clean, "index.html"))
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
