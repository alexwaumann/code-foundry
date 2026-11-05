package fsx

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestTempRoots(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	home := filepath.Join(base, "users", "me")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	homeLink := filepath.Join(base, "home-link")
	if err := os.Symlink(home, homeLink); err != nil {
		t.Fatal(err)
	}
	homeTmp := filepath.Join(home, "proj", ".tmp")
	if err := os.MkdirAll(homeTmp, 0o755); err != nil {
		t.Fatal(err)
	}
	homeTmpLink := filepath.Join(base, "home-tmp-link")
	if err := os.Symlink(homeTmp, homeTmpLink); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// /tmp is always there, in the forms it has on this machine.
	tmp := []string{"/tmp"}
	if r, err := filepath.EvalSymlinks("/tmp"); err == nil && r != "/tmp" {
		tmp = append(tmp, r)
	}
	// A sticky folder that is not the user's, spelled and resolved.
	sticky := []string{"/var/tmp"}
	if r, err := filepath.EvalSymlinks("/var/tmp"); err == nil && r != "/var/tmp" {
		sticky = append(sticky, r)
	}
	tests := []struct {
		name, tmpdir string
		want         []string
	}{
		{"a folder of its own", real, append(slices.Clone(tmp), real)},
		{"a trailing slash, as macOS has it", real + "/", append(slices.Clone(tmp), real)},
		{"spelled and resolved", link, append(slices.Clone(tmp), link, real)},
		{"/tmp itself: no repeats", "/tmp", tmp},
		{"/tmp resolved: no repeats", tmp[len(tmp)-1], tmp},
		{"sticky, not the user's", "/var/tmp", append(slices.Clone(tmp), sticky...)},
		{"below home: home's rules cover it", homeTmp, tmp},
		{"a link to below home", homeTmpLink, tmp},
		{"missing", filepath.Join(base, "nope"), tmp},
		{"a file", file, tmp},
		{"the filesystem's root", "/", tmp},
		{"home", home, tmp},
		{"above home", filepath.Dir(home), tmp},
		{"a link to home", homeLink, tmp},
		{"relative", "scratch", tmp},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TMPDIR", tt.tmpdir)
			if got := TempRoots(home); !slices.Equal(got, tt.want) {
				t.Errorf("TempRoots = %v, want %v", got, tt.want)
			}
		})
	}
}

// A $TMPDIR of a system folder is no temp folder. The home is one that none of them holds:
// a test's own lies under /var on macOS, which would hide the rule.
func TestTempRootsSystemFolders(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root owns these")
	}
	const home = "/Users/nobody"
	t.Setenv("TMPDIR", "/tmp")
	want := TempRoots(home)
	for _, dir := range []string{"/private", "/var", "/etc", "/usr"} {
		t.Run(dir, func(t *testing.T) {
			if _, err := os.Stat(dir); err != nil {
				t.Skip(err)
			}
			t.Setenv("TMPDIR", dir)
			if got := TempRoots(home); !slices.Equal(got, want) {
				t.Errorf("TempRoots = %v, want %v", got, want)
			}
		})
	}
	t.Setenv("TMPDIR", "/etc")
	if _, err := ReadFile(ReadRoots{Home: home, Temp: TempRoots(home)}, "", "/etc/hosts", 0); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("read /etc/hosts: err = %v, want the refusal", err)
	}
}

func TestTempRoot(t *testing.T) {
	r := ReadRoots{Temp: []string{"/tmp", "/private/tmp", "/tmp/mine", "/private/tmp/mine"}}
	tests := []struct{ p, want string }{
		{"/tmp/x", "/tmp"},
		{"/tmp", "/tmp"},
		{"/TMP/x", "/tmp"},
		{"/private/tmp/x", "/private/tmp"},
		{"/tmp/mine/x", "/tmp/mine"},
		{"/private/tmp/mine", "/private/tmp/mine"},
		{"/tmpfoo/x", ""},
		{"/etc/hosts", ""},
	}
	for _, tt := range tests {
		if got := r.TempRoot(tt.p); got != tt.want {
			t.Errorf("TempRoot(%s) = %q, want %q", tt.p, got, tt.want)
		}
	}
}
