package main

import (
	_ "embed"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// appIcon is the app icon at 512px (build/appicon.png scaled down; see
// docs/brand/README.md). The GUI ships as a bare executable with no bundle to carry
// icons.icns, so the icon is set at runtime (NSApp.applicationIconImage), which gives
// the Dock, the app switcher and the About panel the real icon.
//
//go:embed build/dockicon.png
var appIcon []byte

// installDockIcon sets the icon again once the app has finished launching. Wails applies
// Options.Icon during startup, before NSApp runs; for a bare executable AppKit then
// replaces the Dock tile with the generic executable icon when launching finishes, so the
// early call is lost and the Dock shows "exec".
func installDockIcon(app *application.App) {
	app.Event.OnApplicationEvent(events.Mac.ApplicationDidFinishLaunching, func(*application.ApplicationEvent) {
		app.SetIcon(appIcon)
	})
}
