// Package preview serves files to the File tab's HTML preview. The frame cannot send the
// daemon's bearer token (an <iframe src> carries no headers), so the GUI asks
// FilesystemService.PreviewFile for a grant: an unguessable id bound to one directory
// tree (the registered checkout holding the file, else its directory) or, when that
// directory is too broad for the Floor (home itself, a temp folder, an ancestor of the
// config home), to the one file. The grant goes in the URL and is the credential for
// GET /preview/<grant>/<path> on the loopback listener, mounted outside the bearer check.
// A grant reads only its tree, never above it, outside the home directory and the temp
// folders or inside a guarded folder (symlinks resolved), and lasts until the daemon stops.
// A page's grant is minted again with the same id after a restart (WithKey), so its origin,
// and the storage WebKit keeps for it, outlive the daemon; a media grant's id is new each run.
// A grant in a temp folder reads only its own tree, and what is in a temp folder only such a
// grant reads: anyone can plant a link there, or swap a file for one mid-read (open.go).
//
// The route is served on the daemon's pages listener, not the API's
// (docs/notes/bridge-1-daemon.md), and the GUI loads a grant on its own origin there,
// http://<grant>.localhost:<pages port>, where / is the grant's directory (host.go). Its CSP
// sandbox keeps scripts and forms on and allows same-origin, so a page in a frame (whose
// sandbox allows it too) has that origin and its storage, across reloads and daemon restarts. That origin
// is never the API's: the API listens on another port and its CORS refuses every origin on
// the pages port, so a page cannot call it even holding a token.
package preview

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
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
	"regexp"
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
	// key derives a page grant's id from what it serves (WithKey); nil: every id is random.
	key   []byte
	mu    sync.Mutex
	byKey map[entry]string
	byID  map[string]entry
}

// entry is what a grant serves: the tree dir, or only file (in dir) when file is set. A
// media grant (media.go) serves file on the media route, and nothing on the preview route.
type entry struct {
	dir, file string
	media     bool
}

// NewGrants returns an empty grant table whose grants clear floor.
func NewGrants(floor Floor) *Grants {
	return &Grants{floor: floor, byKey: map[entry]string{}, byID: map[string]entry{}}
}

// WithKey makes a page grant's id (Grant, GrantFile) the HMAC of what it serves under key, a
// secret the daemon keeps in its config home, rather than random: the same tree or file gets
// the same id after a restart, so a page keeps its origin (GrantOrigin), and with it the
// localStorage, IndexedDB and cookies WebKit keeps for that origin
// (docs/notes/page-preview-serving.md). Without the key the id is as unguessable as a random
// one. A media grant's id stays random. Call it before the first grant.
func (g *Grants) WithKey(key []byte) *Grants {
	g.key = bytes.Clone(key)
	return g
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
	if g.key != nil && !e.media {
		b = derive(g.key, e)
	} else if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("preview: mint grant: %w", err)
	}
	id := hex.EncodeToString(b)
	if other, ok := g.byID[id]; ok && other != e {
		// Two entries with one HMAC: not expected in practice; refuse rather than serve one's files as the other's.
		return "", fmt.Errorf("preview: mint grant: id collision")
	}
	g.byKey[e], g.byID[id] = id, e
	return id, nil
}

// derive is a page grant's id under key: the first 128 bits of HMAC-SHA256 over what it
// serves, a tree ("dir") or one file ("file"), with a version so a later scheme gets new ids.
// Paths hold no NUL, so the fields cannot run together.
func derive(key []byte, e entry) []byte {
	m := hmac.New(sha256.New, key)
	kind := "dir"
	if e.file != "" {
		kind = "file"
	}
	_, _ = io.WriteString(m, "code-foundry page grant v1\x00"+kind+"\x00"+e.dir+"\x00"+e.file)
	return m.Sum(nil)[:16]
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
// directory) under grant on the preview route, for a server with no pages listener; the
// daemon's are on the grant's own origin (GrantURL).
func URL(grant, rel string) string {
	return Prefix + grant + "/" + escapePath(rel)
}

// escapePath escapes each segment of the slash-separated path rel.
func escapePath(rel string) string {
	segs := strings.Split(rel, "/")
	for i, s := range segs {
		segs[i] = escapeSegment(s)
	}
	return strings.Join(segs, "/")
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

// Handler serves GET /<path> on a grant's own host (HostGrant) and GET
// /preview/<grant>/<path> on any other from the grant's directory (only its file, for a
// one-file grant). A file whose symlinks lead out of home for a home grant, out of the
// tree for a temp grant (open) or into a guarded folder (the Floor: the config home's token and
// database, ~/.ssh, compared by file identity, so a folded spelling or a hard link is no way
// around it), or a path above the grant's directory, is 404 like a missing one. A directory serves its
// index.html, once its URL ends in a slash: without one it redirects there, as a static server
// does, so the index's relative links resolve inside the directory. Responses are never cached (the thread edits these files), carry no
// referrer, so the grant does not leak to the sites a page loads from, and allow any
// origin: a page reads its own files with fetch(), and a frame that is not same-origin
// (an older sandbox, a page opened elsewhere) must still be able to. An HTML document asked
// for with ThemedParam is painted in paint's theme (paint.go); a nil paint paints nothing.
// One a frame navigates to gets frame.js (frame.go).
func Handler(g *Grants, paint Paint, log *slog.Logger) http.Handler {
	return HandlerMissing(g, paint, nil, log)
}

// HandlerMissing is Handler where, on a grant's own host, a path the grant has no file at
// goes to missing when it is not nil: the pages listener's /cf/ routes, which a page's own
// cf/ folder thus wins over.
func HandlerMissing(g *Grants, paint Paint, missing http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Any origin, on errors too, so a page's fetch() sees a 404 rather than a CORS failure.
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		grant, rel, own := requestGrant(r)
		if grant == "" {
			http.NotFound(w, r)
			return
		}
		if !own {
			missing = nil
		}
		e, ok := g.lookup(grant)
		if !ok || e.media {
			http.NotFound(w, r)
			return
		}
		if e.file != "" && filepath.Join(e.dir, filepath.FromSlash(path.Clean("/"+rel))) != e.file {
			notFound(w, r, missing)
			return
		}
		f, p, dir, err := open(g.floor, e, rel)
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				log.Warn("preview read failed", "path", rel, "err", err)
			}
			notFound(w, r, missing)
			return
		}
		defer func() { _ = f.Close() }()
		if dir && toSlash(w, r) {
			return
		}
		var tag []byte
		if paint != nil && r.URL.Query().Get(ThemedParam) == "1" {
			tag = paintTag(paint())
		}
		if navigated(r) {
			tag = append(tag, frameTag...)
		}
		serve(w, r, f, p, tag)
	})
}

// requestGrant is the grant a request names and the path under it: by its host on the
// grant's own origin (own), else by its path on the preview route; no grant for neither.
func requestGrant(r *http.Request) (grant, rel string, own bool) {
	if g, _, ok := HostGrant(r.Host); ok {
		return g, strings.TrimPrefix(r.URL.Path, "/"), true
	}
	grant, rel, ok := strings.Cut(strings.TrimPrefix(r.URL.Path, Prefix), "/")
	if !ok || !strings.HasPrefix(r.URL.Path, Prefix) {
		return "", "", false
	}
	return grant, rel, false
}

// notFound answers a path the grant has no file at: missing's answer when there is one,
// else 404.
func notFound(w http.ResponseWriter, r *http.Request, missing http.Handler) {
	if missing != nil {
		w.Header().Del("Access-Control-Allow-Origin")
		missing.ServeHTTP(w, r)
		return
	}
	http.NotFound(w, r)
}

// toSlash redirects a directory's URL without its trailing slash to the one with it (the
// query kept) and reports whether it did. The Location is relative, its last segment and a
// slash, so it stays on the path asked for.
func toSlash(w http.ResponseWriter, r *http.Request) bool {
	raw := r.URL.EscapedPath()
	last := raw[strings.LastIndex(raw, "/")+1:]
	if last == "" {
		return false
	}
	loc := "./" + last + "/" // "./": a segment like "a:b" is not a scheme
	if r.URL.RawQuery != "" {
		loc += "?" + r.URL.RawQuery
	}
	h := w.Header()
	h.Set("Location", loc)
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(http.StatusMovedPermanently)
	return true
}

// serve writes the open file f, whose real path is p; an HTML document gets tag (paint.go,
// frame.go) at the start of its head when tag is not nil.
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

// contentType is fsx.DetectMIME with a charset on text types that name none: for HTML the
// one htmlCharset finds, else UTF-8, so a page with no <meta charset> is not read as Latin-1.
func contentType(name string, head []byte) string {
	t := fsx.DetectMIME(name, head)
	if !strings.HasPrefix(t, "text/") || strings.Contains(t, "charset") {
		return t
	}
	cs := "utf-8"
	if strings.HasPrefix(t, "text/html") {
		cs = htmlCharset(head)
	}
	if cs == "" {
		return t
	}
	return t + "; charset=" + cs
}

// metaCharsetRe finds a charset in a <meta> tag: <meta charset="…"> or the content of
// <meta http-equiv="Content-Type" content="text/html; charset=…">.
var metaCharsetRe = regexp.MustCompile(`(?i)<meta\s[^>]*?charset\s*=\s*["']?\s*([a-z0-9][a-z0-9._:-]*)`)

// htmlCharset is the charset an HTML document is sent with: the one its first 1024 bytes
// declare (where a browser looks for it), lower case, else UTF-8. The header's charset wins
// over the document's, and frame.js written ahead of the document's own <meta charset>
// would push it past those 1024 bytes, so a declared one is carried in the header. A
// byte-order mark decides first: UTF-8's is utf-8, and a UTF-16 one is left to the browser
// (""), which reads it.
func htmlCharset(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte("\xef\xbb\xbf")):
		return "utf-8"
	case bytes.HasPrefix(head, []byte("\xfe\xff")), bytes.HasPrefix(head, []byte("\xff\xfe")):
		return ""
	}
	if len(head) > 1024 {
		head = head[:1024]
	}
	m := metaCharsetRe.FindSubmatch(head)
	if m == nil {
		return "utf-8"
	}
	switch cs := strings.ToLower(string(m[1])); {
	case strings.HasPrefix(cs, "utf-16"), strings.HasPrefix(cs, "unicode"):
		return "utf-8" // a document whose own meta the browser can read is not UTF-16: it reads it as UTF-8
	case cs == "x-user-defined":
		return "windows-1252"
	default:
		return cs
	}
}
