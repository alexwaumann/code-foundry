package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestWindowBackgroundColour(t *testing.T) {
	b := WindowBackground{Scheme: "system", Dark: "#1c1e29", Light: "#ebe5de"}
	tests := []struct {
		name       string
		scheme     string
		active     string
		systemDark bool
		want       string
	}{
		{"system, macOS dark", "system", "", true, "#1c1e29"},
		{"system, macOS light", "system", "", false, "#ebe5de"},
		{"forced dark in light macOS", "dark", "", false, "#1c1e29"},
		{"forced light in dark macOS", "light", "", true, "#ebe5de"},
		{"the page's active scheme wins", "system", "light", true, "#ebe5de"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := b
			b.Scheme, b.Active = tt.scheme, tt.active
			if got := b.colour(tt.systemDark); got != tt.want {
				t.Fatalf("colour = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestWindowBackgroundValidate(t *testing.T) {
	ok := WindowBackground{Scheme: "dark", Dark: "#000000", Light: "#ffffff"}
	tests := []struct {
		name string
		edit func(*WindowBackground)
		bad  bool
	}{
		{"valid", func(*WindowBackground) {}, false},
		{"valid with active", func(b *WindowBackground) { b.Active = "light" }, false},
		{"unknown scheme", func(b *WindowBackground) { b.Scheme = "sepia" }, true},
		{"unknown active", func(b *WindowBackground) { b.Active = "system" }, true},
		{"short hex", func(b *WindowBackground) { b.Dark = "#fff" }, true},
		{"no hash", func(b *WindowBackground) { b.Light = "ffffff" }, true},
		{"not hex", func(b *WindowBackground) { b.Light = "#gggggg" }, true},
		{"css colour", func(b *WindowBackground) { b.Dark = "oklch(0 0 0)" }, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := ok
			tt.edit(&b)
			if err := b.validate(); (err != nil) != tt.bad {
				t.Fatalf("validate = %v, want error %v", err, tt.bad)
			}
		})
	}
}

func TestParseHexColour(t *testing.T) {
	got, err := parseHexColour("#1e1e2e")
	if err != nil || got != application.NewRGB(0x1e, 0x1e, 0x2e) {
		t.Fatalf("parse = %+v, %v", got, err)
	}
}

func TestWindowBackgroundFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "window-background.json")
	// Nothing saved yet: the default themes' sheets.
	if got := loadWindowBackground(path); got != defaultWindowBackground {
		t.Fatalf("missing file = %+v", got)
	}
	if got := launchBackgroundColour(path, true); got != application.NewRGB(0x04, 0x07, 0x0c) {
		t.Errorf("first launch, dark = %+v", got)
	}
	if got := launchBackgroundColour(path, false); got != application.NewRGB(0xf0, 0xf0, 0xf0) {
		t.Errorf("first launch, light = %+v", got)
	}
	saved := WindowBackground{Scheme: "light", Dark: "#1c1e29", Light: "#ebe5de", Active: "light"}
	if err := saveWindowBackground(path, saved); err != nil {
		t.Fatal(err)
	}
	saved.Active = ""
	if got := loadWindowBackground(path); got != saved {
		t.Errorf("round trip = %+v, want %+v", got, saved)
	}
	// Forced light opens light even in dark macOS.
	if got := launchBackgroundColour(path, true); got != application.NewRGB(0xeb, 0xe5, 0xde) {
		t.Errorf("launch = %+v", got)
	}
	for _, junk := range []string{"not json", `{"scheme":"sepia","dark":"#000000","light":"#ffffff"}`, `{"scheme":"dark","dark":"black","light":"#ffffff"}`} {
		if err := os.WriteFile(path, []byte(junk), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := loadWindowBackground(path); got != defaultWindowBackground {
			t.Errorf("%s: loaded %+v, want the default", junk, got)
		}
	}
}

// The default is the default themes' sheets, as the converter generated them.
func TestDefaultWindowBackground(t *testing.T) {
	data, err := os.ReadFile("frontend/src/themes/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	var catalog []struct {
		ID   string            `json:"id"`
		Vars map[string]string `json:"vars"`
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	sheet := map[string]string{}
	for _, th := range catalog {
		sheet[th.ID] = th.Vars["--sheet"]
	}
	if d := defaultWindowBackground; d.Dark != sheet["github-dark"] || d.Light != sheet["github-light"] || d.Scheme != "system" {
		t.Errorf("default = %+v, want GitHub Dark %s / Light %s", d, sheet["github-dark"], sheet["github-light"])
	}
}
