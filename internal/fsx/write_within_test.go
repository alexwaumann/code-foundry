package fsx

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A write with Within lands under that directory, symlinks resolved on both sides, and
// Lookup refuses what Write would.
func TestWriteWithin(t *testing.T) {
	tests := []struct {
		name, path string
		ok         bool
	}{
		{"a file in the checkout", "rows.csv", true},
		{"a file in a folder of it", "out/rows.csv", true},
		{"a link inside it", "inner/rows.csv", true},
		{"up and out", "../other/rows.csv", false},
		{"a link to a folder outside it", "away/rows.csv", false},
		{"a link to a file outside it", "away.csv", false},
		{"the checkout itself", ".", false},
		{"a missing folder", "nowhere/rows.csv", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			proj := h.at("proj")
			for _, d := range []string{"out", "../other"} {
				if err := os.MkdirAll(filepath.Join(proj, d), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			h.link(filepath.Join(proj, "out"), filepath.Join(proj, "inner"))
			h.link(h.at("other"), filepath.Join(proj, "away"))
			h.link(h.file(h.at("other/target.csv"), "old", 0o644), filepath.Join(proj, "away.csv"))

			req := WriteRequest{BaseDir: proj, Path: tt.path, Contents: []byte("a,b\n"), Create: true, Within: proj}
			look, lerr := h.w.Lookup(req)
			res, werr := h.w.Write(req)
			if tt.ok {
				if lerr != nil || werr != nil || !look.NotFound || res.Conflict {
					t.Fatalf("Lookup = %+v, %v; Write = %+v, %v", look, lerr, res, werr)
				}
				return
			}
			if !errors.Is(lerr, ErrInvalidArgument) || !errors.Is(werr, ErrInvalidArgument) {
				t.Fatalf("Lookup err = %v, Write err = %v, want ErrInvalidArgument", lerr, werr)
			}
			if b, _ := os.ReadFile(h.at("other/target.csv")); string(b) != "old" {
				t.Errorf("the file outside became %q", b)
			}
		})
	}
}

// Lookup's baseline replaces the file it saw, and nothing else.
func TestLookupBaseline(t *testing.T) {
	h := newWriteHome(t)
	p := h.file(h.at("proj/rows.csv"), "old", 0o644)
	look, err := h.w.Lookup(WriteRequest{BaseDir: h.at("proj"), Path: "rows.csv"})
	if err != nil || look.NotFound || look.Path != p || look.Size != 3 {
		t.Fatalf("Lookup = %+v, %v", look, err)
	}
	res, err := h.w.Write(WriteRequest{BaseDir: h.at("proj"), Path: "rows.csv", Contents: []byte("new"), Size: look.Size, ModifiedAt: look.ModifiedAt})
	if err != nil || res.Conflict {
		t.Fatalf("Write = %+v, %v", res, err)
	}
	if _, err := h.w.Lookup(WriteRequest{BaseDir: h.at("proj"), Path: "missing/rows.csv"}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a missing folder: err = %v", err)
	}
	if _, err := h.w.Lookup(WriteRequest{BaseDir: h.at("proj"), Path: "."}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("a directory: err = %v", err)
	}
}
