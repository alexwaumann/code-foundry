package main

import (
	"slices"
	"strings"
	"testing"
)

func TestGuiCommand(t *testing.T) {
	const home = "/Users/a"
	tests := []struct {
		name    string
		exe     string
		present []string
		env     map[string]string
		want    string // argv joined by spaces; "" = error
	}{
		{
			name: "CLI inside a bundle opens that bundle",
			exe:  "/Users/a/Applications/CodeFoundry.app/Contents/MacOS/code-foundry",
			want: "/usr/bin/open /Users/a/Applications/CodeFoundry.app",
		},
		{
			name: "config home is forwarded",
			exe:  "/Applications/CodeFoundry.app/Contents/MacOS/code-foundry",
			env:  map[string]string{"CODE_FOUNDRY_HOME": "/tmp/cf"},
			want: "/usr/bin/open --env CODE_FOUNDRY_HOME=/tmp/cf /Applications/CodeFoundry.app",
		},
		{
			name:    "dev CLI prefers the dev bundle and points it at itself",
			exe:     "/src/cf/bin/code-foundry",
			present: []string{"/src/cf/gui/bin/CodeFoundry.app", "/Users/a/Applications/CodeFoundry.app"},
			want:    "/usr/bin/open --env CODE_FOUNDRY_BIN=/src/cf/bin/code-foundry /src/cf/gui/bin/CodeFoundry.app",
		},
		{
			name:    "dev CLI with only the dev binary runs it",
			exe:     "/src/cf/bin/code-foundry",
			present: []string{"/src/cf/gui/bin/CodeFoundry"},
			want:    "/src/cf/gui/bin/CodeFoundry",
		},
		{
			name:    "standalone CLI opens the installed app",
			exe:     "/usr/local/bin/code-foundry",
			present: []string{"/Users/a/Applications/CodeFoundry.app"},
			want:    "/usr/bin/open /Users/a/Applications/CodeFoundry.app",
		},
		{
			name:    "then /Applications",
			exe:     "/usr/local/bin/code-foundry",
			present: []string{"/Applications/CodeFoundry.app"},
			want:    "/usr/bin/open /Applications/CodeFoundry.app",
		},
		{name: "nothing installed", exe: "/usr/local/bin/code-foundry"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			argv, err := guiCommand(tt.exe, home, func(k string) string { return tt.env[k] }, func(p string) bool { return slices.Contains(tt.present, p) })
			if tt.want == "" {
				if err == nil {
					t.Fatalf("want error, got %v", argv)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(argv, " "); got != tt.want {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}
