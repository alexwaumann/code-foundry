package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/awaumann/code-foundry/internal/daemon"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/version"
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
	err = daemon.Run(ctx, daemon.Options{Paths: p, Version: version.Get(), Dev: *dev, Stderr: os.Stderr})
	if errors.Is(err, daemon.ErrAlreadyRunning) {
		return fmt.Errorf("%w (%s)", err, p.Home())
	}
	return err
}
