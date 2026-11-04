package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

typedef struct {
	double x, y, width, height;
} cfOverlayRect;

typedef struct {
	cfOverlayRect frame, visible;
	double safeTop;
} cfOverlayScreen;

static cfOverlayRect cfOverlayRectOf(NSRect r) {
	return (cfOverlayRect){r.origin.x, r.origin.y, r.size.width, r.size.height};
}

// Writes up to max screens, the primary first, and the pointer; returns how many.
// Main thread only.
static int cfOverlayMetrics(cfOverlayScreen* out, int max, double* pointerX, double* pointerY) {
	NSPoint p = [NSEvent mouseLocation];
	*pointerX = p.x;
	*pointerY = p.y;
	int n = 0;
	for (NSScreen* s in [NSScreen screens]) {
		if (n == max) break;
		out[n].frame = cfOverlayRectOf(s.frame);
		out[n].visible = cfOverlayRectOf(s.visibleFrame);
		out[n].safeTop = s.safeAreaInsets.top;
		n++;
	}
	return n;
}

// What Wails has no option for. A panel hides when its app deactivates by default, and
// this app is rarely the active one here. canHide: it still shows while the app is hidden
// (⌘H). Out of the Window menu and the Dock's window list, and no fade from AppKit: the
// page does its own. Main thread only.
static void cfOverlayConfigure(void* nsWindow) {
	NSPanel* w = (__bridge NSPanel*)nsWindow;
	w.hidesOnDeactivate = NO;
	w.canHide = NO;
	w.excludedFromWindowsMenu = YES;
	w.animationBehavior = NSWindowAnimationBehaviorNone;
}

// Main thread only.
static void cfOverlayPlace(void* nsWindow, double x, double y, double width, double height) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	[w setFrame:NSMakeRect(x, y, width, height) display:NO];
}
*/
import "C"

import (
	"log/slog"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// overlayMaxScreens bounds the screens read; past it the pointer's screen may be missed
// and the plate lands on the primary.
const overlayMaxScreens = 16

// overlayPage is the panel's page: a Vite input of its own (vite.config.ts).
const overlayPage = "/dictation-overlay.html"

// overlayBehavior: on every Space and over full-screen apps; out of Mission Control
// (Transient) and of ⌘` (IgnoresCycle).
const overlayBehavior = application.MacWindowCollectionBehaviorCanJoinAllSpaces |
	application.MacWindowCollectionBehaviorFullScreenAuxiliary |
	application.MacWindowCollectionBehaviorTransient |
	application.MacWindowCollectionBehaviorIgnoresCycle

// overlayWindow is the overlay's panel. It is created on first use and then kept, hidden,
// for the app's life.
type overlayWindow struct {
	app    *application.App
	log    *slog.Logger
	window *application.WebviewWindow

	mu sync.Mutex
	// loaded: the page has loaded and the webview's background is cleared. Until then the
	// panel would show as an opaque rectangle.
	loaded bool
	// waiting: a show arrived before that; the load finishes it.
	waiting bool
}

func newOverlayWindow(app *application.App, log *slog.Logger) *overlayWindow {
	return &overlayWindow{app: app, log: log}
}

// prepare creates the panel, hidden, once. Showing it needs nothing else; the setting
// that turns dictating anywhere on can call this ahead of the first session, so its page
// has loaded by then.
func (o *overlayWindow) prepare() {
	if o.window != nil {
		return
	}
	o.window = o.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                       "dictation-overlay",
		Title:                      "Code Foundry Dictation",
		Width:                      overlayWindowWidth,
		Height:                     overlayWindowHeight,
		URL:                        overlayPage,
		Hidden:                     true,
		Frameless:                  true,
		DisableResize:              true,
		IgnoreMouseEvents:          true,
		BackgroundType:             application.BackgroundTypeTransparent,
		DefaultContextMenuDisabled: true,
		Mac: application.MacWindow{
			// Square: a true borderless window. AppKit keeps a titled one out of the menu
			// bar, and this one's transparent margin reaches into it.
			CornerType:         application.MacWindowCornerTypeSquare,
			Backdrop:           application.MacBackdropTransparent,
			DisableShadow:      true,
			WindowClass:        application.MacWindowClassPanel,
			PanelPreferences:   application.MacPanelPreferences{NonActivating: true, FloatingPanel: true},
			WindowLevel:        application.MacWindowLevelStatus,
			CollectionBehavior: overlayBehavior,
		},
	})
	// The window is created on the main thread, queued ahead of this.
	application.InvokeSync(func() { C.cfOverlayConfigure(o.window.NativeWindow()) })
	// As for the main window: the webview paints its own empty-page colour until told not
	// to, Wails' transparent backdrop or not.
	o.window.OnWindowEvent(events.Mac.WebViewDidFinishNavigation, func(*application.WindowEvent) {
		application.InvokeSync(func() { clearWebViewBackground(o.window.NativeWindow()) })
		o.mu.Lock()
		defer o.mu.Unlock()
		o.loaded = true
		if o.waiting {
			o.waiting = false
			o.orderIn()
		}
	})
}

// show orders the panel in and hands the page the session. A page still loading asks for
// the session itself (OverlayService.PageReady).
func (o *overlayWindow) show(sessionID string) {
	o.prepare()
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.loaded {
		o.waiting = true
		return
	}
	o.orderIn()
	o.window.EmitEvent(EventOverlayBegin, sessionID)
}

// orderIn places the panel on the pointer's screen and orders it in without taking focus
// (Wails uses orderFrontRegardless for a non-activating panel).
func (o *overlayWindow) orderIn() {
	application.InvokeSync(func() {
		var screens [overlayMaxScreens]C.cfOverlayScreen
		var px, py C.double
		n := int(C.cfOverlayMetrics(&screens[0], overlayMaxScreens, &px, &py))
		if n == 0 {
			return
		}
		list := make([]overlayScreen, n)
		for i := range list {
			list[i] = overlayScreen{Frame: goOverlayRect(screens[i].frame), Visible: goOverlayRect(screens[i].visible), SafeTop: float64(screens[i].safeTop)}
		}
		f := overlayFrame(overlayScreenAt(list, float64(px), float64(py)))
		C.cfOverlayPlace(o.window.NativeWindow(), C.double(f.X), C.double(f.Y), C.double(f.Width), C.double(f.Height))
	})
	o.window.Show()
}

func (o *overlayWindow) hide() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.waiting = false
	if o.window != nil {
		o.window.Hide()
	}
}

func goOverlayRect(r C.cfOverlayRect) overlayRect {
	return overlayRect{X: float64(r.x), Y: float64(r.y), Width: float64(r.width), Height: float64(r.height)}
}
