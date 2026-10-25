package command

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestFreeWorkspaceName(t *testing.T) {
	long := strings.Repeat("a", 120)
	accents := strings.Repeat("é", 60) // 120 bytes
	tests := []struct {
		name, base string
		taken      []string
		want       string
	}{
		{name: "the folder's name", base: "product", want: "product"},
		{name: "taken, case-insensitively", base: "product", taken: []string{"Product"}, want: "product 2"},
		{name: "the next free number", base: "product", taken: []string{"product", "product 2", "PRODUCT 3"}, want: "product 4"},
		{name: "workspace is reserved", base: "workspace", want: "workspace 2"},
		{name: "Workspace is reserved in any case", base: "Workspace", taken: []string{"workspace 2"}, want: "Workspace 3"},
		{name: "control characters become spaces", base: "a\tb\n", want: "a b"},
		{name: "empty falls back", base: "  ", want: "Workspace 2"},
		{name: "too long is cut to fit the suffix", base: long, want: strings.Repeat("a", 98) + " 2"},
		{name: "cut on a rune boundary", base: accents, want: strings.Repeat("é", 49) + " 2"},
		{name: "exactly 100 bytes fits", base: strings.Repeat("b", 100), want: strings.Repeat("b", 100)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			taken := func(n string) bool {
				for _, x := range tt.taken {
					if strings.EqualFold(x, n) {
						return true
					}
				}
				return false
			}
			got := freeWorkspaceName(tt.base, taken)
			if got != tt.want {
				t.Fatalf("freeWorkspaceName(%q) = %q, want %q", tt.base, got, tt.want)
			}
			if len(got) > workspaceNameMax || !utf8.ValidString(got) {
				t.Fatalf("name %q is not a valid store name", got)
			}
		})
	}
}
