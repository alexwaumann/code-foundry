// Command gui is the Wails v3 window shell for code-foundry. It is deliberately thin:
// it opens a window, makes sure the daemon is running, and hands the frontend the
// daemon's loopback address and token. The frontend talks to the daemon directly over
// Connect-Web; no business logic lives here.
package main

import (
	"context"
	"embed"
	"log/slog"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/awaumann/code-foundry/internal/paths"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	p, err := paths.Resolve()
	if err != nil {
		log.Error("resolve config home", "err", err)
		os.Exit(1)
	}
	// Before anything spawns the daemon: give it the user's PATH (Finder launches get
	// launchd's minimal one) and point it and its sessions at the bundled CLI.
	adoptLoginShellPath(log)
	exportDaemonBinary(log)

	appService := NewAppService(log)
	app := application.New(application.Options{
		Name:        "Code Foundry",
		Description: "Supervise fleets of Claude Code sessions",
		Services: []application.Service{
			application.NewService(NewDaemonService(p, log)),
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

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Code Foundry",
		Width:            1200,
		Height:           780,
		BackgroundColour: application.NewRGB(10, 10, 10),
		URL:              "/",
	})

	// `app.relaunch` (e.g. after an update is installed) reaches the host directly.
	watchCtx, stopWatch := context.WithCancel(context.Background())
	defer stopWatch()
	go watchRelaunch(watchCtx, p, log, func() {
		if err := appService.Relaunch(); err != nil {
			log.Error("relaunch", "err", err)
		}
	})

	if err := app.Run(); err != nil {
		log.Error("wails app", "err", err)
		os.Exit(1)
	}
}
