package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
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
}

// AppService is bound to the frontend: the GUI's own version, relaunching itself, the
// native folder picker (pickdir.go), the Dock badge, bounce and alert sound (notify.go),
// and the window background (windowbg.go).
// Updates are installed by the daemon; the host only quits and reopens the window.
type AppService struct {
	log *slog.Logger
	// window is the main window, set by main after it is created (for SetZoom).
	window *application.WebviewWindow
	// badge holds the Dock badge until the app has finished launching (dockLaunched).
	badge *dockBadge
	// bgPath is where SetWindowBackground keeps the colours for the next launch.
	bgPath string
	// bgMu guards bgSaved, the state last written to bgPath.
	bgMu    sync.Mutex
	bgSaved WindowBackground
}

// NewAppService returns an AppService that keeps the window background in bgPath.
func NewAppService(log *slog.Logger, bgPath string) *AppService {
	return &AppService{log: log, badge: &dockBadge{apply: setDockBadgeLabel}, bgPath: bgPath, bgSaved: loadWindowBackground(bgPath)}
}

// SetWindowBackground paints the window behind the page in the active theme's sheet and
// saves both themes' sheets and the scheme, so the next launch opens in the right colour
// before the page loads. The frontend calls it on start and on every theme, scheme or
// macOS appearance change (lib/theme.ts).
func (s *AppService) SetWindowBackground(bg WindowBackground) error {
	if err := bg.validate(); err != nil {
		return fmt.Errorf("set window background: %w", err)
	}
	c, _ := parseHexColour(bg.colour(systemIsDark()))
	if s.window != nil {
		s.window.SetBackgroundColour(c)
	}
	s.bgMu.Lock()
	defer s.bgMu.Unlock()
	saved := bg
	saved.Active = ""
	if saved == s.bgSaved || s.bgPath == "" {
		return nil
	}
	if err := saveWindowBackground(s.bgPath, saved); err != nil {
		return err
	}
	s.bgSaved = saved
	return nil
}

// SetBadge shows count on the Dock icon: no badge for 0, "99+" above 99. The frontend
// calls it with the number of threads that need attention whenever that changes
// (stores/dockAlerts.ts). Before the app has finished launching the badge is held and
// applied then.
func (s *AppService) SetBadge(count int) {
	s.badge.set(badgeLabel(count))
}

// Bounce bounces the Dock icon once. macOS ignores it while Code Foundry is the active
// app. The frontend decides when (a thread started needing attention, outside the alert
// cooldown).
func (s *AppService) Bounce() {
	s.log.Info("dock bounce")
	bounceDock()
}

// PlaySound plays the alert sound at volume percent of the Mac's output volume (clamped
// to 0–100; 0 plays nothing). Returns at once; a sound still playing restarts. The
// frontend calls it for an alert with notifications.sound on (stores/dockAlerts.ts) and
// for notifications.test, the settings page's Play button (stores/intents.ts).
func (s *AppService) PlaySound(volume int) {
	v := clampVolume(volume)
	if v == 0 {
		return
	}
	s.log.Info("alert sound", "volume", v)
	playAlertSound(float64(v) / 100)
}

// dockLaunched applies a badge set before the app finished launching. Called from the
// ApplicationDidFinishLaunching handler (icon.go), after the icon is set.
func (s *AppService) dockLaunched() {
	s.badge.didLaunch()
}

// Info returns the GUI's version.
func (s *AppService) Info() AppInfo {
	return AppInfo{Version: version.Version}
}

// SetZoom tells the host the page zoom in percent (appearance.zoom; the frontend applies
// it as CSS zoom). The host keeps the native traffic lights centred on the zoomed title
// band (trafficlights_darwin.go). Called on start and after each change.
func (s *AppService) SetZoom(percent int) error {
	if percent < 10 || percent > 1000 {
		return fmt.Errorf("set zoom: %d%% out of range", percent)
	}
	if s.window == nil {
		return nil
	}
	positionWindowButtons(s.window.NativeWindow(), percent)
	return nil
}

// Relaunch quits the app and starts this executable again once this process has
// exited, so the new process runs whatever is on disk at this path now (an installed
// update swaps the app directory in place). It keeps the arguments and the environment
// (CODE_FOUNDRY_HOME, CODE_FOUNDRY_BIN, the adopted PATH, ...). Threads are unaffected:
// they live in the daemon.
func (s *AppService) Relaunch() error {
	s.log.Info("relaunch requested")
	// On darwin os.Executable is the path this process was started from, not wherever
	// its (since replaced) file has moved to.
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("relaunch: %w", err)
	}
	script := relaunchCommand(os.Getpid(), exe, os.Args[1:])
	// Detached, stdio on /dev/null: the shell outlives this process.
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("relaunch: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	s.log.Info("relaunching", "cmd", script)
	application.Get().Quit()
	return nil
}

// relaunchCommand is a shell script that waits for pid to exit, then executes exe with
// args (two windows never run at once).
func relaunchCommand(pid int, exe string, args []string) string {
	var b strings.Builder
	b.WriteString("while kill -0 " + strconv.Itoa(pid) + " 2>/dev/null; do sleep 0.1; done; exec " + shellQuote(exe))
	for _, a := range args {
		b.WriteString(" " + shellQuote(a))
	}
	return b.String()
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// appMenu is the default macOS menu with "Check for Updates…" in the app menu, which
// asks the frontend to open the update dialog and check. The View menu is custom: the
// default one binds Reload (cmd+r) and Force Reload (cmd+shift+r): cmd+r is
// thread.rename, a stray cmd+shift+r must not reload the GUI either, and Zoom (cmd+0/=/-), which the GUI uses for
// its own page zoom (appearance.zoom; CSS zoom on <html>, see gui/frontend/src/lib/zoom.ts). A menu chord fires whenever the page leaves the key unhandled,
// so cmd+r with no thread selected would reload the whole GUI. Keep the chords left
// here in command.ReservedChords.
//
// The File menu is custom too: the default role binds Close Window to cmd+w, and the
// side panel owns cmd+w (close the active tab). With the role, any cmd+w the page left
// unhandled closed the only window, which quits the app
// (ApplicationShouldTerminateAfterLastWindowClosed). Close Window stays in the menu,
// without a key equivalent; the red traffic light still closes the window.
//
// Settings…, the Thread menu and the Help menu run commands in the window
// (EventRunCommand; menu.go). For the same reason none of them has a key equivalent:
// their chords (cmd+, cmd+n, cmd+r, cmd+/, cmd+k, ...) belong to the page, where the
// user can rebind them, and a native one would also fire whenever the page left the key
// unhandled. Wails cannot show a chord without binding it, so the menus show none.
func appMenu(app *application.App) *application.Menu {
	run := runInWindow(app)
	menu := application.NewMenu()
	m := menu.AddSubmenu("Code Foundry")
	m.AddRole(application.About)
	m.Add("Check for Updates…").OnClick(func(*application.Context) {
		app.Event.Emit(EventCheckForUpdates)
	})
	m.AddSeparator()
	addCommandGroups(m, [][]menuCommand{{settingsItem}}, run)
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
	addCommandGroups(menu.AddSubmenu("Thread"), threadMenu, run)
	menu.AddRole(application.WindowMenu)
	help := menu.AddSubmenu("Help")
	addCommandGroups(help, helpMenu, run)
	help.AddSeparator()
	help.Add("Report an Issue…").OnClick(func(*application.Context) {
		if err := app.Browser.OpenURL(reportIssueURL); err != nil {
			app.Logger.Error("open issue page", "err", err)
		}
	})
	return menu
}
