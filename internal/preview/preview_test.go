package preview

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGrants(t *testing.T) {
	g := NewGrants(NewFloor("/home", paths.New("/home/.code-foundry")))
	a, err := g.Grant("/home/a")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := g.Grant("/home/a")
	b, _ := g.Grant("/home/b")
	if a != again {
		t.Errorf("same dir minted %q then %q", a, again)
	}
	if a == b || len(a) != 32 {
		t.Errorf("grants %q %q", a, b)
	}
	if d, ok := g.Dir(b); !ok || d != "/home/b" {
		t.Errorf("Dir(%q) = %q, %v", b, d, ok)
	}
	if _, ok := g.Dir("nope"); ok {
		t.Error("unknown grant resolved")
	}
	file, err := g.GrantFile("/home/a")
	if err != nil || file == a {
		t.Errorf("GrantFile(/home/a) = %q, %v; the tree grant is %q", file, err, a)
	}
	for _, dir := range []string{"/home", "/", "/home/.code-foundry", "/home/.ssh", "/elsewhere"} {
		if _, err := g.Grant(dir); !errors.Is(err, ErrGuarded) {
			t.Errorf("Grant(%s) err = %v, want ErrGuarded", dir, err)
		}
	}
	for _, file := range []string{"/home/.code-foundry/daemon.token", "/home/.ssh/id_rsa", "/elsewhere/x.html"} {
		if _, err := g.GrantFile(file); !errors.Is(err, ErrGuarded) {
			t.Errorf("GrantFile(%s) err = %v, want ErrGuarded", file, err)
		}
	}
}

func TestURL(t *testing.T) {
	got := URL("g1", "docs/a b#1/index.html")
	if want := "/preview/g1/docs/a%20b%231/index.html"; got != want {
		t.Errorf("URL = %q, want %q", got, want)
	}
}

func TestHandler(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(home, "proj")
	write(t, filepath.Join(proj, "docs", "index.html"), "<h1>hi</h1>")
	write(t, filepath.Join(proj, "docs", "app.js"), "console.log(1)")
	write(t, filepath.Join(proj, "assets", "logo.png"), "\x89PNG\r\n\x1a\n")
	write(t, filepath.Join(home, "secret.txt"), "no")
	write(t, filepath.Join(outside, "evil.html"), "no")
	if err := os.Symlink(filepath.Join(outside, "evil.html"), filepath.Join(proj, "docs", "link.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "secret.txt"), filepath.Join(proj, "docs", "up.txt")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, ".code-foundry", "daemon.token"), "token")
	write(t, filepath.Join(home, ".ssh", "id_rsa"), "key")
	write(t, filepath.Join(home, "cf-1", "daemon.token"), "token")
	write(t, filepath.Join(home, "cf-1", "db.sqlite"), "db")
	write(t, filepath.Join(home, "cf-1", "worktrees", "app", "index.html"), "<p>wt</p>")
	write(t, filepath.Join(home, "report.html"), "<p>report</p>")
	write(t, filepath.Join(home, "notes.txt"), "sibling")
	for link, target := range map[string]string{
		"token.txt": filepath.Join(home, ".code-foundry", "daemon.token"),
		"ssh":       filepath.Join(home, ".ssh"),
		// Another daemon's home (a test daemon's CODE_FOUNDRY_HOME), which this floor was
		// never told about: found by its markers.
		"other-token.txt": filepath.Join(home, "cf-1", "daemon.token"),
		"other":           filepath.Join(home, "cf-1"),
	} {
		if err := os.Symlink(target, filepath.Join(proj, "docs", link)); err != nil {
			t.Fatal(err)
		}
	}
	g := NewGrants(NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))))
	grant, _ := g.Grant(proj)
	one, err := g.GrantFile(filepath.Join(home, "report.html"))
	if err != nil {
		t.Fatal(err)
	}
	// A home that appears inside the tree after the grant was minted (a test daemon
	// started in the checkout) is guarded from then on.
	write(t, filepath.Join(proj, "scratch-home", "pages.port"), "9300")
	write(t, filepath.Join(proj, "scratch-home", "db.sqlite"), "db")
	srv := httptest.NewServer(Handler(g, nil, slog.Default()))
	t.Cleanup(srv.Close)

	tests := []struct {
		name, path  string
		status      int
		contentType string
		body        string
	}{
		{"page", "/preview/" + grant + "/docs/index.html", 200, "text/html; charset=utf-8", "<h1>hi</h1>"},
		{"script", "/preview/" + grant + "/docs/app.js", 200, "text/javascript; charset=utf-8", "console.log(1)"},
		{"image", "/preview/" + grant + "/assets/logo.png", 200, "image/png", ""},
		{"directory serves index", "/preview/" + grant + "/docs/", 200, "text/html; charset=utf-8", "<h1>hi</h1>"},
		{"directory without slash", "/preview/" + grant + "/docs", 200, "text/html; charset=utf-8", "<h1>hi</h1>"},
		{"missing", "/preview/" + grant + "/docs/nope.html", 404, "", ""},
		{"above the scope", "/preview/" + grant + "/../secret.txt", 404, "", ""},
		{"encoded dot-dot", "/preview/" + grant + "/docs/%2e%2e/%2e%2e/secret.txt", 404, "", ""},
		{"symlink out of home", "/preview/" + grant + "/docs/link.html", 404, "", ""},
		{"symlink above the scope within home", "/preview/" + grant + "/docs/up.txt", 200, "text/plain; charset=utf-8", "no"},
		{"symlink to the daemon token", "/preview/" + grant + "/docs/token.txt", 404, "", ""},
		{"symlink into ~/.ssh", "/preview/" + grant + "/docs/ssh/id_rsa", 404, "", ""},
		{"symlink to another home's token", "/preview/" + grant + "/docs/other-token.txt", 404, "", ""},
		{"another home through a linked folder", "/preview/" + grant + "/docs/other/db.sqlite", 404, "", ""},
		{"another home's checkout through a linked folder", "/preview/" + grant + "/docs/other/worktrees/app/index.html", 200, "text/html; charset=utf-8", "<p>wt</p>"},
		{"a home made after the grant", "/preview/" + grant + "/scratch-home/db.sqlite", 404, "", ""},
		{"its marker", "/preview/" + grant + "/scratch-home/pages.port", 404, "", ""},
		{"one-file grant serves its file", "/preview/" + one + "/report.html", 200, "text/html; charset=utf-8", "<p>report</p>"},
		{"one-file grant, a sibling", "/preview/" + one + "/notes.txt", 404, "", ""},
		{"one-file grant, the daemon token", "/preview/" + one + "/.code-foundry/daemon.token", 404, "", ""},
		{"one-file grant, dot-dot back to its file", "/preview/" + one + "/x/../report.html", 200, "text/html; charset=utf-8", "<p>report</p>"},
		{"unknown grant", "/preview/deadbeef/docs/index.html", 404, "", ""},
		{"no file", "/preview/" + grant, 404, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, srv.URL+tc.path, nil)
			res, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			if res.StatusCode != tc.status {
				t.Fatalf("status %d, want %d", res.StatusCode, tc.status)
			}
			// The opaque-origin page fetches its own files and sees their errors.
			if got := res.Header.Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
			}
			if tc.status != 200 {
				return
			}
			if ct := res.Header.Get("Content-Type"); ct != tc.contentType {
				t.Errorf("Content-Type %q, want %q", ct, tc.contentType)
			}
			for k, want := range map[string]string{
				"Cache-Control":          "no-store",
				"Referrer-Policy":        "no-referrer",
				"X-Content-Type-Options": "nosniff",
			} {
				if got := res.Header.Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			if csp := res.Header.Get("Content-Security-Policy"); csp != CSP || strings.Contains(csp, "allow-top-navigation") {
				t.Errorf("CSP %q", csp)
			}
			if tc.body != "" {
				b := make([]byte, 64)
				n, _ := res.Body.Read(b)
				if string(b[:n]) != tc.body {
					t.Errorf("body %q, want %q", b[:n], tc.body)
				}
			}
		})
	}

	t.Run("post", func(t *testing.T) {
		res, err := srv.Client().Post(srv.URL+"/preview/"+grant+"/docs/index.html", "text/plain", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("status %d", res.StatusCode)
		}
	})
}

// A file directly in a temp folder gets a grant of its own, one in a folder below it that
// tree; symlinks are held to the same roots as a home grant's.
func TestHandlerTemp(t *testing.T) {
	f, at := tempFloor(t)
	for p, s := range map[string]string{
		"private/tmp/direct.html":             "<p>direct</p>",
		"private/tmp/sibling.txt":             "sibling",
		"private/tmp/foo/index.html":          "<h1>foo</h1>",
		"private/tmp/foo/sub/deep.txt":        "deep",
		"private/tmp/foo/sub/cf/daemon.token": "t",
		"private/tmp/foo/sub/cf/beside.txt":   "t",
		"private/tmp/foo/page/index.html":     "<h1>page</h1>",
		"private/tmp/foo/pipedir/x.txt":       "x",
		"private/tmp/cf-drive/daemon.token":   "t",
		"private/tmp/locked/secret.txt":       "the user's",
		"private/var/T/secret.txt":            "the user's",
		"elsewhere/secret.txt":                "no",
		"home/notes.txt":                      "home",
		"home/.ssh/id_rsa":                    "key",
	} {
		write(t, at(p), s)
	}
	for link, target := range map[string]string{
		"private/tmp/foo/out.txt":   "elsewhere/secret.txt",
		"private/tmp/foo/outdir":    "elsewhere",
		"private/tmp/foo/up.txt":    "private/tmp/sibling.txt",
		"private/tmp/foo/locked":    "private/tmp/locked",
		"private/tmp/foo/other.txt": "private/var/T/secret.txt",
		"private/tmp/foo/abs.txt":   "private/tmp/foo/sub/deep.txt",
		"private/tmp/one-link.html": "private/tmp/sibling.txt",
		"private/tmp/foo/home.txt":  "home/notes.txt",
		"private/tmp/foo/ssh":       "home/.ssh",
		"private/tmp/foo/token.txt": "private/tmp/cf-drive/daemon.token",
		"private/tmp/outfile.html":  "elsewhere/secret.txt",
		"private/tmp/homefile.html": "home/notes.txt",
	} {
		if err := os.Symlink(at(target), at(link)); err != nil {
			t.Fatal(err)
		}
	}
	// A link inside the tree, as a build leaves one, and a FIFO, which nothing may wait on.
	if err := os.Symlink("sub/deep.txt", at("private/tmp/foo/in.txt")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(at("private/tmp/foo/pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := NewGrants(f.WithTemp(append(f.temps, at("private/var/T"))))
	for _, dir := range []string{"tmp", "private/tmp", "private", "elsewhere"} {
		if _, err := g.Grant(at(dir)); !errors.Is(err, ErrGuarded) {
			t.Errorf("Grant(%s) = %v, want ErrGuarded", dir, err)
		}
	}
	for _, file := range []string{"elsewhere/secret.txt", "tmp/cf-drive/daemon.token"} {
		if _, err := g.GrantFile(at(file)); !errors.Is(err, ErrGuarded) {
			t.Errorf("GrantFile(%s) = %v, want ErrGuarded", file, err)
		}
	}
	tree, err := g.Grant(at("tmp/foo"))
	if err != nil {
		t.Fatal(err)
	}
	one, err := g.GrantFile(at("tmp/direct.html"))
	if err != nil {
		t.Fatal(err)
	}
	link, err := g.GrantFile(at("tmp/outfile.html"))
	if err != nil {
		t.Fatal(err)
	}
	homeLink, err := g.GrantFile(at("tmp/homefile.html"))
	if err != nil {
		t.Fatal(err)
	}
	inTemp, err := g.GrantFile(at("tmp/one-link.html"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Handler(g, nil, slog.Default()))
	t.Cleanup(srv.Close)
	tests := []struct {
		name, path string
		status     int
		body       string
	}{
		{"a page in the tree", tree + "/index.html", 200, "<h1>foo</h1>"},
		{"the folder's index", tree + "/", 200, "<h1>foo</h1>"},
		{"a subfolder", tree + "/sub/deep.txt", 200, "deep"},
		{"above the tree", tree + "/../sibling.txt", 404, ""},
		{"a link out", tree + "/out.txt", 404, ""},
		{"a linked folder out", tree + "/outdir/secret.txt", 404, ""},
		{"a subfolder's index", tree + "/page/", 200, "<h1>page</h1>"},
		{"a link inside the tree", tree + "/in.txt", 200, "deep"},
		{"an absolute link inside the tree: a Root takes none", tree + "/abs.txt", 404, ""},
		{"a link within the temp folder", tree + "/up.txt", 404, ""},
		{"a link to another's folder in temp", tree + "/locked/secret.txt", 404, ""},
		{"a link into the other temp folder", tree + "/other.txt", 404, ""},
		{"a FIFO", tree + "/pipe", 404, ""},
		{"a config home below the tree", tree + "/sub/cf/daemon.token", 404, ""},
		{"a file beside its token", tree + "/sub/cf/beside.txt", 404, ""},
		{"a link into home", tree + "/home.txt", 404, ""},
		{"a link into ~/.ssh", tree + "/ssh/id_rsa", 404, ""},
		{"a link to a daemon's token", tree + "/token.txt", 404, ""},
		{"one file", one + "/direct.html", 200, "<p>direct</p>"},
		{"one file, its sibling", one + "/sibling.txt", 404, ""},
		{"one file, a link out", link + "/outfile.html", 404, ""},
		{"one file, a link into home", homeLink + "/homefile.html", 404, ""},
		{"one file, a link within the temp folder", inTemp + "/one-link.html", 404, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := srv.Client().Get(srv.URL + Prefix + tt.path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			b, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != tt.status {
				t.Fatalf("status %d, want %d", res.StatusCode, tt.status)
			}
			if tt.status == 200 && string(b) != tt.body {
				t.Errorf("body %q, want %q", b, tt.body)
			}
		})
	}
}

// fetch is the route's status and body for one request.
func fetch(h http.Handler, url string) (int, string) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec.Code, rec.Body.String()
}

// A grant is a name in a temp folder, not what is at that name when it was minted. Whoever owns
// the folder can put something else there, which serves only what that holds, and a link
// there is no way anywhere else. An agent remaking its output folder keeps its tab.
func TestHandlerTempSwapped(t *testing.T) {
	const page = "the page"
	tests := []struct {
		name   string
		one    bool // a one-file grant of tmp/one.txt, not a tree grant of tmp/foo
		swap   func(t *testing.T, at func(string) string)
		status int
		body   string
	}{
		{name: "the tree as it was", status: 200, body: page},
		{name: "the tree remade", status: 200, body: "remade", swap: func(t *testing.T, at func(string) string) {
			if err := os.RemoveAll(at("private/tmp/foo")); err != nil {
				t.Fatal(err)
			}
			write(t, at("private/tmp/foo/x.txt"), "remade")
		}},
		{name: "the tree gone", status: 404, swap: func(t *testing.T, at func(string) string) {
			if err := os.RemoveAll(at("private/tmp/foo")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "the tree a link to another's folder in temp", status: 404, swap: func(t *testing.T, at func(string) string) {
			replace(t, at("private/tmp/foo"), at("private/tmp/locked"))
		}},
		{name: "the tree a link into home", status: 404, swap: func(t *testing.T, at func(string) string) {
			replace(t, at("private/tmp/foo"), at("home/proj"))
		}},
		{name: "one file as it was", one: true, status: 200, body: page},
		{name: "one file rewritten", one: true, status: 200, body: "rewritten", swap: func(t *testing.T, at func(string) string) {
			write(t, at("private/tmp/one.txt"), "rewritten")
		}},
		{name: "one file a link in temp", one: true, status: 404, swap: func(t *testing.T, at func(string) string) {
			replace(t, at("private/tmp/one.txt"), at("private/tmp/locked/x.txt"))
		}},
		{name: "one file a folder with the name of a page in it", one: true, status: 404, swap: func(t *testing.T, at func(string) string) {
			if err := os.Remove(at("private/tmp/one.txt")); err != nil {
				t.Fatal(err)
			}
			write(t, at("private/tmp/one.txt/index.html"), "a folder's")
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, at := tempFloor(t)
			write(t, at("private/tmp/foo/x.txt"), page)
			write(t, at("private/tmp/one.txt"), page)
			write(t, at("private/tmp/locked/x.txt"), "the user's")
			write(t, at("home/proj/x.txt"), "the user's")
			g := NewGrants(f)
			grant, err := g.Grant(at("tmp/foo"))
			url := "/x.txt"
			if tt.one {
				grant, err = g.GrantFile(at("tmp/one.txt"))
				url = "/one.txt"
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.swap != nil {
				tt.swap(t, at)
			}
			status, body := fetch(Handler(g, nil, slog.Default()), Prefix+grant+url)
			if status != tt.status || (status == 200 && body != tt.body) {
				t.Errorf("got %d %q, want %d %q", status, body, tt.status, tt.body)
			}
		})
	}
}

// replace puts a link to target at p, whatever was there.
func replace(t *testing.T, p, target string) {
	t.Helper()
	if err := os.RemoveAll(p); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, p); err != nil {
		t.Fatal(err)
	}
}

// A page in home must be home's: only a grant in a temp folder serves what is in one, or a
// link anything can repoint would run temp's bytes at a URL that has the thread's bridge.
func TestHandlerHomeLinksIntoTemp(t *testing.T) {
	f, at := tempFloor(t)
	for p, s := range map[string]string{
		"home/proj/index.html":     "<h1>proj</h1>",
		"home/real.html":           "<h1>real</h1>",
		"private/tmp/foo/app.js":   "evil()",
		"private/tmp/planted.html": "<h1>planted</h1>",
	} {
		write(t, at(p), s)
	}
	for link, target := range map[string]string{
		"home/proj/build":      "private/tmp/foo",
		"home/proj/app.js":     "private/tmp/foo/app.js",
		"home/proj/both":       "tmp/foo",
		"home/proj/hop.html":   "private/tmp/hop.html",
		"private/tmp/hop.html": "home/real.html",
	} {
		if err := os.Symlink(at(target), at(link)); err != nil {
			t.Fatal(err)
		}
	}
	g := NewGrants(f)
	tree, err := g.Grant(at("home/proj"))
	if err != nil {
		t.Fatal(err)
	}
	h := Handler(g, nil, slog.Default())
	tests := []struct {
		name, path string
		status     int
		body       string
	}{
		{"its own page", "index.html", 200, "<h1>proj</h1>"},
		{"a folder linked into temp", "build/app.js", 404, ""},
		{"a folder linked through /tmp's spelling", "both/app.js", 404, ""},
		{"a file linked into temp", "app.js", 404, ""},
		{"a link back home by way of temp", "hop.html", 200, "<h1>real</h1>"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, body := fetch(h, Prefix+tree+"/"+tt.path)
			if status != tt.status || (status == 200 && body != tt.body) {
				t.Errorf("got %d %q, want %d %q", status, body, tt.status, tt.body)
			}
		})
	}
	// The temp link can be repointed at any time: the page goes, and temp's bytes do not come.
	replace(t, at("private/tmp/hop.html"), at("private/tmp/planted.html"))
	if status, body := fetch(h, Prefix+tree+"/hop.html"); status != 404 {
		t.Errorf("repointed: got %d %q, want 404", status, body)
	}
}
