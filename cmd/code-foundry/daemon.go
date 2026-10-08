package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/alexwaumann/code-foundry/internal/daemon"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

func runDaemon(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("daemon")
	dev := fs.Bool("dev", false, "also log human-readable text at debug level to stderr")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	p, err := paths.Resolve()
	if err != nil {
		return err
	}
	// Sessions find the CLI through CODE_FOUNDRY_BIN even when it is not on PATH (a
	// Finder-launched app's daemon). The GUI host sets it before auto-starting us.
	if os.Getenv("CODE_FOUNDRY_BIN") == "" {
		if exe, err := os.Executable(); err == nil {
			_ = os.Setenv("CODE_FOUNDRY_BIN", exe)
		}
	}
	err = daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Get(), Dev: *dev, Stderr: os.Stderr})
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		return fmt.Errorf("%w (%s)", err, p.Home())
	}
	return err
}
