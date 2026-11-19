package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/fsx/fsxtest"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// testGrants is a grant table for home root with the config home at root/.code-foundry.
func testGrants(root string) *preview.Grants {
	return preview.NewGrants(preview.NewFloor(root, paths.New(filepath.Join(root, ".code-foundry"))))
}

func TestFilesystemPreviewFile(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(root, "proj")
	wt := filepath.Join(root, "proj-wt")
	cfgWt := filepath.Join(root, ".code-foundry", "worktrees", "proj", "wt")
	for _, f := range []string{
		"proj/docs/index.html", "proj-wt/site/page.html", "loose/mock.html", "report.html",
		".code-foundry/daemon.token", ".code-foundry/worktrees/proj/wt/index.html", ".ssh/page.html",
		// Other daemons' homes (test daemons beside this one), found by their markers.
		"cf-1/daemon.token", "cf-1/page.html", "dev/cf-4/pages.port", "dev/page.html",
	} {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<p>x</p>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		"linked.html":            filepath.Join(proj, "docs/index.html"),
		"proj/docs/token.html":   filepath.Join(root, ".code-foundry/daemon.token"),
		"loose/home-report.html": filepath.Join(root, "report.html"),
	} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	fake := projecttest.New(nil)
	fake.Put(project.Project{ID: "p", Path: proj, Worktrees: []project.Worktree{
		{ProjectID: "p", Path: proj, IsMain: true},
		{ProjectID: "p", Path: wt},
		{ProjectID: "p", Path: cfgWt},
	}})
	// A project registered at home itself must not widen any grant to home.
	fake.Put(project.Project{ID: "h", Path: root, Worktrees: []project.Worktree{{ProjectID: "h", Path: root, IsMain: true}}})
	grants := testGrants(root)
	route := NewFilesystem(root, fake, grants).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	mux.Handle(preview.Prefix, preview.Handler(grants, nil, slog.Default()))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	tests := []struct {
		name, baseDir, path string
		scope, rel          string
		single              bool
		code                connect.Code
	}{
		{name: "in the main checkout", path: filepath.Join(proj, "docs/index.html"), scope: proj, rel: "docs/index.html"},
		{name: "in a worktree, relative", baseDir: wt, path: "site/page.html", scope: wt, rel: "site/page.html"},
		{name: "in a worktree under the config home", path: filepath.Join(cfgWt, "index.html"), scope: cfgWt, rel: "index.html"},
		{name: "outside every checkout, in a subfolder", path: "~/loose/mock.html", scope: filepath.Join(root, "loose"), rel: "mock.html"},
		{name: "at the home root: the file alone", path: "~/report.html", scope: filepath.Join(root, "report.html"), rel: "report.html", single: true},
		{name: "symlink at the home root into a project", path: "~/linked.html", scope: filepath.Join(root, "linked.html"), rel: "linked.html", single: true},
		{name: "symlink in a subfolder to a home-root file", path: "~/loose/home-report.html", scope: filepath.Join(root, "loose"), rel: "home-report.html"},
		{name: "the daemon token", path: "~/.code-foundry/daemon.token", code: connect.CodeInvalidArgument},
		{name: "symlink in a project to the daemon token", path: filepath.Join(proj, "docs/token.html"), code: connect.CodeInvalidArgument},
		{name: "in ~/.ssh", path: "~/.ssh/page.html", code: connect.CodeInvalidArgument},
		{name: "in another daemon's home", path: "~/cf-1/page.html", code: connect.CodeInvalidArgument},
		{name: "beside another daemon's home: the file alone", path: "~/dev/page.html", scope: filepath.Join(root, "dev/page.html"), rel: "page.html", single: true},
		{name: "missing", path: filepath.Join(proj, "docs/nope.html"), code: connect.CodeNotFound},
		{name: "directory", path: filepath.Join(proj, "docs"), code: connect.CodeInvalidArgument},
		{name: "outside home", path: "/etc/hosts", code: connect.CodeInvalidArgument},
		{name: "relative without base", path: "docs/index.html", code: connect.CodeInvalidArgument},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := c.PreviewFile(ctx, connect.NewRequest(&v1.PreviewFileRequest{BaseDir: tc.baseDir, Path: tc.path}))
			if tc.code != 0 {
				if connect.CodeOf(err) != tc.code {
					t.Fatalf("err = %v, want code %v", err, tc.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetScope() != tc.scope || res.Msg.GetSingleFile() != tc.single {
				t.Errorf("scope %q single %v, want %q %v", res.Msg.GetScope(), res.Msg.GetSingleFile(), tc.scope, tc.single)
			}
			var grant string
			if tc.single {
				grant, _ = grants.GrantFile(tc.scope)
			} else {
				grant, _ = grants.Grant(tc.scope)
			}
			if want := preview.URL(grant, tc.rel); res.Msg.GetUrl() != want {
				t.Errorf("url %q, want %q", res.Msg.GetUrl(), want)
			}
			// The URL serves the file, with no bearer token.
			r, err := srv.Client().Get(srv.URL + res.Msg.GetUrl())
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = r.Body.Close() }()
			if r.StatusCode != http.StatusOK || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") {
				t.Errorf("GET %s: %d %s", res.Msg.GetUrl(), r.StatusCode, r.Header.Get("Content-Type"))
			}
		})
	}

	// The fuzz repro: a page previewed from the home root reads nothing else through its
	// grant, least of all the daemon token.
	t.Run("a home-root grant cannot read the token", func(t *testing.T) {
		res, err := c.PreviewFile(ctx, connect.NewRequest(&v1.PreviewFileRequest{Path: "~/report.html"}))
		if err != nil {
			t.Fatal(err)
		}
		base := strings.TrimSuffix(res.Msg.GetUrl(), "report.html")
		for _, rel := range []string{".code-foundry/daemon.token", "loose/mock.html", "proj/docs/index.html", "../report.html/../.code-foundry/daemon.token"} {
			r, err := srv.Client().Get(srv.URL + base + rel)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if r.StatusCode != http.StatusNotFound {
				t.Errorf("GET %s: %d %q, want 404", base+rel, r.StatusCode, body)
			}
		}
	})
}

// With a pages listener, PreviewFile's URL is absolute on it: on the grant's own origin,
// http://<grant>.localhost:<port>/<path>, for a client that asks for it (grant_host), and
// under the preview route on the loopback origin for one that does not (a GUI from before
// grant hosts, which an update can leave running beside this daemon). Both serve the file.
func TestFilesystemPreviewFilePagesOrigin(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(root, "site", "index.html")
	if err := os.MkdirAll(filepath.Dir(page), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(page, []byte("<p>x</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	grants := testGrants(root)
	pages := httptest.NewServer(preview.Handler(grants, nil, slog.Default()))
	t.Cleanup(pages.Close)
	port := pages.Listener.Addr().(*net.TCPAddr).Port
	route := NewFilesystem(root, projecttest.New(nil), grants).WithPagesPort(port).Route()
	api := httptest.NewServer(route.Handler)
	t.Cleanup(api.Close)
	c := codefoundryv1connect.NewFilesystemServiceClient(api.Client(), api.URL)
	tests := []struct {
		name      string
		grantHost bool
		// want is the URL for the grant the answer names.
		want func(grant string) string
	}{
		{"a client that loads grant hosts", true, func(g string) string { return preview.GrantOrigin(g, port) + "/index.html" }},
		{"a client from before grant hosts", false, func(g string) string {
			return "http://127.0.0.1:" + strconv.Itoa(port) + preview.URL(g, "index.html")
		}},
	}
	grant, _ := grants.Grant(filepath.Dir(page))
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res, err := c.PreviewFile(context.Background(), connect.NewRequest(&v1.PreviewFileRequest{Path: page, GrantHost: tc.grantHost}))
			if err != nil {
				t.Fatal(err)
			}
			url := res.Msg.GetUrl()
			if want := tc.want(grant); url != want {
				t.Fatalf("url %q, want %q (the scope is site)", url, want)
			}
			if _, err := neturl.Parse(url); err != nil {
				t.Fatal(err)
			}
			r, err := pages.Client().Get(url)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if r.StatusCode != http.StatusOK || !strings.Contains(string(body), "<p>x</p>") {
				t.Errorf("GET %s: %d %q", url, r.StatusCode, body)
			}
		})
	}
}

func TestPreviewReadError(t *testing.T) {
	root := t.TempDir()
	h := NewFilesystem(root, projecttest.New(nil), testGrants(root))
	refused := fmt.Errorf("wrapped: %w", fsx.ErrNotPermitted)
	tests := []struct {
		name, path string
		err        error
		want       connect.Code
		wantMsg    string
	}{
		{"refused in ~/Library: guarded, System Settings would not help", "~/Library/Safari/page.html", refused, connect.CodeInvalidArgument, "protected folder"},
		{"refused in Documents: the privacy message", "~/Documents/page.html", refused, connect.CodePermissionDenied, "not permitted"},
		{"any other failure in ~/Library", "~/Library/Safari/page.html", errors.New("boom"), connect.CodeInternal, "boom"},
		{"a path longer than the system takes", "~/x.html", fmt.Errorf("fsx: read x: %w", syscall.ENAMETOOLONG), connect.CodeInvalidArgument, "too long"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := h.previewReadError("", tt.path, tt.err)
			if got := connect.CodeOf(err); got != tt.want {
				t.Errorf("code = %v, want %v", got, tt.want)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("error %q does not hold %q", err, tt.wantMsg)
			}
		})
	}
}

// PreviewFile names the thread whose pages directory holds the file, so the GUI can give
// the page that thread's bridge without the thread's log.
func TestFilesystemPreviewFilePageThread(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pages := filepath.Join(root, "cf-pages")
	for _, f := range []string{"cf-pages/s-1/tracker.html", "cf-pages/s-1/sub/deep.html", "cf-pages/welcome.html", "loose/s-1/tracker.html"} {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<p>x</p>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A link from elsewhere to a thread's page is still that thread's page; a link in a
	// thread's pages directory to a file elsewhere is not.
	for link, target := range map[string]string{
		"loose/link.html":        filepath.Join(pages, "s-1/tracker.html"),
		"cf-pages/s-1/away.html": filepath.Join(root, "loose/s-1/tracker.html"),
	} {
		if err := os.Symlink(target, filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	for _, withRoot := range []bool{true, false} {
		h := NewFilesystem(root, projecttest.New(nil), testGrants(root))
		if withRoot {
			h.WithPagesRoot(pages)
		}
		srv := httptest.NewServer(h.Route().Handler)
		t.Cleanup(srv.Close)
		c := codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
		cases := []struct{ path, want string }{
			{"cf-pages/s-1/tracker.html", "s-1"},
			{"cf-pages/s-1/sub/deep.html", "s-1"},
			{"cf-pages/welcome.html", ""},
			{"loose/s-1/tracker.html", ""},
			{"loose/link.html", "s-1"},
			{"cf-pages/s-1/away.html", ""},
		}
		if fsxtest.Insensitive(t, root) { // the same folder, spelled otherwise
			cases = append(cases, struct{ path, want string }{"CF-PAGES/s-1/Tracker.html", "s-1"})
		}
		for _, tc := range cases {
			res, err := c.PreviewFile(context.Background(), connect.NewRequest(&v1.PreviewFileRequest{Path: filepath.Join(root, tc.path)}))
			if err != nil {
				t.Fatalf("%s: %v", tc.path, err)
			}
			want := tc.want
			if !withRoot {
				want = ""
			}
			if got := res.Msg.GetPageThread(); got != want {
				t.Errorf("pages root %v: %s: page thread %q, want %q", withRoot, tc.path, got, want)
			}
		}
	}
}
