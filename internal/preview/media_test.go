package preview

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// mediaFixture is a home with a clip, the ways out of it, and a server for its grants.
type mediaFixture struct {
	home, outside, temp string
	g                   *Grants
	srv                 *httptest.Server
}

// clip is the test video's bytes: 100, so ranges are easy to read.
var clip = func() string {
	b := make([]byte, 100)
	for i := range b {
		b[i] = byte('0' + i%10)
	}
	return string(b)
}()

func newMediaFixture(t *testing.T) *mediaFixture {
	t.Helper()
	var dirs [3]string
	for i := range dirs {
		d, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		dirs[i] = d
	}
	f := &mediaFixture{home: dirs[0], outside: dirs[1], temp: dirs[2]}
	write(t, filepath.Join(f.home, "proj", "clip.mp4"), clip)
	write(t, filepath.Join(f.home, "proj", "a b#1.m4a"), "audio")
	write(t, filepath.Join(f.home, "proj", "notes.txt"), "text")
	write(t, filepath.Join(f.home, ".code-foundry", "daemon.token"), "token")
	write(t, filepath.Join(f.outside, "secret.mp4"), "secret")
	write(t, filepath.Join(f.temp, "rec.webm"), "webm")
	f.g = NewGrants(NewFloor(f.home, paths.New(filepath.Join(f.home, ".code-foundry"))).WithTemp([]string{f.temp}))
	f.srv = httptest.NewServer(MediaHandler(f.g, slog.Default()))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *mediaFixture) grant(t *testing.T, p string) string {
	t.Helper()
	id, err := f.g.GrantMedia(p)
	if err != nil {
		t.Fatal(err)
	}
	return MediaURL(id, p)
}

func (f *mediaFixture) get(t *testing.T, method, url string, header map[string]string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(method, f.srv.URL+url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	r, err := f.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Body.Close() }()
	b, _ := io.ReadAll(r.Body)
	return r, string(b)
}

func TestGrantMedia(t *testing.T) {
	g := NewGrants(NewFloor("/home", paths.New("/home/.code-foundry")))
	a, err := g.GrantMedia("/home/a/clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := g.GrantMedia("/home/a/clip.mp4")
	tree, _ := g.Grant("/home/a")
	if a != again || a == tree || len(a) != 32 {
		t.Errorf("media %q again %q tree %q", a, again, tree)
	}
	for _, p := range []string{"/home/a/notes.txt", "/home/a/page.html", "clip.mp4", "/home/a/../b/clip.mp4", "/home/a/clip"} {
		if _, err := g.GrantMedia(p); !errors.Is(err, ErrNotMedia) {
			t.Errorf("GrantMedia(%s) err = %v, want ErrNotMedia", p, err)
		}
	}
	if got := MediaURL("g1", "/x/a b#1.mp4"); got != "/media/g1/a%20b%231.mp4" {
		t.Errorf("MediaURL = %q", got)
	}
}

func TestMediaHandlerRanges(t *testing.T) {
	f := newMediaFixture(t)
	url := f.grant(t, filepath.Join(f.home, "proj", "clip.mp4"))
	tests := []struct {
		name, method, rng string
		status            int
		body, cr          string
	}{
		{name: "whole", method: "GET", status: 200, body: clip},
		{name: "first bytes", method: "GET", rng: "bytes=0-9", status: 206, body: clip[:10], cr: "bytes 0-9/100"},
		{name: "middle", method: "GET", rng: "bytes=40-49", status: 206, body: clip[40:50], cr: "bytes 40-49/100"},
		{name: "open end", method: "GET", rng: "bytes=90-", status: 206, body: clip[90:], cr: "bytes 90-99/100"},
		{name: "suffix", method: "GET", rng: "bytes=-5", status: 206, body: clip[95:], cr: "bytes 95-99/100"},
		{name: "end past the size is clamped", method: "GET", rng: "bytes=98-500", status: 206, body: clip[98:], cr: "bytes 98-99/100"},
		{name: "unsatisfiable", method: "GET", rng: "bytes=100-", status: 416, cr: "bytes */100"},
		{name: "head", method: "HEAD", status: 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := map[string]string{}
			if tt.rng != "" {
				h["Range"] = tt.rng
			}
			r, body := f.get(t, tt.method, url, h)
			if r.StatusCode != tt.status {
				t.Fatalf("status %d, want %d (%q)", r.StatusCode, tt.status, body)
			}
			if tt.status != 416 && body != tt.body {
				t.Errorf("body %q, want %q", body, tt.body)
			}
			if got := r.Header.Get("Content-Range"); got != tt.cr {
				t.Errorf("Content-Range %q, want %q", got, tt.cr)
			}
			if tt.status == 416 {
				return
			}
			want := map[string]string{
				"Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "sandbox",
				"Access-Control-Allow-Origin": "",
			}
			if tt.method == "HEAD" {
				want["Content-Length"] = strconv.Itoa(len(clip))
			}
			for k, v := range want {
				if got := r.Header.Get(k); got != v {
					t.Errorf("%s: %q, want %q", k, got, v)
				}
			}
		})
	}
}

func TestMediaHandlerRefusals(t *testing.T) {
	f := newMediaFixture(t)
	proj := filepath.Join(f.home, "proj")
	clipURL := f.grant(t, filepath.Join(proj, "clip.mp4"))
	clipGrant := clipURL[len(MediaPrefix) : len(clipURL)-len("/clip.mp4")]
	treeGrant, err := f.g.Grant(proj)
	if err != nil {
		t.Fatal(err)
	}
	// A grant from before a restart: another table minted it, this one never heard of it.
	stale, _ := NewGrants(f.g.floor).GrantMedia(filepath.Join(proj, "clip.mp4"))

	// Files that change after their grant was minted: the route asks again each time.
	gone := f.grant(t, filepath.Join(proj, "gone.mp4"))
	linkedOut := f.grant(t, filepath.Join(proj, "out.mp4"))
	linkedText := f.grant(t, filepath.Join(proj, "text.mp4"))
	linkedToken := f.grant(t, filepath.Join(proj, "token.mp4"))
	becameDir := f.grant(t, filepath.Join(proj, "dir.mp4"))
	outside := f.grant(t, filepath.Join(f.outside, "secret.mp4"))
	for link, target := range map[string]string{
		"out.mp4":   filepath.Join(f.outside, "secret.mp4"),
		"text.mp4":  filepath.Join(proj, "notes.txt"),
		"token.mp4": filepath.Join(f.home, ".code-foundry", "daemon.token"),
	} {
		if err := os.Symlink(target, filepath.Join(proj, link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(proj, "dir.mp4"), 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name, method, path string
		status             int
	}{
		{"no grant", "GET", MediaPrefix, 404},
		{"no name", "GET", MediaPrefix + clipGrant, 404},
		{"unknown grant", "GET", MediaPrefix + "0123456789abcdef0123456789abcdef/clip.mp4", 404},
		{"expired grant", "GET", MediaURL(stale, "/x/clip.mp4"), 404},
		{"a preview grant", "GET", MediaPrefix + treeGrant + "/clip.mp4", 404},
		{"wrong name", "GET", MediaPrefix + clipGrant + "/song.mp4", 404},
		{"traversal in the name", "GET", MediaPrefix + clipGrant + "/../notes.txt", 404},
		{"encoded traversal", "GET", MediaPrefix + clipGrant + "/%2e%2e%2fnotes.txt", 404},
		{"a path below the name", "GET", MediaPrefix + clipGrant + "/clip.mp4/x", 404},
		{"gone", "GET", gone, 404},
		{"a link leading out of home", "GET", linkedOut, 404},
		{"a link to a file that is no media", "GET", linkedText, 404},
		{"a link to the daemon token", "GET", linkedToken, 404},
		{"a directory", "GET", becameDir, 404},
		{"outside the roots", "GET", outside, 404},
		{"post", "POST", clipURL, 405},
		{"the grant itself still serves", "GET", clipURL, 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, body := f.get(t, tt.method, tt.path, nil)
			if r.StatusCode != tt.status {
				t.Errorf("%s %s: %d %q, want %d", tt.method, tt.path, r.StatusCode, body, tt.status)
			}
		})
	}
	// A media grant serves nothing on the preview route.
	pages := httptest.NewServer(Handler(f.g, nil, slog.Default()))
	t.Cleanup(pages.Close)
	for _, rel := range []string{"clip.mp4", "notes.txt", ""} {
		r, err := pages.Client().Get(pages.URL + Prefix + clipGrant + "/" + rel)
		if err != nil {
			t.Fatal(err)
		}
		_ = r.Body.Close()
		if r.StatusCode != http.StatusNotFound {
			t.Errorf("preview route with a media grant, %q: %d", rel, r.StatusCode)
		}
	}
}

// A temp folder's media streams; a name needing escapes round-trips through MediaURL.
func TestMediaHandlerTempAndEscapes(t *testing.T) {
	f := newMediaFixture(t)
	for p, want := range map[string]string{
		filepath.Join(f.temp, "rec.webm"):          "webm",
		filepath.Join(f.home, "proj", "a b#1.m4a"): "audio",
	} {
		r, body := f.get(t, "GET", f.grant(t, p), nil)
		if r.StatusCode != 200 || body != want {
			t.Errorf("%s: %d %q", p, r.StatusCode, body)
		}
	}
}
