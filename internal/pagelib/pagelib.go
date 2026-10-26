// Package pagelib serves the page library (docs/notes/page-library.md): what a page the
// model shows loads from /cf/ to be a React app built from the app's own components, with
// no build step. React as ES modules, @cf/ui (every components/ui component and cn) with
// its stylesheet, @cf/icons (all of lucide-react), the TSX loader /cf/jsx.js that installs
// the import map, and the Tailwind browser runtime with the app's theme.
//
// dist/ is built from the GUI's sources by gui/frontend/vite.pagelib.config.ts (`make
// pagelib`, which `make gen` runs) and committed like generated code; `make check`
// rebuilds it and fails on a diff. The daemon serves it as embedded, nothing derived here.
package pagelib

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"
)

// Prefix is where the files are served, on the pages listener beside /cf/theme.css and
// /cf/bridge.js.
const Prefix = "/cf/"

// Import is one specifier of the import map /cf/jsx.js installs and the file it names.
type Import struct {
	Specifier string `json:"specifier"`
	Path      string `json:"path"`
	What      string `json:"what"`
}

// ImportMap is the import map /cf/jsx.js installs (src/pagelib/jsx.ts IMPORTS; the test
// checks the built loader names every path).
var ImportMap = []Import{
	{"react", Prefix + "react.js", "React 19, the app's"},
	{"react-dom", Prefix + "react-dom.js", "createPortal, flushSync"},
	{"react-dom/client", Prefix + "react-dom-client.js", "createRoot"},
	{"react/jsx-runtime", Prefix + "jsx-runtime.js", "what the loader's JSX compiles to"},
	{"@cf/ui", Prefix + "ui.js", "every components/ui component, cn and toast"},
	{"@cf/icons", Prefix + "icons.js", "all of lucide-react"},
}

// The scripts and the stylesheet a page includes by path.
const (
	JSXPath      = Prefix + "jsx.js"
	TailwindPath = Prefix + "tailwind.js"
	UICSSPath    = Prefix + "ui.css"
)

//go:embed dist
var dist embed.FS

// file is one served file: its bytes, type and ETag.
type file struct {
	body  []byte
	ctype string
	etag  string
}

// contentTypes are the served extensions; anything else in dist (ui-exports.json) is not
// served.
var contentTypes = map[string]string{
	".js":  "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
}

// files is every served file by its URL path, read once from the embedded dist.
var files = func() map[string]file {
	out := map[string]file{}
	_ = fs.WalkDir(dist, "dist", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		ctype, ok := contentTypes[path.Ext(p)]
		if !ok {
			return nil
		}
		body, err := dist.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		out[Prefix+strings.TrimPrefix(p, "dist/")] = file{body: body, ctype: ctype, etag: `"` + hex.EncodeToString(sum[:8]) + `"`}
		return nil
	})
	return out
}()

// Paths returns every path served, sorted.
func Paths() []string {
	out := make([]string, 0, len(files))
	for p := range files {
		out = append(out, p)
	}
	slices.Sort(out)
	return out
}

// Size returns the bytes served at p, and false when nothing is.
func Size(p string) (int, bool) {
	f, ok := files[p]
	return len(f.body), ok
}

// UIExports returns @cf/ui's export names, sorted (dist/ui-exports.json, written by the
// build from ui.js itself).
func UIExports() []string {
	raw, err := dist.ReadFile("dist/ui-exports.json")
	if err != nil {
		return nil
	}
	var names []string
	if json.Unmarshal(raw, &names) != nil {
		return nil
	}
	return names
}

// Routes returns a handler per served path, for the pages listener's route map (the most
// specific route wins, so these sit beside the theme's /cf/ prefix).
func Routes() map[string]http.Handler {
	out := make(map[string]http.Handler, len(files))
	for p, f := range files {
		out[p] = handler(p, f)
	}
	return out
}

// handler serves GET (and HEAD) of one file: revalidated by its ETag on every load, so an
// update reaches the next page load and an unchanged file is a 304. Any origin, no
// credential: like the bridge script, it reveals nothing but itself.
func handler(p string, f file) http.Handler {
	name := path.Base(p)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.URL.Path != p {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			h.Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h.Set("Content-Type", f.ctype)
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", f.etag)
		h.Set("X-Content-Type-Options", "nosniff")
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(f.body))
	})
}
