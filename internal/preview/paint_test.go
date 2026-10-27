package preview

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestPainted(t *testing.T) {
	const tag = "<T>"
	tests := []struct {
		name, doc, want string
		ok              bool
	}{
		{"head", "<!doctype html><html><head><title>x</title></head><body></body></html>", "<!doctype html><html><head><T><title>x</title></head><body></body></html>", true},
		{"head with attributes", `<html lang="en"><head data-x="a>b"><meta charset="utf-8">`, `<html lang="en"><head data-x="a>b"><T><meta charset="utf-8">`, true},
		{"no head", "<!DOCTYPE html>\n<html>\n<body>hi</body></html>", "<!DOCTYPE html>\n<html>\n<T><body>hi</body></html>", true},
		{"no html tag", "<!doctype html><title>x</title><p>hi", "<!doctype html><T><title>x</title><p>hi", true},
		{"a fragment", "<h1>hi</h1>", "<T><h1>hi</h1>", true},
		{"uppercase tags", "<!DOCTYPE HTML><HTML LANG=en><HEAD><TITLE>x</TITLE></HEAD>", "<!DOCTYPE HTML><HTML LANG=en><HEAD><T><TITLE>x</TITLE></HEAD>", true},
		{"byte-order mark", "\xef\xbb\xbf<!doctype html><html><head></head>", "\xef\xbb\xbf<!doctype html><html><head><T></head>", true},
		{"byte-order mark, a fragment", "\xef\xbb\xbf<p>hi", "\xef\xbb\xbf<T><p>hi", true},
		{"comments and white space", "  <!-- <head> --><!doctype html>\n<!-- c --><html><!-- d -->\n<head>", "  <!-- <head> --><!doctype html>\n<!-- c --><html><!-- d -->\n<head><T>", true},
		{"header is not head", "<html><header>top</header>", "<html><T><header>top</header>", true},
		{"htmlx is not html", "<htmlx><head>", "<T><htmlx><head>", true},
		{"self-closed head", "<html><head/><body>", "<html><head/><T><body>", true},
		{"empty document", "", "<T>", true},
		{"unclosed comment", "<!-- never ends <html><head>", "<!-- never ends <html><head>", false},
		{"unclosed doctype", "<!doctype html", "<!doctype html", false},
		{"unclosed head tag", `<html><head lang="en`, `<html><head lang="en`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := painted([]byte(tc.doc), []byte(tag))
			if string(got) != tc.want || ok != tc.ok {
				t.Errorf("painted(%q) = %q, %v; want %q, %v", tc.doc, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestPaintTag(t *testing.T) {
	tests := []struct {
		name, scheme, surface, want string
	}{
		{"dark", "dark", "#0d1117", `<meta name="color-scheme" content="dark"><style>:where(html){background-color:var(--cf-surface, #0d1117)}</style>`},
		{"light with alpha", "light", "#ffffffee", `<meta name="color-scheme" content="light"><style>:where(html){background-color:var(--cf-surface, #ffffffee)}</style>`},
		{"nothing published", "", "", `<meta name="color-scheme" content="light dark"><style>:where(html){background-color:var(--cf-surface, Canvas)}</style>`},
		{"never markup", `dark"><script>`, `#000</style><script>`, `<meta name="color-scheme" content="light dark"><style>:where(html){background-color:var(--cf-surface, Canvas)}</style>`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(paintTag(tc.scheme, tc.surface)); got != tc.want {
				t.Errorf("paintTag = %q, want %q", got, tc.want)
			}
		})
	}
}

// A themed request (?cf-page=1) gets an HTML document painted; anything else, and every
// other file, byte for byte. The headers are the same either way.
func TestHandlerPaints(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(home, "proj")
	page := "<!doctype html><html><head><title>p</title></head><body>hi</body></html>"
	write(t, filepath.Join(proj, "page.html"), page)
	write(t, filepath.Join(proj, "upper.HTM"), "<HTML><BODY>hi")
	write(t, filepath.Join(proj, "app.js"), "document.write('<head>')")
	g := NewGrants(NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))))
	grant, err := g.Grant(proj)
	if err != nil {
		t.Fatal(err)
	}
	paint := func() (string, string) { return "dark", "#0d1117" }
	srv := httptest.NewServer(Handler(g, paint, slog.New(slog.DiscardHandler)))
	t.Cleanup(srv.Close)
	tag := string(paintTag("dark", "#0d1117"))

	tests := []struct {
		name, method, path, want string
	}{
		{"themed page", http.MethodGet, "page.html?cf-page=1", strings.Replace(page, "<head>", "<head>"+tag, 1)},
		{"themed page, HEAD", http.MethodHead, "page.html?cf-page=1", ""},
		{"an unthemed request", http.MethodGet, "page.html", page},
		{"another value", http.MethodGet, "page.html?cf-page=0", page},
		{"themed, no head, upper case", http.MethodGet, "upper.HTM?cf-page=1", "<HTML>" + tag + "<BODY>hi"},
		{"themed script", http.MethodGet, "app.js?cf-page=1", "document.write('<head>')"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(tc.method, srv.URL+"/preview/"+grant+"/"+tc.path, nil)
			res, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			body, _ := io.ReadAll(res.Body)
			if res.StatusCode != http.StatusOK {
				t.Fatalf("status %d", res.StatusCode)
			}
			if tc.method == http.MethodGet && string(body) != tc.want {
				t.Errorf("body %q, want %q", body, tc.want)
			}
			if tc.method == http.MethodGet && res.Header.Get("Content-Length") != strconv.Itoa(len(tc.want)) {
				t.Errorf("Content-Length %q, want %d", res.Header.Get("Content-Length"), len(tc.want))
			}
			for k, want := range map[string]string{
				"Cache-Control":           "no-store",
				"Referrer-Policy":         "no-referrer",
				"X-Content-Type-Options":  "nosniff",
				"Content-Security-Policy": CSP,
			} {
				if got := res.Header.Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
		})
	}
}
