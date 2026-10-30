package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The window reopens where the user left it. The host saves the window's frame (position
// and size, in points, top-left origin, the space Wails reports positions in) to a file
// of its own (paths.WindowFrame) whenever it moves or resizes, and the next launch fits
// that frame to the screens attached then: the window keeps its size where it still fits
// and shrinks or slides onto the screen where it does not, so a frame saved on an external
// monitor opens on the laptop's own screen. Fullscreen is never saved; it is a mode, not
// a frame. A first launch takes firstLaunchShare of the primary screen's work area (the
// screen minus the menu bar and the Dock), centred (docs/notes/window-frame.md).

const (
	// windowMinWidth leaves room for the content pane (360px minimum) beside a full-width
	// sidebar; the side panel shrinks, then hides, when it does not fit (stores/ui.ts
	// panelMax).
	windowMinWidth  = 900
	windowMinHeight = 500
	// firstLaunchShare is the share of the primary work area a first launch takes: nearly
	// the whole screen on a 14" MacBook Pro, with room to spare on larger displays.
	firstLaunchShare = 0.9
	// frameSaveDelay coalesces the burst of move and resize events a drag produces.
	frameSaveDelay = 500 * time.Millisecond
)

// WindowFrame is the window's position and size in points, top-left origin.
type WindowFrame struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// loadWindowFrame reads the saved frame; a missing, unreadable, invalid or degenerate
// file means no saved frame, which a first launch has anyway.
func loadWindowFrame(path string) *WindowFrame {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var f WindowFrame
	if json.Unmarshal(data, &f) != nil || f.Width <= 0 || f.Height <= 0 {
		return nil
	}
	return &f
}

// saveWindowFrame writes f through a temp file and a rename.
func saveWindowFrame(path string, f WindowFrame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(path, data); err != nil {
		return fmt.Errorf("save window frame: %w", err)
	}
	return nil
}

// placeWindow is where the window opens given the saved frame (nil on a first launch)
// and the work areas of the attached screens, the primary first. areas must not be empty.
//
// A first launch takes firstLaunchShare of the primary work area, centred. A saved frame
// is fitted to the screen it overlaps most (the primary when it overlaps none): its size
// is clamped to that work area, never below the window minimum, and its position is
// shifted the least distance that keeps the whole window inside the area.
func placeWindow(saved *WindowFrame, areas []application.Rect) WindowFrame {
	area := areas[0]
	if saved == nil {
		w := fit(int(float64(area.Width)*firstLaunchShare), windowMinWidth, area.Width)
		h := fit(int(float64(area.Height)*firstLaunchShare), windowMinHeight, area.Height)
		return WindowFrame{X: area.X + (area.Width-w)/2, Y: area.Y + (area.Height-h)/2, Width: w, Height: h}
	}
	best := 0
	for _, a := range areas {
		if o := overlap(*saved, a); o > best {
			best, area = o, a
		}
	}
	w := fit(saved.Width, windowMinWidth, area.Width)
	h := fit(saved.Height, windowMinHeight, area.Height)
	return WindowFrame{
		X:      fit(saved.X, area.X, area.X+area.Width-w),
		Y:      fit(saved.Y, area.Y, area.Y+area.Height-h),
		Width:  w,
		Height: h,
	}
}

// fit clamps v to [lo, hi]; lo wins when the range is empty (a screen narrower than the
// window minimum).
func fit(v, lo, hi int) int {
	if v > hi {
		v = hi
	}
	if v < lo {
		v = lo
	}
	return v
}

// overlap is the area of f within r, in square points.
func overlap(f WindowFrame, r application.Rect) int {
	w := min(f.X+f.Width, r.X+r.Width) - max(f.X, r.X)
	h := min(f.Y+f.Height, r.Y+r.Height) - max(f.Y, r.Y)
	if w <= 0 || h <= 0 {
		return 0
	}
	return w * h
}

// workAreas is the attached screens' work areas, the primary first. Empty until Wails
// has cached the screens, which it does once the app has launched.
func workAreas(app *application.App) []application.Rect {
	screens := app.Screen.GetAll()
	areas := make([]application.Rect, 0, len(screens))
	if p := app.Screen.GetPrimary(); p != nil {
		areas = append(areas, p.WorkArea)
	}
	for _, s := range screens {
		if !s.IsPrimary {
			areas = append(areas, s.WorkArea)
		}
	}
	return areas
}

// currentFrame is the window's frame now.
func currentFrame(window *application.WebviewWindow) WindowFrame {
	x, y := window.Position()
	w, h := window.Size()
	return WindowFrame{X: x, Y: y, Width: w, Height: h}
}

// applyWindowFrame opens the window at the saved frame fitted to the attached screens
// (placeWindow). Called before the window is shown, once Wails has the screens; with no
// screen information the window keeps its default size, centred.
func applyWindowFrame(window *application.WebviewWindow, app *application.App, path string, log *slog.Logger) {
	areas := workAreas(app)
	if len(areas) == 0 {
		log.Warn("window frame: no screens; keeping the default size")
		return
	}
	saved := loadWindowFrame(path)
	f := placeWindow(saved, areas)
	window.SetSize(f.Width, f.Height)
	window.SetPosition(f.X, f.Y)
	// The file reflects what shows: a first launch's frame, or a saved one after fitting.
	if saved == nil || *saved != f {
		if err := saveWindowFrame(path, f); err != nil {
			log.Warn("window frame", "err", err)
		}
	}
}

// watchWindowFrame saves the frame after every move or resize (coalesced over
// frameSaveDelay), never while fullscreen or minimised, and refits the window when the
// screens change, so a window left on a monitor that was unplugged shrinks onto the
// laptop's screen instead of hanging off its edge.
func watchWindowFrame(window *application.WebviewWindow, app *application.App, path string, log *slog.Logger) {
	var mu sync.Mutex
	var timer *time.Timer
	var last *WindowFrame
	save := func() {
		if window.IsFullscreen() || window.IsMinimised() {
			return
		}
		f := currentFrame(window)
		mu.Lock()
		changed := last == nil || *last != f
		last = &f
		mu.Unlock()
		if !changed {
			return
		}
		if err := saveWindowFrame(path, f); err != nil {
			log.Warn("window frame", "err", err)
		}
	}
	schedule := func(*application.WindowEvent) {
		mu.Lock()
		defer mu.Unlock()
		if timer != nil {
			timer.Stop()
		}
		timer = time.AfterFunc(frameSaveDelay, save)
	}
	window.OnWindowEvent(events.Common.WindowDidMove, schedule)
	window.OnWindowEvent(events.Common.WindowDidResize, schedule)

	// Wails refreshes its screen cache on the same event; the delay lets that land first.
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidChangeScreenParameters, func(*application.ApplicationEvent) {
		time.AfterFunc(frameSaveDelay, func() {
			if window.IsFullscreen() || window.IsMinimised() {
				return
			}
			areas := workAreas(app)
			if len(areas) == 0 {
				return
			}
			cur := currentFrame(window)
			if f := placeWindow(&cur, areas); f != cur {
				window.SetSize(f.Width, f.Height)
				window.SetPosition(f.X, f.Y)
			}
		})
	})
}
