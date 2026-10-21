package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
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
	mux.Handle(preview.Prefix, preview.Handler(grants, slog.Default()))
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
