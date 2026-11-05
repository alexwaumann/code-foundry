package api

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

// writeHome is a home with a config home at root/.code-foundry, and a client of its
// FilesystemService.
func writeHome(t *testing.T) (string, codefoundryv1connect.FilesystemServiceClient) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{
		".code-foundry/daemon.token", ".code-foundry/db.sqlite", ".code-foundry/logs/daemon.log",
		".code-foundry/pages/s-1/form.html", ".code-foundry/projects/app/main.go",
		".code-foundry/worktrees/app/wt/main.go",
		".code-foundry/workspaces/w-1/notes.md",
		".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", "src/app/main.go", "src/app/CLAUDE.md",
	} {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		".code-foundry/worktrees/app/wt/token":   ".code-foundry/daemon.token",
		"src/app/token":                          ".code-foundry/daemon.token",
		".code-foundry/workspaces/w-1/CLAUDE.md": "src/app/CLAUDE.md",
	} {
		if err := os.Symlink(filepath.Join(root, target), filepath.Join(root, link)); err != nil {
			t.Fatal(err)
		}
	}
	route := NewFilesystem(root, projecttest.New(nil), testGrants(root)).Route()
	srv := httptest.NewServer(route.Handler)
	t.Cleanup(srv.Close)
	return root, codefoundryv1connect.NewFilesystemServiceClient(srv.Client(), srv.URL)
}

func TestFilesystemWriteFileReach(t *testing.T) {
	tests := []struct {
		name, path string
		allowed    bool
	}{
		{"the daemon's token", "~/.code-foundry/daemon.token", false},
		{"the database", "~/.code-foundry/db.sqlite", false},
		{"a log", "~/.code-foundry/logs/daemon.log", false},
		{"a thread's page", "~/.code-foundry/pages/s-1/form.html", false},
		{"a symlink from a checkout to the token", "~/.code-foundry/worktrees/app/wt/token", false},
		{"a symlink from outside into the config home", "~/src/app/token", false},
		{"a workspace's own file", "~/.code-foundry/workspaces/w-1/notes.md", false},
		{"a rooted workspace's link out of the config home", "~/.code-foundry/workspaces/w-1/CLAUDE.md", true},
		{"a checkout in the config home", "~/.code-foundry/projects/app/main.go", true},
		{"a worktree in the config home", "~/.code-foundry/worktrees/app/wt/main.go", true},
		{"an ssh key", "~/.ssh/id_ed25519", true},
		{"aws credentials", "~/.aws/credentials", true},
		{"the gh config", "~/.config/gh/hosts.yml", true},
		{"a project", "~/src/app/main.go", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root, c := writeHome(t)
			ctx := context.Background()
			read, err := c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: tt.path}))
			if err != nil {
				t.Fatal(err)
			}
			res, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{
				Path: tt.path, Contents: []byte("edited"), ModifiedAt: read.Msg.GetModifiedAt(), Size: read.Msg.GetSize(),
			}))
			after, rerr := os.ReadFile(filepath.Join(root, tt.path[2:]))
			if rerr != nil {
				t.Fatal(rerr)
			}
			if !tt.allowed {
				if connect.CodeOf(err) != connect.CodeInvalidArgument {
					t.Fatalf("err = %v, want InvalidArgument", err)
				}
				if string(after) != "old" {
					t.Errorf("file changed to %q", after)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Msg.GetConflict() || string(after) != "edited" {
				t.Errorf("conflict %t, file holds %q", res.Msg.GetConflict(), after)
			}
		})
	}
}

// view.panel.file --edit asks the same reach as WriteFile, with the real config home rule.
func TestFilesystemCheckEdit(t *testing.T) {
	tests := []struct {
		name, path string
		code       connect.Code // 0: editable
	}{
		{name: "the daemon's token", path: "~/.code-foundry/daemon.token", code: connect.CodeInvalidArgument},
		{name: "a new file in the config home", path: "~/.code-foundry/notes.md", code: connect.CodeInvalidArgument},
		{name: "a symlink into the config home", path: "~/src/app/token", code: connect.CodeInvalidArgument},
		{name: "a checkout in the config home", path: "~/.code-foundry/projects/app/main.go"},
		{name: "aws credentials", path: "~/.aws/credentials"},
		{name: "a new file", path: "~/src/app/.env"},
		{name: "no directory", path: "~/src/nope/.env", code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root, _ := writeHome(t)
			h := NewFilesystem(root, projecttest.New(nil), testGrants(root))
			got, err := h.CheckEdit(context.Background(), "", tt.path)
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Fatalf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if want := filepath.Join(root, tt.path[2:]); got != want {
				t.Errorf("got %q, want %q", got, want)
			}
		})
	}
}

// A create is held to the same rule as an edit.
func TestFilesystemWriteFileCreate(t *testing.T) {
	root, c := writeHome(t)
	ctx := context.Background()
	if _, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{Path: "~/.code-foundry/new.json", Create: true})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("create in the config home: err = %v, want InvalidArgument", err)
	}
	if _, err := os.Lstat(filepath.Join(root, ".code-foundry/new.json")); err == nil {
		t.Error("created a file in the config home")
	}
	// The worktrees folder does not exist until first use; a file there would stop it.
	if err := os.RemoveAll(filepath.Join(root, ".code-foundry/worktrees")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"worktrees", "WORKTREES"} {
		if _, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{Path: "~/.code-foundry/" + name, Create: true})); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("create %s: err = %v, want InvalidArgument", name, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(root, ".code-foundry/worktrees")); err == nil {
		t.Error("a file took the worktrees folder's name")
	}
	res, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{Path: "~/.code-foundry/projects/app/new.go", Contents: []byte("x"), Create: true}))
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, ".code-foundry/projects/app/new.go")
	if res.Msg.GetResolvedPath() != want || res.Msg.GetSize() != 1 || res.Msg.GetConflict() {
		t.Errorf("response = %v", res.Msg)
	}
}

// The viewer's edit loop: a read's baseline fits, a stale one is a plain conflict that
// names the file now there, and force gets past it. Each write's response is the next
// baseline.
func TestFilesystemWriteFileConflict(t *testing.T) {
	root, c := writeHome(t)
	ctx := context.Background()
	const path = "~/src/app/main.go"
	read, err := c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: path}))
	if err != nil {
		t.Fatal(err)
	}
	first, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{
		Path: path, Contents: []byte("first"), ModifiedAt: read.Msg.GetModifiedAt(), Size: read.Msg.GetSize(),
	}))
	if err != nil || first.Msg.GetConflict() {
		t.Fatalf("first write: %v, %v", first, err)
	}
	reread, err := c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{Path: path}))
	if err != nil {
		t.Fatal(err)
	}
	if reread.Msg.GetModifiedAt() != first.Msg.GetModifiedAt() || reread.Msg.GetSize() != first.Msg.GetSize() {
		t.Errorf("write says %d/%d, a read %d/%d", first.Msg.GetModifiedAt(), first.Msg.GetSize(), reread.Msg.GetModifiedAt(), reread.Msg.GetSize())
	}
	stale, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{
		Path: path, Contents: []byte("stale"), ModifiedAt: read.Msg.GetModifiedAt(), Size: read.Msg.GetSize(),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !stale.Msg.GetConflict() || stale.Msg.GetNotFound() || stale.Msg.GetModifiedAt() != first.Msg.GetModifiedAt() || stale.Msg.GetSize() != first.Msg.GetSize() {
		t.Errorf("stale write = %v, want a conflict with the file now there", stale.Msg)
	}
	forced, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{Path: path, Contents: []byte("forced!"), Force: true}))
	if err != nil || forced.Msg.GetConflict() || forced.Msg.GetSize() != 7 {
		t.Fatalf("forced write: %v, %v", forced, err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "src/app/main.go")); string(b) != "forced!" {
		t.Errorf("file holds %q", b)
	}
	if err := os.Remove(filepath.Join(root, "src/app/main.go")); err != nil {
		t.Fatal(err)
	}
	vanished, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{Path: path, ModifiedAt: 1, Size: 1}))
	if err != nil || !vanished.Msg.GetConflict() || !vanished.Msg.GetNotFound() {
		t.Fatalf("vanished file: %v, %v", vanished, err)
	}
}

// base_dir reaches the writer: a relative path lands in the thread's checkout.
func TestFilesystemWriteFileBaseDir(t *testing.T) {
	root, c := writeHome(t)
	ctx := context.Background()
	base := filepath.Join(root, "src/app")
	read, err := c.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: "main.go"}))
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.WriteFile(ctx, connect.NewRequest(&v1.WriteFileRequest{
		BaseDir: base, Path: "main.go", Contents: []byte("edited"), ModifiedAt: read.Msg.GetModifiedAt(), Size: read.Msg.GetSize(),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetConflict() || res.Msg.GetResolvedPath() != filepath.Join(base, "main.go") {
		t.Errorf("response = %v", res.Msg)
	}
	if b, _ := os.ReadFile(filepath.Join(base, "main.go")); string(b) != "edited" {
		t.Errorf("file holds %q", b)
	}
}

// The codes the viewer acts on, from the real causes.
func TestFilesystemWriteFileCodes(t *testing.T) {
	root, c := writeHome(t)
	ctx := context.Background()
	ro := filepath.Join(root, "src/app/ro.txt")
	if err := os.WriteFile(ro, []byte("old"), 0o444); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "src/closed")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	tests := []struct {
		name string
		req  *v1.WriteFileRequest
		want connect.Code
		says string
	}{
		{"a read-only file", &v1.WriteFileRequest{Path: ro, Force: true}, connect.CodeFailedPrecondition, "read-only"},
		{"a closed folder", &v1.WriteFileRequest{Path: filepath.Join(dir, "a.txt"), Force: true}, connect.CodeFailedPrecondition, "cannot be written"},
		{"a NUL", &v1.WriteFileRequest{Path: "~/a\x00b", Create: true}, connect.CodeInvalidArgument, "NUL"},
		{"a long name", &v1.WriteFileRequest{Path: "~/" + strings.Repeat("n", 300), Create: true}, connect.CodeInvalidArgument, "too long"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.name == "a closed folder" && os.Geteuid() == 0 {
				t.Skip("root writes anywhere")
			}
			_, err := c.WriteFile(ctx, connect.NewRequest(tt.req))
			if connect.CodeOf(err) != tt.want || !strings.Contains(err.Error(), tt.says) {
				t.Fatalf("err = %v, want %v saying %q", err, tt.want, tt.says)
			}
			if strings.Contains(err.Error(), ".cf-write-") {
				t.Errorf("the error names the temp file: %v", err)
			}
		})
	}
}
