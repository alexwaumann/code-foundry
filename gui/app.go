package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/alexwaumann/code-foundry/internal/version"
)

// EventCheckForUpdates is emitted to the frontend by the "Check for Updates…" menu item.
const EventCheckForUpdates = "app:check-for-updates"

// AppInfo is what the frontend knows about the window shell itself.
type AppInfo struct {
	// Version is this GUI binary's version (same ldflag as the daemon's).
	Version string `json:"version"`
	// Bundle is the .app this GUI runs from, or "" for a dev binary.
	Bundle string `json:"bundle"`
}

// AppService is bound to the frontend: the GUI's own version and relaunching itself.
// Updates are installed by the daemon; the host only quits and reopens the window.
type AppService struct {
	log *slog.Logger
}

// NewAppService returns an AppService.
func NewAppService(log *slog.Logger) *AppService { return &AppService{log: log} }

// Info returns the GUI's version and bundle path.
func (s *AppService) Info() AppInfo {
	return AppInfo{Version: version.Version, Bundle: runningBundle()}
}

// Relaunch quits the app and opens it again once this process has exited, so the new
// process runs whatever bundle is on disk now (an installed update). Sessions are
// unaffected: they live in the daemon.
func (s *AppService) Relaunch() error {
	s.log.Info("relaunch requested")
	argv, err := relaunchCommand(os.Getpid(), runningBundle(), os.Getenv)
	if err != nil {
		return err
	}
	cmd := exec.Command("/bin/sh", "-c", argv)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("relaunch: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	s.log.Info("relaunching", "cmd", argv)
	application.Get().Quit()
	return nil
}

// relaunchCommand is a shell script that waits for pid to exit, then reopens bundle
// (through LaunchServices, forwarding CODE_FOUNDRY_* settings with `open --env`), or
// re-executes this binary when there is no bundle (dev).
func relaunchCommand(pid int, bundle string, getenv func(string) string) (string, error) {
	var b strings.Builder
	b.WriteString("while kill -0 " + strconv.Itoa(pid) + " 2>/dev/null; do sleep 0.1; done; ")
	if bundle != "" {
		b.WriteString("exec /usr/bin/open")
		for _, k := range []string{"CODE_FOUNDRY_HOME", version.EnvReleaseRepo, version.EnvReleaseDir, "CODE_FOUNDRY_UPDATE_DELAY"} {
			if v := getenv(k); v != "" {
				b.WriteString(" --env " + shellQuote(k+"="+v))
			}
		}
		b.WriteString(" " + shellQuote(bundle))
		return b.String(), nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("relaunch: %w", err)
	}
	b.WriteString("exec " + shellQuote(exe))
	return b.String(), nil
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// runningBundle is the .app containing this executable, or "".
func runningBundle() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	dir := filepath.Dir(exe)
	if filepath.Base(dir) != "MacOS" || filepath.Base(filepath.Dir(dir)) != "Contents" {
		return ""
	}
	if b := filepath.Dir(filepath.Dir(dir)); strings.HasSuffix(b, ".app") {
		return b
	}
	return ""
}

// appMenu is the default macOS menu with "Check for Updates…" in the app menu, which
// asks the frontend to open the update dialog and check. The View menu is custom: the
// default one binds Reload (cmd+r) and Force Reload (cmd+shift+r), which are
// session.rename and session.reconnect, and Zoom (cmd+0/=/-), which the GUI uses for
// terminal font size. A menu chord fires whenever the page leaves the key unhandled,
// so cmd+r with no session selected would reload the whole GUI. Keep the chords left
// here in command.ReservedChords.
//
// The File menu is custom too: the default role binds Close Window to cmd+w, and the
// side panel owns cmd+w (close the active tab). With the role, any cmd+w the page left
// unhandled closed the only window, which quits the app
// (ApplicationShouldTerminateAfterLastWindowClosed). Close Window stays in the menu,
// without a key equivalent; the red traffic light still closes the window.
func appMenu(app *application.App) *application.Menu {
	menu := application.NewMenu()
	m := menu.AddSubmenu("Code Foundry")
	m.AddRole(application.About)
	m.Add("Check for Updates…").OnClick(func(*application.Context) {
		app.Event.Emit(EventCheckForUpdates)
	})
	m.AddSeparator()
	m.AddRole(application.ServicesMenu)
	m.AddSeparator()
	m.AddRole(application.Hide)
	m.AddRole(application.HideOthers)
	m.AddRole(application.UnHide)
	m.AddSeparator()
	m.AddRole(application.Quit)
	file := menu.AddSubmenu("File")
	file.Add("Close Window").OnClick(func(*application.Context) {
		if w := app.Window.Current(); w != nil {
			w.Close()
		}
	})
	menu.AddRole(application.EditMenu)
	view := menu.AddSubmenu("View")
	view.AddRole(application.OpenDevTools) // nil, so skipped, in production builds
	view.AddRole(application.ToggleFullscreen)
	menu.AddRole(application.WindowMenu)
	return menu
}
