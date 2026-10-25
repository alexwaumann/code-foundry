package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

func runDaemon(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("daemon")
	dev := fs.Bool("dev", false, "also log human-readable text at debug level to stderr, and let the dev frontend in a browser call the API "+
		"from the loopback origins in $"+daemon.EnvDevOrigins+" (ports or origins, comma separated; default port "+daemon.DefaultDevOrigins+")")
	waitLock := fs.Duration(strings.TrimPrefix(client.FlagWaitLock, "--"), 0,
		"wait up to this long for a previous daemon that no longer answers to release its lock (auto-start)")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	p, err := paths.Resolve()
	if err != nil {
		return err
	}
	// Threads find the CLI through CODE_FOUNDRY_BIN even when it is not on PATH (a
	// Finder-launched app's daemon). The GUI host sets it before auto-starting us.
	if os.Getenv(paths.EnvBin) == "" {
		if exe, err := os.Executable(); err == nil {
			_ = os.Setenv(paths.EnvBin, exe)
		}
	}
	// Loopback origins only in dev mode: any other would also let another daemon's pages
	// call this API (docs/notes/bridge-fix-crosshome.md).
	var devOrigins []string
	list := os.Getenv(daemon.EnvDevOrigins)
	switch {
	case *dev:
		if list == "" {
			list = daemon.DefaultDevOrigins
		}
		if devOrigins, err = daemon.ParseDevOrigins(list); err != nil {
			return err
		}
	case list != "":
		_, _ = fmt.Fprintf(cl.stderr, "code-foundry: %s is ignored without --dev\n", daemon.EnvDevOrigins)
	}
	err = daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Get(), Dev: *dev, DevOrigins: devOrigins, Stderr: os.Stderr, LockWait: *waitLock})
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		// A distinct status: the client that started us names the lock's holder.
		_, _ = fmt.Fprintf(cl.stderr, "code-foundry: %v (%s)\n", err, p.Home())
		return exitCodeError(client.ExitLockHeld)
	}
	return err
}
