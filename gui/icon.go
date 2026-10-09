package main

import _ "embed"

// appIcon is the app icon at 512px (build/appicon.png scaled down; see
// docs/brand/README.md). The GUI ships as a bare executable with no bundle to carry
// icons.icns, so Wails sets it at startup (Options.Icon: NSApp.applicationIconImage on
// darwin), which gives the Dock, the app switcher and the About panel the real icon.
//
//go:embed build/dockicon.png
var appIcon []byte
