package preview

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// folds reports whether the filesystem holding dir opens alt as the existing entry name
// (APFS does, with full Unicode folding).
func folds(dir, name, alt string) bool {
	a, err := os.Stat(filepath.Join(dir, name))
	if err != nil {
		return false
	}
	b, err := os.Stat(filepath.Join(dir, alt))
	return err == nil && os.SameFile(a, b)
}

// TestFloorFoldedNames covers names that APFS folds and string comparison does not: a
// link to ~/.ßh is a link to ~/.ssh. Skipped where the filesystem does not fold.
func TestFloorFoldedNames(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := func(rel string) string { return filepath.Join(home, rel) }
	for _, rel := range []string{
		".ssh/known_hosts", ".config/gh/hosts.yml", ".claude.json",
		"cf-test/daemon.token", "cf-test/db.sqlite", "cf-test/worktrees/app/index.html", "cf-test/pages/s-1/p.html",
		"Kit/daemon.token",
		"proj/index.html",
	} {
		write(t, h(rel), "x")
	}
	if !folds(home, ".ssh", ".ßh") {
		t.Skip("this filesystem does not fold names (not APFS)")
	}
	// Folded spellings of guarded names, each linked from the project, absolute and relative.
	links := map[string]string{
		"proj/eszett":     h(".ßh"),
		"proj/longs":      h(".ſsh"),
		"proj/ligature":   h(".conﬁg"),
		"proj/json":       h(".claude.jſon"),
		"proj/relative":   "../.ßh",
		"proj/d/home":     h("cf-teſt"),
		"proj/token":      h("cf-teſt/daemon.token"),
		"proj/d/kelvin":   h("Kit"), // KELVIN SIGN K
		"proj/worktree":   h("cf-teſt/worktrees/app"),
		"proj/plain-link": h("proj/index.html"),
	}
	if err := os.MkdirAll(h("proj/d"), 0o755); err != nil {
		t.Fatal(err)
	}
	for link, target := range links {
		if err := os.Symlink(target, h(link)); err != nil {
			t.Fatal(err)
		}
	}
	f := NewFloor(home, paths.New(h("cf-test")))

	tests := []struct {
		name    string
		p       string
		guarded bool
	}{
		{"ssh by ß", h("proj/eszett/known_hosts"), true},
		{"ssh by ß, the folder", h("proj/eszett"), true},
		{"ssh by ſ", h("proj/longs/known_hosts"), true},
		{"config by ﬁ", h("proj/ligature/gh/hosts.yml"), true},
		{"claude.json by ſ", h("proj/json"), true},
		{"ssh by a relative ß", h("proj/relative/known_hosts"), true},
		{"config home by ſ", h("proj/d/home/daemon.token"), true},
		{"config home db by ſ", h("proj/d/home/db.sqlite"), true},
		{"token by ſ", h("proj/token"), true},
		{"another home by the Kelvin sign", h("proj/d/kelvin/daemon.token"), true},
		{"config home worktree by ſ", h("proj/worktree/index.html"), false},
		{"config home pages by ſ", h("proj/d/home/pages/s-1/p.html"), false},
		{"folded spelling typed directly", h(".ßh/known_hosts"), true},
		{"the page", h("proj/index.html"), false},
		{"a link to the page", h("proj/plain-link"), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.Guarded(tc.p); got != tc.guarded {
				t.Errorf("Guarded(%s) = %v, want %v", tc.p, got, tc.guarded)
			}
		})
	}
	// A scope spelled with a folded name is the guarded tree it names.
	for _, dir := range []string{h(".ßh"), h("cf-teſt"), h("proj/eszett"), h("proj/d")} {
		if f.ScopeOK(dir) {
			t.Errorf("ScopeOK(%s) = true, want false", dir)
		}
	}
	// The route: every folded link is 404, the page 200.
	g := NewGrants(f)
	grant, err := g.Grant(h("proj"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Handler(g, nil, slog.New(slog.DiscardHandler)))
	defer srv.Close()
	for rel, want := range map[string]int{
		"index.html":            http.StatusOK,
		"plain-link":            http.StatusOK,
		"eszett/known_hosts":    http.StatusNotFound,
		"longs/known_hosts":     http.StatusNotFound,
		"ligature/gh/hosts.yml": http.StatusNotFound,
		"json":                  http.StatusNotFound,
		"relative/known_hosts":  http.StatusNotFound,
		"d/home/daemon.token":   http.StatusNotFound,
		"token":                 http.StatusNotFound,
		"d/kelvin/daemon.token": http.StatusNotFound,
		"worktree/index.html":   http.StatusOK,
	} {
		if got := get(t, srv.URL+URL(grant, rel)); got != want {
			t.Errorf("GET %s = %d, want %d", rel, got, want)
		}
	}
}

// TestFloorHardLinks: a hard link is the guarded file under another name, so it is
// guarded wherever it sits; an ordinary file with several links (a pnpm store) is not.
func TestFloorHardLinks(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := func(rel string) string { return filepath.Join(home, rel) }
	for _, rel := range []string{
		".code-foundry/daemon.token", ".code-foundry/db.sqlite", ".netrc", ".ssh/id_ed25519", ".config/gh/hosts.yml",
		".code-foundry/pages/s-1/p.html", "store/lib.js", "proj/index.html",
	} {
		write(t, h(rel), "x")
	}
	for link, target := range map[string]string{
		"proj/t":      ".code-foundry/daemon.token",
		"proj/db":     ".code-foundry/db.sqlite",
		"proj/n":      ".netrc",
		"proj/key":    ".ssh/id_ed25519",
		"proj/gh.yml": ".config/gh/hosts.yml",
		"proj/lib.js": "store/lib.js",
		"proj/p.html": ".code-foundry/pages/s-1/p.html",
	} {
		if err := os.Link(h(target), h(link)); err != nil {
			t.Fatal(err)
		}
	}
	f := NewFloor(home, paths.New(h(".code-foundry")))
	tests := []struct {
		name    string
		rel     string
		guarded bool
	}{
		{"the daemon token", "proj/t", true},
		{"the database", "proj/db", true},
		{"a guarded file", "proj/n", true},
		{"an ssh key", "proj/key", true},
		{"the gh token, two down", "proj/gh.yml", true},
		{"a store's file", "proj/lib.js", false},
		{"a page in the open pages folder", "proj/p.html", false},
		{"the page", "proj/index.html", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := f.Guarded(h(tc.rel)); got != tc.guarded {
				t.Errorf("Guarded(%s) = %v, want %v", tc.rel, got, tc.guarded)
			}
		})
	}
	g := NewGrants(f)
	grant, err := g.Grant(h("proj"))
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(Handler(g, nil, slog.New(slog.DiscardHandler)))
	defer srv.Close()
	for rel, want := range map[string]int{"t": 404, "key": 404, "lib.js": 200, "index.html": 200} {
		if got := get(t, srv.URL+URL(grant, rel)); got != want {
			t.Errorf("GET %s = %d, want %d", rel, got, want)
		}
	}
}

func get(t *testing.T, url string) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, res.Body)
	_ = res.Body.Close()
	return res.StatusCode
}
