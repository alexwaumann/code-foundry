package api

import (
	"context"
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
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func TestFilesystemPreviewFile(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	proj := filepath.Join(root, "proj")
	wt := filepath.Join(root, "proj-wt")
	for _, f := range []string{"proj/docs/index.html", "proj-wt/site/page.html", "loose/mock.html"} {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("<p>x</p>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fake := projecttest.New(nil)
	fake.Put(project.Project{ID: "p", Path: proj, Worktrees: []project.Worktree{
		{ProjectID: "p", Path: proj, IsMain: true},
		{ProjectID: "p", Path: wt},
	}})
	grants := preview.NewGrants()
	route := NewFilesystem(root, fake, grants).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	mux.Handle(preview.Prefix, preview.Handler(root, grants, slog.Default()))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
	ctx := context.Background()

	tests := []struct {
		name, baseDir, path string
		scope, rel          string
		code                connect.Code
	}{
		{name: "in the main checkout", path: filepath.Join(proj, "docs/index.html"), scope: proj, rel: "docs/index.html"},
		{name: "in a worktree, relative", baseDir: wt, path: "site/page.html", scope: wt, rel: "site/page.html"},
		{name: "outside every checkout", path: "~/loose/mock.html", scope: filepath.Join(root, "loose"), rel: "mock.html"},
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
			if res.Msg.GetScope() != tc.scope {
				t.Errorf("scope %q, want %q", res.Msg.GetScope(), tc.scope)
			}
			grant, _ := grants.Grant(tc.scope)
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
}
