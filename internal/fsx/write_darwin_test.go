package fsx

import (
	"errors"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// A Finder-locked file or folder refuses with the EPERM macOS's privacy protection gives,
// and must not be sent to Full Disk Access.
func TestWriteLocked(t *testing.T) {
	tests := []struct {
		name string
		lock func(h *writeHome, p string) string
		says string
	}{
		{"a locked file", func(_ *writeHome, p string) string { return p }, "a.txt is locked"},
		{"a locked folder", func(_ *writeHome, p string) string { return filepath.Dir(p) }, "is locked"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			p := h.file(h.at("proj/a.txt"), "old", 0o644)
			target := tt.lock(h, p)
			if err := syscall.Chflags(target, unix.UF_IMMUTABLE); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = syscall.Chflags(target, 0) })
			_, err := h.w.Write(WriteRequest{Path: p, Contents: []byte(newContents), Force: true})
			if !errors.Is(err, ErrNotWritable) || errors.Is(err, ErrNotPermitted) {
				t.Fatalf("err = %v, want ErrNotWritable", err)
			}
			msg := err.Error()
			if !strings.Contains(msg, tt.says) || strings.Contains(msg, "Full Disk Access") || strings.Contains(msg, tempName) {
				t.Errorf("err = %v", err)
			}
			if s := h.contents(p); s != "old" {
				t.Errorf("file changed to %q", s)
			}
			if err := syscall.Chflags(target, 0); err != nil {
				t.Fatal(err)
			}
			if left := h.temps(); len(left) != 0 {
				t.Errorf("temp files left: %v", left)
			}
		})
	}
}
