package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadWindowZoom(t *testing.T) {
	dir := t.TempDir()
	tests := []struct {
		name    string
		content *string
		want    int
	}{
		{"missing file", nil, 100},
		{"saved percent", ptr(`{"percent":150}`), 150},
		{"not json", ptr(`150`), 100},
		{"below the range", ptr(`{"percent":5}`), 100},
		{"above the range", ptr(`{"percent":5000}`), 100},
		{"empty object", ptr(`{}`), 100},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(dir, tt.name+".json")
			if tt.content != nil {
				if err := os.WriteFile(path, []byte(*tt.content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if got := loadWindowZoom(path); got != tt.want {
				t.Errorf("loadWindowZoom = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestSetZoomSavesForNextLaunch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "window-zoom.json")
	s := NewAppService(nil, "", path)
	if err := s.SetZoom(125); err != nil {
		t.Fatal(err)
	}
	if got := loadWindowZoom(path); got != 125 {
		t.Errorf("saved zoom = %d, want 125", got)
	}
	if got := NewAppService(nil, "", path).zoomSaved; got != 125 {
		t.Errorf("next launch's zoom = %d, want 125", got)
	}
	for _, bad := range []int{0, 24, 501} {
		if err := s.SetZoom(bad); err == nil {
			t.Errorf("SetZoom(%d) = nil, want an error", bad)
		}
	}
	if got := loadWindowZoom(path); got != 125 {
		t.Errorf("saved zoom after refused values = %d, want 125", got)
	}
}

func ptr(s string) *string { return &s }
