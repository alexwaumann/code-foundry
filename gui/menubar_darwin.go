package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// cfSetAccessory takes the app out of the Dock and the app switcher (accessory activation)
// or puts it back. On the main thread only.
static void cfSetAccessory(bool on) {
	[NSApp setActivationPolicy:on ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular];
}

// cfSetQuitWithLastWindow sets Wails's last-window rule, which Options.Mac applies once at
// launch. AppDelegate's header is private to Wails, so the setter goes by name. On the
// main thread only.
static void cfSetQuitWithLastWindow(bool on) {
	id delegate = [NSApp delegate];
	if ([delegate respondsToSelector:@selector(setShouldTerminateWhenLastWindowClosed:)]) {
		[delegate setValue:@(on) forKey:@"shouldTerminateWhenLastWindowClosed"];
	}
}
*/
import "C"

import (
	_ "embed"
	"log/slog"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// menuBarIcon is the menu bar item's template image: lucide's anvil, black on clear, at
// 48px. Wails sizes it to the bar's thickness (24pt, so this is @2x) and AppKit tints it
// for light and dark menu bars.
//
//go:embed build/menubaricon.png
var menuBarIcon []byte

// appMenuBarHost is menuBarHost over Wails and AppKit.
type appMenuBarHost struct {
	app    *application.App
	window *application.WebviewWindow
	log    *slog.Logger
	// open and redrawDock run for the item's Open and after the Dock tile comes back.
	open       func()
	redrawDock func()
	// tray exists from the first showItem on; only menuBar's calls touch it, one at a time.
	tray *application.SystemTray
	// hideOnExit: conceal is waiting for the window to leave fullscreen.
	hideOnExit atomic.Bool
}

// installMenuBar returns the app's menuBar, wired to the window's close and to the app's
// shutdown. The item itself appears with the first setAnywhere(true).
func installMenuBar(app *application.App, window *application.WebviewWindow, appService *AppService, log *slog.Logger) *menuBar {
	host := &appMenuBarHost{app: app, window: window, log: log, redrawDock: func() {
		// AppKit makes a new tile for an executable without a bundle (icon.go).
		app.SetIcon(appIcon)
		appService.badge.redraw()
	}}
	bar := &menuBar{host: host}
	host.open = bar.open
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if bar.windowClosing() {
			e.Cancel()
		}
	})
	window.OnWindowEvent(events.Mac.WindowDidExitFullScreen, func(*application.WindowEvent) {
		if host.hideOnExit.Swap(false) {
			host.hide()
		}
	})
	app.OnShutdown(func() {
		log.Info("quitting")
		bar.shuttingDown()
	})
	return bar
}

func (h *appMenuBarHost) showItem() {
	if h.tray != nil {
		h.tray.Show()
		return
	}
	menu := application.NewMenu()
	menu.Add("Open Code Foundry").OnClick(func(*application.Context) { h.open() })
	menu.Add("Quit Code Foundry").OnClick(func(*application.Context) { h.app.Quit() })
	h.tray = h.app.SystemTray.New()
	h.tray.SetTemplateIcon(menuBarIcon)
	h.tray.SetMenu(menu)
	h.log.Info("menu bar item shown")
}

func (h *appMenuBarHost) hideItem() {
	if h.tray != nil {
		h.tray.Hide()
	}
}

func (h *appMenuBarHost) conceal() {
	// Hiding a fullscreen window would leave its empty Space behind.
	if h.window.IsFullscreen() {
		h.hideOnExit.Store(true)
		h.window.UnFullscreen()
		return
	}
	h.hide()
}

// hide and reveal keep the last-window rule off for as long as no window shows, on both
// sides of it. AppKit checks the rule some time after the last window goes, not only when
// one closes: with the rule on before the window was back, Open quit the app after a File
// › Close Window. It also stops the About panel, closed with the main window hidden, from
// counting as the last window.
func (h *appMenuBarHost) hide() {
	application.InvokeSync(func() { C.cfSetQuitWithLastWindow(false) })
	h.window.Hide()
	application.InvokeSync(func() { C.cfSetAccessory(true) })
	h.log.Info("window hidden; running in the menu bar")
}

func (h *appMenuBarHost) reveal() {
	h.hideOnExit.Store(false)
	application.InvokeSync(func() { C.cfSetAccessory(false) })
	h.redrawDock()
	h.window.UnMinimise()
	h.window.Show()
	h.window.Focus()
	application.InvokeSync(func() { C.cfSetQuitWithLastWindow(true) })
}
