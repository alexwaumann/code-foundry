// Command gui is the Wails v3 window shell for code-foundry. It is deliberately thin:
// it opens a window, makes sure the daemon is running, and hands the frontend the
// daemon's loopback address and token. The frontend talks to the daemon directly over
// Connect-Web; no business logic lives here.
package main

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// `CodeFoundry --version` prints the build's version without opening a window
	// (scripts/package.sh checks it against the CLI's and VERSION).
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("CodeFoundry " + version.Version)
		return
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	p, err := paths.Resolve()
	if err != nil {
		log.Error("resolve config home", "err", err)
		os.Exit(1)
	}
	// Before anything spawns the daemon: give it the user's PATH (Finder launches get
	// launchd's minimal one) and point it and its sessions at the CLI installed next to this executable.
	adoptLoginShellPath(log)
	exportDaemonBinary(log)

	daemonService := NewDaemonService(p, log)
	appService := NewAppService(log)
	app := application.New(application.Options{
		Name:        "Code Foundry",
		Description: "Supervise fleets of Claude Code sessions",
		Icon:        appIcon,
		Services: []application.Service{
			application.NewService(daemonService),
			application.NewService(appService),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Menu.Set(appMenu(app))

	// Hidden-inset title bar: the traffic lights float over the web content (centred on
	// y=26 in the 52pt title band, TITLE_BAND_HEIGHT in
	// frontend/src/components/window/titleBand.ts). Nothing spans that band: the sidebar's
	// top band and the pane headers fill it, and they drag the window through the Wails
	// runtime (`--wails-draggable: drag`), so their buttons still click. The title stays
	// set for Mission Control and the app switcher even though the bar no longer shows it.
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Code Foundry",
		Width:  1200,
		Height: 780,
		// Room for the content pane (360px minimum) beside a full-width sidebar; the side
		// panel shrinks, then hides, when it does not fit (stores/ui.ts panelMax).
		MinWidth:  900,
		MinHeight: 500,
		// The dark sheet colour (--sheet in index.css, #000000), so launch does not
		// flash a different colour before the page paints.
		BackgroundColour: application.NewRGB(0, 0, 0),
		URL:              "/",
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInset,
			// No native drag band. A native band drags on any mouse-down in it, before the
			// page sees the click, so it would swallow the header buttons now in the band.
			InvisibleTitleBarHeight: 0,
		},
	})

	// `app.relaunch` (e.g. after an update is installed) reaches the host directly.
	watchCtx, stopWatch := context.WithCancel(context.Background())
	defer stopWatch()
	go watchRelaunch(watchCtx, daemonService.connect, log, func() {
		if err := appService.Relaunch(); err != nil {
			log.Error("relaunch", "err", err)
		}
	})

	if err := app.Run(); err != nil {
		log.Error("wails app", "err", err)
		os.Exit(1)
	}
}
