package preview

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	g := NewGrants()
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
	g := NewGrants()
	grant, _ := g.Grant(proj)
	srv := httptest.NewServer(Handler(home, g, slog.Default()))
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
