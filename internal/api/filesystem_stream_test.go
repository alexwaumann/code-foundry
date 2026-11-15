package api

import (
	"bytes"
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
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// streamServer is the FilesystemService and the media route on one server, as the daemon's
// API listener has them, on a home with media under root/proj and a file outside it.
func streamServer(t *testing.T) (c codefoundryv1connect.FilesystemServiceClient, srv *httptest.Server, root, outside string) {
	t.Helper()
	var err error
	if root, err = filepath.EvalSymlinks(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if outside, err = filepath.EvalSymlinks(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		filepath.Join(root, "proj", "clip.mp4"):   "0123456789",
		filepath.Join(root, "proj", "notes.txt"):  "text",
		filepath.Join(root, "proj", "server.log"): strings.Repeat("a line of a log\n", 100),
		filepath.Join(outside, "secret.mp4"):      "secret",
	}
	for p, s := range files {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, "proj", "folder.mp4"), 0o755); err != nil {
		t.Fatal(err)
	}
	for link, target := range map[string]string{"out.mp4": filepath.Join(outside, "secret.mp4"), "text.mp4": filepath.Join(root, "proj", "notes.txt")} {
		if err := os.Symlink(target, filepath.Join(root, "proj", link)); err != nil {
			t.Fatal(err)
		}
	}
	grants := testGrants(root)
	route := NewFilesystem(root, projecttest.New(nil), grants).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	mux.Handle(preview.MediaPrefix, preview.MediaHandler(grants, slog.Default()))
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL), srv, root, outside
}

func TestFilesystemStreamFile(t *testing.T) {
	c, srv, root, outside := streamServer(t)
	proj := filepath.Join(root, "proj")
	tests := []struct {
		name, baseDir, path string
		code                connect.Code
	}{
		{name: "absolute", path: filepath.Join(proj, "clip.mp4")},
		{name: "relative", baseDir: proj, path: "clip.mp4"},
		{name: "tilde", path: "~/proj/clip.mp4"},
		{name: "outside home", path: filepath.Join(outside, "secret.mp4"), code: connect.CodeInvalidArgument},
		{name: "traversal", baseDir: proj, path: "../../" + filepath.Base(outside) + "/secret.mp4", code: connect.CodeInvalidArgument},
		{name: "a link leading out", path: filepath.Join(proj, "out.mp4"), code: connect.CodeInvalidArgument},
		{name: "not media", path: filepath.Join(proj, "notes.txt"), code: connect.CodeInvalidArgument},
		{name: "a media name on a file that is not", path: filepath.Join(proj, "text.mp4"), code: connect.CodeInvalidArgument},
		{name: "a directory", path: filepath.Join(proj, "folder.mp4"), code: connect.CodeInvalidArgument},
		{name: "missing", path: filepath.Join(proj, "nope.mp4"), code: connect.CodeNotFound},
		{name: "relative without base", path: "clip.mp4", code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.StreamFile(context.Background(), connect.NewRequest(&v1.StreamFileRequest{BaseDir: tt.baseDir, Path: tt.path}))
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			m := res.Msg
			if !strings.HasPrefix(m.GetUrl(), preview.MediaPrefix) || !strings.HasSuffix(m.GetUrl(), "/clip.mp4") ||
				m.GetMimeType() != "video/mp4" || m.GetSize() != 10 || m.GetModifiedAt() == 0 {
				t.Fatalf("got %+v", m)
			}
			// The URL streams with no bearer token, ranges included.
			req, _ := http.NewRequest(http.MethodGet, srv.URL+m.GetUrl(), nil)
			req.Header.Set("Range", "bytes=2-4")
			r, err := srv.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = r.Body.Close() }()
			body, _ := io.ReadAll(r.Body)
			if r.StatusCode != http.StatusPartialContent || string(body) != "234" {
				t.Errorf("GET %s: %d %q", m.GetUrl(), r.StatusCode, body)
			}
		})
	}
}

// ReadFile with tail reads a log's end, and says where it starts; a video is media, unread.
func TestFilesystemReadFileTailAndMedia(t *testing.T) {
	c, _, root, _ := streamServer(t)
	ctx := context.Background()
	res, err := c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: "~/proj/server.log", MaxBytes: 40, Tail: true}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg
	if !m.GetTruncatedStart() || m.GetTruncated() || m.GetOffset() != 1600-32 || string(m.GetContents()) != "a line of a log\na line of a log\n" || m.GetSize() != 1600 {
		t.Errorf("tail: start %t end %t offset %d contents %q", m.GetTruncatedStart(), m.GetTruncated(), m.GetOffset(), m.GetContents())
	}
	res, err = c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: "~/proj/server.log", MaxBytes: 40}))
	if err != nil {
		t.Fatal(err)
	}
	if m := res.Msg; m.GetTruncatedStart() || !m.GetTruncated() || m.GetOffset() != 0 || !bytes.HasPrefix([]byte(strings.Repeat("a line of a log\n", 3)), m.GetContents()) {
		t.Errorf("head: %+v", m)
	}
	res, err = c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: filepath.Join(root, "proj", "clip.mp4"), MaxBytes: 32 << 20}))
	if err != nil {
		t.Fatal(err)
	}
	if m := res.Msg; !m.GetMedia() || !m.GetBinary() || len(m.GetContents()) != 0 || m.GetMimeType() != "video/mp4" || m.GetSize() != 10 || m.GetTruncated() {
		t.Errorf("media: %+v", m)
	}
}
