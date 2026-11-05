package api

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// tempFilesystem is the handler as the daemon wires it, on a home and a temp folder under
// base: tmp is a link to private/tmp, as on macOS.
func tempFilesystem(t *testing.T) (h *Filesystem, at func(string) string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at = func(p string) string { return filepath.Join(base, p) }
	for _, f := range []string{
		"home/notes.txt", "private/tmp/note.txt", "private/tmp/direct.html", "private/tmp/foo/page.html", "outside/secret.html",
		"private/tmp/cf-drive/daemon.token", "private/tmp/cf-drive/page.html",
	} {
		if err := os.MkdirAll(filepath.Dir(at(f)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at(f), []byte("<p>x</p>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(at("private/tmp"), at("tmp")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(at("outside/secret.html"), at("private/tmp/foo/out.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(at("private/tmp/foo/page.html"), at("home/to-temp.html")); err != nil {
		t.Fatal(err)
	}
	temps := []string{at("tmp"), at("private/tmp")}
	home := at("home")
	grants := preview.NewGrants(preview.NewFloor(home, paths.New(filepath.Join(home, ".code-foundry"))).WithTemp(temps))
	return NewFilesystem(home, projecttest.New(nil), grants).WithTemp(temps), at
}

func TestFilesystemReadTemp(t *testing.T) {
	h, at := tempFilesystem(t)
	tests := []struct {
		name, path  string
		notFound    bool
		outsideHome bool
		code        connect.Code
	}{
		{name: "a temp file", path: "tmp/note.txt", outsideHome: true},
		{name: "resolved", path: "private/tmp/note.txt", outsideHome: true},
		{name: "missing", path: "tmp/nope.txt", notFound: true, outsideHome: true},
		{name: "a home file", path: "home/notes.txt"},
		{name: "a link out", path: "tmp/foo/out.html", code: connect.CodeInvalidArgument},
		{name: "elsewhere", path: "outside/secret.html", code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := h.ReadFile(context.Background(), connect.NewRequest(&v1.ReadFileRequest{Path: at(tt.path)}))
			if tt.code != 0 {
				if got := connect.CodeOf(err); got != tt.code {
					t.Fatalf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetNotFound() != tt.notFound || res.Msg.GetOutsideHome() != tt.outsideHome {
				t.Errorf("not_found %t outside_home %t", res.Msg.GetNotFound(), res.Msg.GetOutsideHome())
			}
		})
	}
}

func TestFilesystemPreviewTemp(t *testing.T) {
	h, at := tempFilesystem(t)
	tests := []struct {
		name, path string
		scope      string
		single     bool
		code       connect.Code
		wantMsg    string
	}{
		{name: "directly in the temp folder: the file alone", path: "tmp/direct.html", scope: "tmp/direct.html", single: true},
		{name: "resolved", path: "private/tmp/direct.html", scope: "private/tmp/direct.html", single: true},
		{name: "in a folder: the folder", path: "tmp/foo/page.html", scope: "tmp/foo"},
		{name: "missing", path: "tmp/nope.html", code: connect.CodeNotFound},
		{name: "a link out", path: "tmp/foo/out.html", code: connect.CodeInvalidArgument, wantMsg: "temp folders"},
		{name: "a link from home into temp", path: "home/to-temp.html", code: connect.CodeInvalidArgument, wantMsg: "links into a temp folder"},
		{name: "a config home in temp", path: "tmp/cf-drive/page.html", code: connect.CodeInvalidArgument, wantMsg: "protected folder"},
		{name: "a token in temp", path: "tmp/cf-drive/daemon.token", code: connect.CodeInvalidArgument, wantMsg: "protected folder"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := h.PreviewFile(context.Background(), connect.NewRequest(&v1.PreviewFileRequest{Path: at(tt.path)}))
			if tt.code != 0 {
				if got := connect.CodeOf(err); got != tt.code || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v holding %q", err, tt.code, tt.wantMsg)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetScope() != at(tt.scope) || res.Msg.GetSingleFile() != tt.single {
				t.Errorf("scope %s single %t", res.Msg.GetScope(), res.Msg.GetSingleFile())
			}
		})
	}
}

// Only reads leave home: a write, an edit check and directory completion in a temp folder
// are refused as they were.
func TestFilesystemTempStaysReadOnly(t *testing.T) {
	h, at := tempFilesystem(t)
	const refusal = "outside your home directory"
	before, err := os.ReadFile(at("tmp/note.txt"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: at("tmp/note.txt"), Contents: []byte("new"), Force: true}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), refusal) {
		t.Errorf("WriteFile: %v", err)
	}
	_, err = h.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: at("tmp/made.txt"), Contents: []byte("new"), Create: true}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), refusal) {
		t.Errorf("WriteFile create: %v", err)
	}
	if after, err := os.ReadFile(at("tmp/note.txt")); err != nil || string(after) != string(before) {
		t.Errorf("the file changed: %q, %v", after, err)
	}
	if _, err := h.CheckEdit(context.Background(), "", at("tmp/note.txt")); connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), refusal) {
		t.Errorf("CheckEdit: %v", err)
	}
	_, err = h.ListDirectories(context.Background(), connect.NewRequest(&v1.ListDirectoriesRequest{Prefix: at("tmp/")}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument || !strings.Contains(err.Error(), refusal) {
		t.Errorf("ListDirectories: %v", err)
	}
}
