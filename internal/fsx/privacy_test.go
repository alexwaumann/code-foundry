package fsx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestProtectedArea(t *testing.T) {
	const root = "/Users/me"
	tests := []struct {
		real, want string
	}{
		{"/Users/me/Documents/a.pdf", "your Documents folder"},
		{"/Users/me/documents/a.pdf", "your Documents folder"}, // APFS ignores case
		{"/Users/me/Desktop/Screenshot.png", "your Desktop folder"},
		{"/Users/me/Downloads/x/y.txt", "your Downloads folder"},
		{"/Users/me/Library/Mobile Documents/com~apple~CloudDocs/n.md", "iCloud Drive"},
		{"/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/a.md", "files managed by GoogleDrive"},
		{"/Users/me/Library/CloudStorage/Dropbox/a.md", "files managed by Dropbox"},
		{"/Users/me/Library/Mail/V10/x.emlx", ""},
		{"/Users/me/.Trash/old.txt", ""},
		{"/Users/me/DocumentsArchive/a.md", ""},
		{"/Users/me", ""},
		{"/Users/other/Documents/a.md", ""},
	}
	for _, tt := range tests {
		if got := protectedArea(root, tt.real); got != tt.want {
			t.Errorf("protectedArea(%q) = %q, want %q", tt.real, got, tt.want)
		}
	}
}

func TestPrivacyMessage(t *testing.T) {
	const root = "/Users/me"
	tests := []struct {
		name, path, real, app, want string
	}{
		{
			name: "a folder under Files and Folders, a terminal responsible",
			path: "/Users/me/Documents/a.pdf", real: "/Users/me/Documents/a.pdf", app: "iTerm",
			want: `macOS's privacy protection blocked reading /Users/me/Documents/a.pdf: "iTerm" has no access to your Documents folder. Allow it in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then retry.`,
		},
		{
			name: "a symlink into a protected folder is judged by where it leads",
			path: "/Users/me/proj/notes.md", real: "/Users/me/Desktop/notes.md", app: "Code Foundry",
			want: `macOS's privacy protection blocked reading /Users/me/proj/notes.md: "Code Foundry" has no access to your Desktop folder. Allow it in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then retry.`,
		},
		{
			name: "only Full Disk Access opens it",
			path: "/Users/me/.Trash/old.txt", real: "/Users/me/.Trash/old.txt", app: "code-foundry",
			want: `macOS's privacy protection blocked reading /Users/me/.Trash/old.txt: "code-foundry" needs Full Disk Access to read it. Allow it in System Settings → Privacy & Security → Full Disk Access, then retry.`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := privacyMessage(root, tt.path, tt.real, tt.app); got != tt.want {
				t.Errorf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

func TestNotPermittedError(t *testing.T) {
	open := &fs.PathError{Op: "open", Path: "/Users/me/Documents/a.pdf", Err: syscall.EPERM}
	if !isPrivacyDenial(open) {
		t.Fatal("EPERM from open is not a privacy denial")
	}
	if isPrivacyDenial(&fs.PathError{Op: "open", Path: "/x", Err: syscall.EACCES}) {
		t.Fatal("EACCES (file modes) is a privacy denial")
	}
	err := notPermitted("/Users/me", open.Path, open.Path, open)
	if !errors.Is(err, ErrNotPermitted) || !errors.Is(err, fs.ErrPermission) || errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("notPermitted's error matches ErrNotPermitted %t, fs.ErrPermission %t, ErrInvalidArgument %t",
			errors.Is(err, ErrNotPermitted), errors.Is(err, fs.ErrPermission), errors.Is(err, ErrInvalidArgument))
	}
}

// A file the file modes keep closed (EACCES) is not a privacy denial: no TCC advice.
func TestReadFileUnreadableIsNotPrivacy(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads any file")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(root, "secret.txt")
	if err := os.WriteFile(p, []byte("x"), 0o000); err != nil {
		t.Fatal(err)
	}
	_, err = ReadFile(root, "", p, 0)
	if err == nil || errors.Is(err, ErrNotPermitted) || !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("ReadFile(mode 000) = %v, want a plain permission error", err)
	}
}
