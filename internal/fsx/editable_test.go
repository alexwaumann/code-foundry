package fsx

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

// marker stands for what a file must never give away.
const marker = "MARKER-sk-live-4242"

func TestEditable(t *testing.T) {
	long := strings.Repeat(marker+"\n", MaxReadBytes/len(marker)+1)
	tests := []struct {
		name string
		make func(h *writeHome) string
		want error
		says string
	}{
		{name: "a text file", make: func(h *writeHome) string { return h.file(h.at("proj/.env"), "KEY="+marker+"\n", 0o600) }},
		{name: "an empty file", make: func(h *writeHome) string { return h.file(h.at("proj/.env"), "", 0o600) }},
		{name: "exactly the most it edits", make: func(h *writeHome) string {
			return h.file(h.at("proj/big.txt"), strings.Repeat("x", MaxReadBytes), 0o600)
		}},
		{name: "through a symlink", make: func(h *writeHome) string {
			return h.link(h.file(h.at("proj/real"), marker, 0o600), h.at("proj/link"))
		}},
		{name: "a new file", make: func(h *writeHome) string { return h.at("proj/.env") }},
		{name: "a new file through a linked folder", make: func(h *writeHome) string {
			return h.link(h.at("proj"), h.at("linked")) + "/.env"
		}},
		{name: "no directory", want: ErrInvalidArgument, says: "directory", make: func(h *writeHome) string { return h.at("proj/nope/.env") }},
		{name: "a parent that is a file", want: ErrInvalidArgument, says: "not a directory", make: func(h *writeHome) string {
			return h.file(h.at("proj/file"), marker, 0o600) + "/.env"
		}},
		{name: "a directory", want: ErrInvalidArgument, says: "is a directory", make: func(h *writeHome) string { return h.at("proj") }},
		{name: "a symlink leading nowhere", want: ErrInvalidArgument, says: "leads nowhere", make: func(h *writeHome) string {
			return h.link(h.at("proj/gone"), h.at("proj/dead"))
		}},
		{name: "a fifo", want: ErrInvalidArgument, says: "not a regular file", make: func(h *writeHome) string {
			p := h.at("proj/pipe")
			if err := syscall.Mkfifo(p, 0o644); err != nil {
				t.Fatal(err)
			}
			return p
		}},
		{name: "outside home", want: ErrInvalidArgument, says: "outside your home", make: func(h *writeHome) string { return h.file(h.outside+"/x", marker, 0o600) }},
		{name: "protected", want: ErrInvalidArgument, says: "Code Foundry's own data", make: func(h *writeHome) string {
			h.w.Protected = func(string) bool { return true }
			return h.file(h.at("proj/token"), marker, 0o600)
		}},
		{name: "a new file where it is protected", want: ErrInvalidArgument, says: "Code Foundry's own data", make: func(h *writeHome) string {
			h.w.Protected = func(string) bool { return true }
			return h.at("proj/token")
		}},
		{name: "read-only", want: ErrNotWritable, says: "read-only", make: func(h *writeHome) string { return h.file(h.at("proj/ro"), marker, 0o400) }},
		{name: "binary", want: ErrInvalidArgument, says: "binary", make: func(h *writeHome) string { return h.file(h.at("proj/b"), marker+"\x00", 0o600) }},
		{name: "by its type", want: ErrInvalidArgument, says: "binary", make: func(h *writeHome) string { return h.file(h.at("proj/a.zip"), marker, 0o600) }},
		{name: "an image that is text", want: ErrInvalidArgument, says: "image", make: func(h *writeHome) string { return h.file(h.at("proj/a.svg"), "<svg>"+marker, 0o600) }},
		{name: "over the most it edits", want: ErrInvalidArgument, says: "over 1 MiB", make: func(h *writeHome) string { return h.file(h.at("proj/big.txt"), long, 0o600) }},
		{name: "a byte order mark", want: ErrInvalidArgument, says: "byte order mark", make: func(h *writeHome) string { return h.file(h.at("proj/bom"), "\xEF\xBB\xBF"+marker, 0o600) }},
		{name: "invalid UTF-8", want: ErrInvalidArgument, says: "UTF-8", make: func(h *writeHome) string { return h.file(h.at("proj/latin"), marker+"\xE9", 0o600) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			path := tt.make(h)
			got, err := h.w.Editable("", path)
			if tt.want != nil {
				if !errors.Is(err, tt.want) {
					t.Fatalf("err = %v, want %v", err, tt.want)
				}
				if !strings.Contains(err.Error(), tt.says) {
					t.Errorf("err = %q, want it to say %q", err, tt.says)
				}
				if strings.Contains(err.Error(), marker) || strings.Contains(err.Error(), "bytes") {
					t.Errorf("err = %q gives the file away", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != path {
				t.Errorf("got %s, want %s", got, path)
			}
		})
	}
}

// A relative path is read against the base, as ReadFile's is.
func TestEditableRelative(t *testing.T) {
	h := newWriteHome(t)
	h.file(h.at("proj/.env"), "A=1\n", 0o600)
	got, err := h.w.Editable(h.at("proj"), ".env")
	if err != nil || got != h.at("proj/.env") {
		t.Fatalf("got %s, %v", got, err)
	}
}
