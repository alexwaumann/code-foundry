package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// The window zoom is the webview's page zoom (AppService.SetZoom), set from
// appearance.zoom by the page once it has loaded and reached the daemon. The window
// opens before that, so the host keeps the last percent in a file of its own
// (paths.WindowZoom) and applies it before the window shows: no launch at 100% followed
// by a jump (docs/notes/native-zoom.md).

const (
	// The percent SetZoom accepts: wider than the frontend's ladder (90 to 200,
	// stores/ui.ts), which is the one that decides what a user can pick.
	windowZoomMin     = 25
	windowZoomMax     = 500
	windowZoomDefault = 100
)

// windowZoom is the file's content.
type windowZoom struct {
	Percent int `json:"percent"`
}

// loadWindowZoom reads the saved percent; a missing, unreadable or out-of-range file is
// 100%.
func loadWindowZoom(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return windowZoomDefault
	}
	var z windowZoom
	if json.Unmarshal(data, &z) != nil || z.Percent < windowZoomMin || z.Percent > windowZoomMax {
		return windowZoomDefault
	}
	return z.Percent
}

// saveWindowZoom writes percent through a temp file and a rename.
func saveWindowZoom(path string, percent int) error {
	data, err := json.Marshal(windowZoom{Percent: percent})
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, data); err != nil {
		return fmt.Errorf("save window zoom: %w", err)
	}
	return nil
}
