package thread

import (
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func strp(s string) *string { return &s }

func TestSetPageStorage(t *testing.T) {
	big := `"` + strings.Repeat("x", PageStorageMax) + `"`
	tests := []struct {
		name    string
		key     string
		value   *string
		want    map[string]string
		wantErr error
	}{
		{"set a value", "count", strp("3"), map[string]string{"seed": `{"a":1}`, "count": "3"}, nil},
		{"replace a value", "seed", strp(`[1,2]`), map[string]string{"seed": "[1,2]"}, nil},
		{"remove a key", "seed", nil, map[string]string{}, nil},
		{"remove a key that is not there", "nope", nil, map[string]string{"seed": `{"a":1}`}, nil},
		{"an empty key", "", strp("1"), nil, ErrInvalidArgument},
		{"a too long key", strings.Repeat("k", PageStorageKeyMax+1), strp("1"), nil, ErrInvalidArgument},
		{"a value that is not JSON", "k", strp("{oops"), nil, ErrInvalidArgument},
		{"over the cap", "k", strp(big), nil, ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "page-storage")
			e := newEnv(t, func(o *Options) { o.PageStorageRoot = root })
			s := e.create(CreateOptions{})
			if _, err := e.m.SetPageStorage(e.ctx(), s.ID, "seed", strp(`{"a": 1}`)); err != nil {
				t.Fatal(err)
			}
			got, err := e.m.SetPageStorage(e.ctx(), s.ID, tt.key, tt.value)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if tt.wantErr != nil {
				// Nothing written: the storage is as it was.
				got, err = e.m.PageStorage(e.ctx(), s.ID)
				if err != nil {
					t.Fatal(err)
				}
				tt.want = map[string]string{"seed": `{"a":1}`}
			}
			if !maps.Equal(got, tt.want) {
				t.Errorf("storage = %v, want %v", got, tt.want)
			}
			// What a new daemon reads back.
			e.restart(func(o *Options) { o.PageStorageRoot = root })
			again, err := e.m.PageStorage(e.ctx(), s.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !maps.Equal(again, tt.want) {
				t.Errorf("after a restart = %v, want %v", again, tt.want)
			}
		})
	}
}

// An unknown thread is NotFound; removing a thread removes its storage.
func TestPageStorageGoesWithTheThread(t *testing.T) {
	root := filepath.Join(t.TempDir(), "page-storage")
	e := newEnv(t, func(o *Options) { o.PageStorageRoot = root })
	if _, err := e.m.PageStorage(e.ctx(), "s-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: err = %v, want ErrNotFound", err)
	}
	if _, err := e.m.SetPageStorage(e.ctx(), "s-nope", "k", strp("1")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread: set err = %v, want ErrNotFound", err)
	}
	s := e.create(CreateOptions{})
	if _, err := e.m.SetPageStorage(e.ctx(), s.ID, "k", strp("1")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, s.ID)
	if _, err := os.Stat(filepath.Join(dir, "storage.json")); err != nil {
		t.Fatalf("storage file: %v", err)
	}
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("%s after remove: %v", dir, err)
	}
}

// A file that does not parse reads as empty and the next write replaces it.
func TestPageStorageUnreadableFile(t *testing.T) {
	root := filepath.Join(t.TempDir(), "page-storage")
	e := newEnv(t, func(o *Options) { o.PageStorageRoot = root })
	s := e.create(CreateOptions{})
	if err := os.MkdirAll(filepath.Join(root, s.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, s.ID, "storage.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := e.m.PageStorage(e.ctx(), s.ID)
	if err != nil || len(got) != 0 {
		t.Fatalf("storage = %v, %v; want empty", got, err)
	}
	got, err = e.m.SetPageStorage(e.ctx(), s.ID, "k", strp(`"v"`))
	if err != nil || !maps.Equal(got, map[string]string{"k": `"v"`}) {
		t.Fatalf("storage = %v, %v", got, err)
	}
}
