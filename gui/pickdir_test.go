package main

import "testing"

func TestPickStart(t *testing.T) {
	dirs := map[string]bool{"/Users/me": true, "/Users/me/src": true, "/Users/me/src/app": true}
	isDir := func(p string) bool { return dirs[p] }
	tests := []struct{ typed, want string }{
		{"", "/Users/me"},
		{"~", "/Users/me"},
		{"~/", "/Users/me"},
		{"~/src/app", "/Users/me/src/app"},
		{"~/src/app/", "/Users/me/src/app"},
		{"~/src/ap", "/Users/me/src"},
		{"~/src/new/deeper", "/Users/me/src"},
		{"/Users/me/src", "/Users/me/src"},
		{"/opt/elsewhere", "/Users/me"},
		{"~/../other", "/Users/me"},
		{"relative/path", "/Users/me"},
		{"~bob/x", "/Users/me"},
	}
	for _, tt := range tests {
		if got := pickStart(tt.typed, "/Users/me", isDir); got != tt.want {
			t.Errorf("pickStart(%q) = %q, want %q", tt.typed, got, tt.want)
		}
	}
}
