package main

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestFilesDropped(t *testing.T) {
	target := func(attrs map[string]string) *application.DropTargetDetails {
		return &application.DropTargetDetails{ElementID: "x", Attributes: attrs}
	}
	tests := []struct {
		name   string
		paths  []string
		target *application.DropTargetDetails
		want   FilesDropped
		ok     bool
	}{
		{"no paths", nil, target(map[string]string{"data-drop-id": "c1"}), FilesDropped{}, false},
		{"empty paths", []string{}, target(map[string]string{"data-drop-id": "c1"}), FilesDropped{}, false},
		{"with id", []string{"/a.png", "/b c.txt"}, target(map[string]string{"data-file-drop-target": "", "data-drop-id": "c1"}), FilesDropped{Paths: []string{"/a.png", "/b c.txt"}, Target: "c1"}, true},
		{"target without id", []string{"/a.png"}, target(map[string]string{"data-file-drop-target": ""}), FilesDropped{Paths: []string{"/a.png"}}, true},
		{"no attributes", []string{"/a.png"}, target(nil), FilesDropped{Paths: []string{"/a.png"}}, true},
		{"no target", []string{"/a.png"}, nil, FilesDropped{Paths: []string{"/a.png"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := filesDropped(tt.paths, tt.target)
			if ok != tt.ok || !reflect.DeepEqual(got, tt.want) {
				t.Errorf("filesDropped = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestFilesDroppedJSON(t *testing.T) {
	p, _ := filesDropped([]string{"/x/a.png"}, &application.DropTargetDetails{Attributes: map[string]string{"data-drop-id": "r1"}})
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(b), `{"paths":["/x/a.png"],"target":"r1"}`; got != want {
		t.Errorf("json = %s, want %s", got, want)
	}
}

func TestFilesDroppedCopiesPaths(t *testing.T) {
	in := []string{"/a.png"}
	p, _ := filesDropped(in, nil)
	in[0] = "/changed"
	if p.Paths[0] != "/a.png" {
		t.Errorf("payload shares the input slice: %q", p.Paths[0])
	}
}

func TestFilesStart(t *testing.T) {
	dirs := map[string]bool{"/Users/me": true, "/Users/me/src/app": true, "/opt/repo": true}
	isDir := func(p string) bool { return dirs[p] }
	tests := []struct{ start, want string }{
		{"", "/Users/me"},
		{"relative/dir", "/Users/me"},
		{"~/src/app", "/Users/me"},
		{"/Users/me/src/app", "/Users/me/src/app"},
		{"/Users/me/src/app/", "/Users/me/src/app"},
		{"/Users/me/src/x/../app", "/Users/me/src/app"},
		{"/Users/me/src/gone", "/Users/me"},
		{"/opt/repo", "/opt/repo"},
	}
	for _, tt := range tests {
		if got := filesStart(tt.start, "/Users/me", isDir); got != tt.want {
			t.Errorf("filesStart(%q) = %q, want %q", tt.start, got, tt.want)
		}
	}
}
