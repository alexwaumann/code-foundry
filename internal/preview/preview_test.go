package preview

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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
	write(t, filepath.Join(home, "report.html"), "<p>report</p>")
	write(t, filepath.Join(home, "notes.txt"), "sibling")
	for link, target := range map[string]string{
		"token.txt": filepath.Join(home, ".code-foundry", "daemon.token"),
		"ssh":       filepath.Join(home, ".ssh"),
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
	srv := httptest.NewServer(Handler(g, slog.Default()))
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
				// The opaque-origin page fetches its own files.
				"Access-Control-Allow-Origin": "*",
			} {
				if got := res.Header.Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
			if csp := res.Header.Get("Content-Security-Policy"); csp == "" || csp[:7] != "sandbox" || strings.Contains(csp, "allow-same-origin") {
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
