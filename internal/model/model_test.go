package model

import (
	"slices"
	"strings"
	"testing"
)

func TestLabel(t *testing.T) {
	tests := []struct {
		value, want string
	}{
		{"fable", "Fable"},
		{"opus", "Opus"},
		{"claude-opus-4-8", "Opus 4.8"},
		{"claude-opus-4-7", "Opus 4.7"},
		{"sonnet", "Sonnet"},
		{"claude-sonnet-5", "Sonnet 5"},
		{"claude-sonnet-4-6", "Sonnet 4.6"},
		{"haiku", "Haiku"},
		{"claude-haiku-4-5", "Haiku 4.5"},
		{"claude-opus-5-5[1m]", "claude-opus-5-5[1m]"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			if got := Label(tt.value); got != tt.want {
				t.Errorf("Label(%q) = %q, want %q", tt.value, got, tt.want)
			}
			if got, want := Known(tt.value), tt.want != tt.value; got != want {
				t.Errorf("Known(%q) = %v, want %v", tt.value, got, want)
			}
		})
	}
}

func TestRegistry(t *testing.T) {
	want := []string{"fable", "opus", "claude-opus-4-8", "claude-opus-4-7", "sonnet", "claude-sonnet-5", "claude-sonnet-4-6", "haiku", "claude-haiku-4-5"}
	if got := Values(); !slices.Equal(got, want) {
		t.Fatalf("Values() = %v, want %v", got, want)
	}
	if len(Labels()) != len(Values()) || len(All()) != len(Values()) {
		t.Fatalf("Labels/All not parallel to Values")
	}
	if !Known(Default) {
		t.Errorf("Default %q is not in the registry", Default)
	}
	seen := map[string]bool{}
	for _, m := range All() {
		if seen[m.Value] {
			t.Errorf("duplicate value %q", m.Value)
		}
		seen[m.Value] = true
		if m.Label == "" || strings.TrimSpace(m.Value) != m.Value || strings.HasPrefix(m.Value, "-") {
			t.Errorf("bad entry %+v", m)
		}
	}
	// All returns a copy.
	a := All()
	a[0].Label = "x"
	if Label(a[0].Value) == "x" {
		t.Error("All() shares the registry's backing array")
	}
}
