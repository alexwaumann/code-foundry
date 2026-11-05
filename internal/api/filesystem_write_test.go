package api

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
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
		".ssh/id_ed25519", ".aws/credentials", ".config/gh/hosts.yml", "src/app/main.go",
	} {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, ".code-foundry/daemon.token"), filepath.Join(root, ".code-foundry/worktrees/app/wt/token")); err != nil {
		t.Fatal(err)
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
