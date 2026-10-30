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
		{"claude-opus-5-5[1m]", "Opus 5.5"},
		{"claude-opus-4-8[1m]", "Opus 4.8"},
		{"claude-opus-4-7[1m]", "Opus 4.7"},
		{"claude-sonnet-5-5[1m]", "Sonnet 5.5"},
		{"claude-sonnet-5[1m]", "Sonnet 5"},
		{"claude-sonnet-4-6[1m]", "Sonnet 4.6"},
		{"claude-haiku-5-5[1m]", "Haiku 5.5"},
		{"claude-4.5-haiku[1m]", "Haiku 4.5"},
		// Retired aliases and unsuffixed ids are not listed.
		{"opus", "opus"},
		{"claude-opus-4-8", "claude-opus-4-8"},
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
	want := []string{
		"claude-opus-5-5[1m]", "claude-opus-4-8[1m]", "claude-opus-4-7[1m]",
		"claude-sonnet-5-5[1m]", "claude-sonnet-5[1m]", "claude-sonnet-4-6[1m]",
		"claude-haiku-5-5[1m]", "claude-4.5-haiku[1m]",
	}
	if got := Values(); !slices.Equal(got, want) {
		t.Fatalf("Values() = %v, want %v", got, want)
	}
	if len(Labels()) != len(Values()) || len(All()) != len(Values()) {
		t.Fatalf("Labels/All not parallel to Values")
	}
	for _, v := range []string{Default, NamingDefault} {
		if !Known(v) {
			t.Errorf("default %q is not in the registry", v)
		}
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

func TestContextWindow(t *testing.T) {
	tests := []struct {
		value string
		want  int64
	}{
		{"claude-opus-5-5[1m]", 1_000_000},
		{"claude-opus-4-8[1m]", 1_000_000},
		{"claude-opus-4-7[1m]", 1_000_000},
		{"claude-sonnet-5-5[1m]", 1_000_000},
		{"claude-sonnet-5[1m]", 1_000_000},
		{"claude-sonnet-4-6[1m]", 1_000_000},
		{"claude-haiku-5-5[1m]", 1_000_000},
		{"claude-4.5-haiku[1m]", 200_000},
		// Not listed: unknown.
		{"opus", 0},
		{"", 0},
	}
	for _, tt := range tests {
		if got := ContextWindow(tt.value); got != tt.want {
			t.Errorf("ContextWindow(%q) = %d, want %d", tt.value, got, tt.want)
		}
	}
	for _, m := range All() {
		if m.ContextWindow <= 0 {
			t.Errorf("%s has no context window", m.Value)
		}
	}
}
