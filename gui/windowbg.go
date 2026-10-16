package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The window background follows the active theme's sheet (--sheet, the page's own
// background), so the window never shows a colour the page does not paint: at launch,
// before the page has loaded, and while a resize outruns it. The daemon owns the theme
// settings, but the window opens before the daemon is reached, so the host keeps the last
// colours the frontend reported in a file of its own (paths.WindowBackground) and opens
// in them (docs/notes/theme-engine-3-settings.md).

// WindowBackground is what the frontend reports on every theme or scheme change
// (lib/theme.ts): the sheet of the dark and the light theme, the scheme setting, and the
// scheme in effect now.
type WindowBackground struct {
	// Scheme is appearance.theme: "system", "dark" or "light".
	Scheme string `json:"scheme"`
	// Dark and Light are the two themes' sheets, "#rrggbb".
	Dark  string `json:"dark"`
	Light string `json:"light"`
	// Active is the scheme the page shows now ("dark" or "light"); not persisted: at
	// launch it comes from Scheme and the macOS appearance.
	Active string `json:"active,omitempty"`
}

// defaultWindowBackground is Catppuccin Mocha's and Latte's sheets (the default themes;
// gui/frontend/src/themes/catalog.json, checked by TestDefaultWindowBackground).
var defaultWindowBackground = WindowBackground{Scheme: "system", Dark: "#131222", Light: "#e0e2e6"}

// validate checks every field; Active may be empty.
func (b WindowBackground) validate() error {
	switch {
	case b.Scheme != "system" && b.Scheme != "dark" && b.Scheme != "light":
		return fmt.Errorf("scheme %q is not system, dark or light", b.Scheme)
	case b.Active != "" && b.Active != "dark" && b.Active != "light":
		return fmt.Errorf("active scheme %q is not dark or light", b.Active)
	}
	for _, c := range []string{b.Dark, b.Light} {
		if _, err := parseHexColour(c); err != nil {
			return err
		}
	}
	return nil
}

// colour is the sheet for the scheme in effect: Active when set, else Scheme, with
// "system" resolved by systemDark.
func (b WindowBackground) colour(systemDark bool) string {
	scheme := b.Active
	if scheme == "" {
		scheme = b.Scheme
	}
	if scheme == "system" || scheme == "" {
		if systemDark {
			return b.Dark
		}
		return b.Light
	}
	if scheme == "light" {
		return b.Light
	}
	return b.Dark
}

// parseHexColour reads "#rrggbb" into an opaque colour.
func parseHexColour(s string) (application.RGBA, error) {
	if len(s) != 7 || s[0] != '#' {
		return application.RGBA{}, fmt.Errorf("colour %q is not #rrggbb", s)
	}
	n, err := strconv.ParseUint(s[1:], 16, 32)
	if err != nil {
		return application.RGBA{}, fmt.Errorf("colour %q is not #rrggbb", s)
	}
	return application.NewRGB(uint8(n>>16), uint8(n>>8), uint8(n)), nil
}

// loadWindowBackground reads the saved state; a missing, unreadable or invalid file is
// the default (Mocha/Latte), which is what a first launch shows anyway.
func loadWindowBackground(path string) WindowBackground {
	data, err := os.ReadFile(path)
	if err != nil {
		return defaultWindowBackground
	}
	var b WindowBackground
	if json.Unmarshal(data, &b) != nil {
		return defaultWindowBackground
	}
	b.Active = ""
	if b.validate() != nil {
		return defaultWindowBackground
	}
	return b
}

// saveWindowBackground writes b (without Active) through a temp file and a rename.
func saveWindowBackground(path string, b WindowBackground) error {
	b.Active = ""
	data, err := json.Marshal(b)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("save window background: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("save window background: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	_, werr := tmp.Write(append(data, '\n'))
	if err := errors.Join(werr, tmp.Close()); err != nil {
		return fmt.Errorf("save window background: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("save window background: %w", err)
	}
	return nil
}

// launchBackgroundColour is the window colour to open with: the saved state's sheet for
// the scheme in effect.
func launchBackgroundColour(path string, systemDark bool) application.RGBA {
	c, err := parseHexColour(loadWindowBackground(path).colour(systemDark))
	if err != nil {
		c, _ = parseHexColour(defaultWindowBackground.Dark)
	}
	return c
}
