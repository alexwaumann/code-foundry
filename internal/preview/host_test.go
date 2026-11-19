package preview

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestHostGrant(t *testing.T) {
	const g = "0123456789abcdef0123456789abcdef"
	tests := []struct {
		host, grant, port string
		ok                bool
	}{
		{g + ".localhost:9300", g, "9300", true},
		{g + ".localhost", g, "", true},
		{strings.ToUpper(g) + ".LOCALHOST:9300", g, "9300", true},
		{"127.0.0.1:9300", "", "", false},
		{"localhost:9300", "", "", false},
		{g + ".localhost.:9300", "", "", false},
		{g + ".example:9300", "", "", false},
		{"x." + g + ".localhost:9300", "", "", false},
		{g[:31] + ".localhost:9300", "", "", false},
		{g + "0.localhost:9300", "", "", false},
		{"0123456789abcdef0123456789abcdeg.localhost", "", "", false},
		{".localhost", "", "", false},
		{g + ".localhost:9300:1", "", "", false},
		{"", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			grant, port, ok := HostGrant(tt.host)
			if grant != tt.grant || port != tt.port || ok != tt.ok {
				t.Errorf("HostGrant(%q) = %q, %q, %v; want %q, %q, %v", tt.host, grant, port, ok, tt.grant, tt.port, tt.ok)
			}
		})
	}
}

func TestGrantURL(t *testing.T) {
	const g = "0123456789abcdef0123456789abcdef"
	if got, want := GrantURL(g, "docs/a b#1/index.html", 9300), "http://"+g+".localhost:9300/docs/a%20b%231/index.html"; got != want {
		t.Errorf("GrantURL = %q, want %q", got, want)
	}
	if got, _, ok := HostGrant(strings.TrimPrefix(GrantOrigin(g, 9300), "http://")); !ok || got != g {
		t.Errorf("HostGrant(GrantOrigin) = %q, %v", got, ok)
	}
}

// On a grant's own host, / is the grant's directory: a build's root-absolute URLs load its own
// files, and nothing outside the grant comes with them. What it has no file at goes to missing.
func TestHandlerGrantHost(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(home, "proj")
	write(t, filepath.Join(proj, "index.html"), "<h1>root</h1>")
	write(t, filepath.Join(proj, "dist", "index.html"), `<script type="module" src="/assets/index.js"></script>`)
	write(t, filepath.Join(proj, "assets", "index.js"), "mount()")
	write(t, filepath.Join(proj, "sub", "index.html"), "<h1>sub</h1>")
	write(t, filepath.Join(proj, "cf", "own.css"), "own")
	write(t, filepath.Join(home, "other", "secret.txt"), "secret")
	write(t, filepath.Join(home, "report.html"), "<p>report</p>")
	write(t, filepath.Join(home, "notes.txt"), "notes")
	g := NewGrants(NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))))
	grant, _ := g.Grant(proj)
	other, _ := g.Grant(filepath.Join(home, "other"))
	one, err := g.GrantFile(filepath.Join(home, "report.html"))
	if err != nil {
		t.Fatal(err)
	}
	missing := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("missing"))
	})
	h := HandlerMissing(g, nil, missing, slog.Default())
	tests := []struct {
		name, host, path string
		status           int
		body, location   string
	}{
		{"the grant's root", grant, "/", 200, "<h1>root</h1>", ""},
		{"a build's page", grant, "/dist/index.html", 200, `<script type="module" src="/assets/index.js"></script>`, ""},
		{"its root-absolute script", grant, "/assets/index.js", 200, "mount()", ""},
		{"a folder without its slash", grant, "/sub", http.StatusMovedPermanently, "", "./sub/"},
		{"the query kept", grant, "/sub?tab=2", http.StatusMovedPermanently, "", "./sub/?tab=2"},
		{"a folder with its slash", grant, "/sub/", 200, "<h1>sub</h1>", ""},
		{"its own cf folder wins", grant, "/cf/own.css", 200, "own", ""},
		{"the daemon's /cf/ for what it lacks", grant, "/cf/theme.css", http.StatusTeapot, "missing", ""},
		{"another grant's path is its own", grant, "/preview/" + other + "/secret.txt", http.StatusTeapot, "missing", ""},
		{"above the grant", grant, "/../other/secret.txt", http.StatusTeapot, "missing", ""},
		{"the other grant on its host", other, "/secret.txt", 200, "secret", ""},
		{"a one-file grant's file", one, "/report.html", 200, "<p>report</p>", ""},
		{"a one-file grant's sibling", one, "/notes.txt", http.StatusTeapot, "missing", ""},
		{"a one-file grant's root", one, "/", http.StatusTeapot, "missing", ""},
		{"an unknown grant", "0123456789abcdef0123456789abcdef", "/index.html", 404, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			req.Host = tt.host + ".localhost:9300"
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tt.status {
				t.Fatalf("status %d %q, want %d", rec.Code, rec.Body.String(), tt.status)
			}
			if tt.body != "" && rec.Body.String() != tt.body {
				t.Errorf("body %q, want %q", rec.Body.String(), tt.body)
			}
			if got := rec.Header().Get("Location"); got != tt.location {
				t.Errorf("Location %q, want %q", got, tt.location)
			}
		})
	}
}

// A folder without its trailing slash redirects to it on the preview route too, in a home
// tree and in a temp one (whose index is found another way, openTemp); a one-file grant has
// no folder to redirect to.
func TestHandlerFolderRedirect(t *testing.T) {
	f, at := tempFloor(t)
	write(t, at("private/tmp/foo/page/index.html"), "<h1>temp</h1>")
	write(t, at("home/site/sub/index.html"), "<h1>home</h1>")
	write(t, at("home/site/sub:x/index.html"), "<h1>colon</h1>")
	write(t, at("home/one.html"), "one")
	g := NewGrants(f)
	tmp, err := g.Grant(at("tmp/foo"))
	if err != nil {
		t.Fatal(err)
	}
	site, err := g.Grant(at("home/site"))
	if err != nil {
		t.Fatal(err)
	}
	one, err := g.GrantFile(at("home/one.html"))
	if err != nil {
		t.Fatal(err)
	}
	h := Handler(g, nil, slog.Default())
	tests := []struct {
		name, path string
		status     int
		location   string
	}{
		{"temp tree", Prefix + tmp + "/page", http.StatusMovedPermanently, "./page/"},
		{"temp tree with its slash", Prefix + tmp + "/page/", 200, ""},
		{"home tree", Prefix + site + "/sub?a=1", http.StatusMovedPermanently, "./sub/?a=1"},
		{"a segment that reads as a scheme", Prefix + site + "/sub:x", http.StatusMovedPermanently, "./sub:x/"},
		{"an escaped segment stays escaped", Prefix + site + "/sub%3Ax", http.StatusMovedPermanently, "./sub%3Ax/"},
		{"the grant's own root", Prefix + site + "/", 404, ""},
		{"a missing folder", Prefix + site + "/nope", 404, ""},
		{"a one-file grant", Prefix + one + "/one.html", 200, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if rec.Code != tt.status {
				t.Fatalf("status %d %q, want %d", rec.Code, rec.Body.String(), tt.status)
			}
			if got := rec.Header().Get("Location"); got != tt.location {
				t.Errorf("Location %q, want %q", got, tt.location)
			}
			if tt.location != "" && rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("a redirect the next edit can undo is cached: %q", rec.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestContentTypeCharset(t *testing.T) {
	pad := strings.Repeat(" ", 1100)
	tests := []struct {
		name, file, head, want string
	}{
		{"html without a charset", "a.html", "<p>x</p>", "text/html; charset=utf-8"},
		{"meta charset", "a.html", `<!doctype html><meta charset="iso-8859-1"><p>caf`, "text/html; charset=iso-8859-1"},
		{"unquoted, any case", "a.htm", `<META CHARSET=Windows-1252>`, "text/html; charset=windows-1252"},
		{"http-equiv", "a.html", `<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">`, "text/html; charset=shift_jis"},
		{"utf-8 declared", "a.html", `<meta charset="utf-8">`, "text/html; charset=utf-8"},
		{"past the first 1024 bytes", "a.html", "<p>" + pad + `<meta charset="iso-8859-1">`, "text/html; charset=utf-8"},
		{"a UTF-8 byte-order mark wins", "a.html", "\xef\xbb\xbf<meta charset=\"iso-8859-1\">", "text/html; charset=utf-8"},
		{"a UTF-16 byte-order mark is the browser's", "a.html", "\xff\xfe<\x00p\x00>\x00", "text/html"},
		{"utf-16 declared in ASCII is UTF-8", "a.html", `<meta charset="utf-16">`, "text/html; charset=utf-8"},
		{"x-user-defined", "a.html", `<meta charset="x-user-defined">`, "text/html; charset=windows-1252"},
		{"nothing but a label", "a.html", `<meta charset="latin1;evil=1">`, "text/html; charset=latin1"},
		{"another text type", "a.css", `<meta charset="iso-8859-1">`, "text/css; charset=utf-8"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := contentType(tt.file, []byte(tt.head)); got != tt.want {
				t.Errorf("contentType = %q, want %q", got, tt.want)
			}
		})
	}
}
