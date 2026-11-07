package daemon

import (
	"context"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/browser"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// The experimental Chrome surface (docs/notes/chrome-surface.md): the store owns one headless
// system Chrome with a profile under <home>/browser, started on first use while
// experimental.chrome_surface is on (live: every settings change calls ConfigChanged).

// openBrowser opens the store and keeps it on the settings.
func openBrowser(log *slog.Logger, p paths.Paths, home string, st *settings.Store) *browser.Store {
	b := browser.New(browser.Options{
		Dir: filepath.Join(p.Home(), "browser"), Log: log,
		Enabled: func() bool { return st.Settings().Experimental.ChromeSurface },
		Launch:  browser.ExecLauncher(func() (string, error) { return browser.FindChrome(home) }, log),
		Reveal:  func(path string) error { return command.RevealInFinder(context.Background(), path) },
		SetClipboard: func(ctx context.Context, text string) error {
			cmd := exec.CommandContext(ctx, "/usr/bin/pbcopy")
			cmd.Stdin = strings.NewReader(text)
			return cmd.Run()
		},
	})
	st.OnChange(func(*settings.Snapshot) { b.ConfigChanged() })
	return b
}

// applyBrowserCommands keeps the surface's commands in the registry exactly while the setting is
// on. On a change the hook runs before the change is published, so a client that lists
// commands on the settings event sees them gone.
func applyBrowserCommands(st *settings.Store, reg *command.Registry, t command.ThreadGetter, e command.Emitter) error {
	cmds := command.BrowserCommands(t, e)
	st.OnChange(func(snap *settings.Snapshot) {
		// Validated below, at start.
		_ = reg.Toggle(snap.Settings.Experimental.ChromeSurface, cmds...)
	})
	return reg.Toggle(st.Settings().Experimental.ChromeSurface, cmds...)
}

// browserOrigins is who BrowserService answers: the pages that may call the API at all.
func browserOrigins(pagesPort int, devOrigins []string) func(string) bool {
	return func(origin string) bool { return allowedOrigin(origin, pagesPort, devOrigins) }
}
