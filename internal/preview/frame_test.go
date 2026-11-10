package preview

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// The frame's script goes into a document a frame navigates to, after the paint tag, and
// into nothing else: a page reading its own HTML with fetch() gets the file as written.
func TestHandlerFrameScript(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(home, "proj")
	const page = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>"
	write(t, filepath.Join(proj, "page.html"), page)
	write(t, filepath.Join(proj, "app.js"), "let a = 1")
	g := NewGrants(NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))))
	grant, err := g.Grant(proj)
	if err != nil {
		t.Fatal(err)
	}
	paint := func() (string, string) { return "dark", "#0d1117" }
	srv := httptest.NewServer(Handler(g, paint, slog.New(slog.DiscardHandler)))
	t.Cleanup(srv.Close)
	script, painted := string(frameTag), string(paintTag("dark", "#0d1117"))
	if strings.Contains(strings.ToLower(string(frameJS)), "</script") {
		t.Fatal("frame.js would end its own inline script tag")
	}

	tests := []struct {
		name, path, dest, want string
	}{
		{"a frame's document", "page.html", "iframe", strings.Replace(page, "<head>", "<head>"+script, 1)},
		{"a window's document", "page.html", "document", strings.Replace(page, "<head>", "<head>"+script, 1)},
		{"a thread's page: painted, then the script", "page.html?cf-page=1", "iframe", strings.Replace(page, "<head>", "<head>"+painted+script, 1)},
		{"a thread's page from a client without the header", "page.html?cf-page=1", "", strings.Replace(page, "<head>", "<head>"+painted+script, 1)},
		{"read with fetch()", "page.html", "empty", page},
		{"no header, not a thread's page", "page.html", "", page},
		{"a script a frame navigated to", "app.js", "iframe", "let a = 1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, srv.URL+"/preview/"+grant+"/"+tc.path, nil)
			if tc.dest != "" {
				req.Header.Set("Sec-Fetch-Dest", tc.dest)
			}
			res, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			body, _ := io.ReadAll(res.Body)
			if res.StatusCode != http.StatusOK || string(body) != tc.want {
				t.Errorf("status %d body %q, want %q", res.StatusCode, body, tc.want)
			}
		})
	}
}
