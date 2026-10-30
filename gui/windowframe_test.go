package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestPlaceWindow(t *testing.T) {
	// A 14" MacBook Pro below its notch menu bar, and a 27" monitor to its right.
	laptop := application.Rect{X: 0, Y: 37, Width: 1512, Height: 945}
	monitor := application.Rect{X: 1512, Y: 0, Width: 2560, Height: 1415}
	tests := []struct {
		name  string
		saved *WindowFrame
		areas []application.Rect
		want  WindowFrame
	}{
		{
			"first launch takes 90% of the primary work area, centred",
			nil, []application.Rect{laptop},
			WindowFrame{X: 76, Y: 84, Width: 1360, Height: 850},
		},
		{
			"first launch never goes below the minimum",
			nil, []application.Rect{{X: 0, Y: 25, Width: 960, Height: 520}},
			WindowFrame{X: 30, Y: 35, Width: 900, Height: 500},
		},
		{
			"a frame that still fits is kept",
			&WindowFrame{X: 100, Y: 100, Width: 1200, Height: 800}, []application.Rect{laptop},
			WindowFrame{X: 100, Y: 100, Width: 1200, Height: 800},
		},
		{
			"a frame from an unplugged monitor shrinks onto the laptop",
			&WindowFrame{X: 1600, Y: 50, Width: 2300, Height: 1300}, []application.Rect{laptop},
			WindowFrame{X: 0, Y: 37, Width: 1512, Height: 945},
		},
		{
			"a frame hanging off the edge slides back in",
			&WindowFrame{X: 1000, Y: -20, Width: 1200, Height: 800}, []application.Rect{laptop},
			WindowFrame{X: 312, Y: 37, Width: 1200, Height: 800},
		},
		{
			"a frame on the monitor stays there while it is attached",
			&WindowFrame{X: 1600, Y: 50, Width: 2300, Height: 1300}, []application.Rect{laptop, monitor},
			WindowFrame{X: 1600, Y: 50, Width: 2300, Height: 1300},
		},
		{
			"a frame straddling both screens fits the one it overlaps most",
			&WindowFrame{X: 1000, Y: 100, Width: 1400, Height: 800}, []application.Rect{laptop, monitor},
			WindowFrame{X: 1512, Y: 100, Width: 1400, Height: 800},
		},
		{
			"a frame below the minimum grows to it",
			&WindowFrame{X: 10, Y: 50, Width: 400, Height: 300}, []application.Rect{laptop},
			WindowFrame{X: 10, Y: 50, Width: 900, Height: 500},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := placeWindow(tt.saved, tt.areas); got != tt.want {
				t.Fatalf("placeWindow = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestWindowFrameFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "window-frame.json")
	if got := loadWindowFrame(path); got != nil {
		t.Fatalf("missing file loaded %+v", got)
	}
	want := WindowFrame{X: 76, Y: 84, Width: 1360, Height: 850}
	if err := saveWindowFrame(path, want); err != nil {
		t.Fatal(err)
	}
	if got := loadWindowFrame(path); got == nil || *got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
	for name, data := range map[string]string{
		"garbage":    "{",
		"zero size":  `{"x":1,"y":2,"width":0,"height":0}`,
		"negative":   `{"x":1,"y":2,"width":-5,"height":100}`,
		"wrong type": `{"width":"wide"}`,
	} {
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := loadWindowFrame(path); got != nil {
			t.Fatalf("%s loaded %+v", name, got)
		}
	}
}
