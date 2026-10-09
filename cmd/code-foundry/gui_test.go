package main

import (
	"slices"
	"testing"
)

func TestGuiBinary(t *testing.T) {
	tests := []struct {
		name    string
		exe     string
		present []string
		want    string // "" = error
	}{
		{
			name:    "installed CLI starts its sibling",
			exe:     "/Users/a/.code-foundry/app/code-foundry",
			present: []string{"/Users/a/.code-foundry/app/CodeFoundry"},
			want:    "/Users/a/.code-foundry/app/CodeFoundry",
		},
		{
			name:    "sibling wins over a dev build",
			exe:     "/src/cf/bin/code-foundry",
			present: []string{"/src/cf/bin/CodeFoundry", "/src/cf/gui/bin/CodeFoundry"},
			want:    "/src/cf/bin/CodeFoundry",
		},
		{
			name:    "repo CLI starts the dev build",
			exe:     "/src/cf/bin/code-foundry",
			present: []string{"/src/cf/gui/bin/CodeFoundry"},
			want:    "/src/cf/gui/bin/CodeFoundry",
		},
		{
			name:    "an installed app elsewhere is not searched for",
			exe:     "/usr/local/bin/code-foundry",
			present: []string{"/Users/a/.code-foundry/app/CodeFoundry", "/Users/a/Applications/CodeFoundry.app"},
		},
		{name: "nothing built", exe: "/src/cf/bin/code-foundry"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := guiBinary(tt.exe, func(p string) bool { return slices.Contains(tt.present, p) })
			if tt.want == "" {
				if err == nil {
					t.Fatalf("want error, got %s", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}
