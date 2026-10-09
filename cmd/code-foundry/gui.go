package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// guiEnv are variables forwarded to the app. `open` launches through LaunchServices,
// which does not pass the caller's environment, so they go through `open --env`.
var guiEnv = []string{paths.EnvHome, "CODE_FOUNDRY_RELEASE_REPO", "CODE_FOUNDRY_RELEASE_DIR", update.EnvInitialDelay}

// runGUI is `code-foundry gui`: opens the app this CLI belongs to (the bundle it lives
// in), else the dev bundle next to it (gui/bin/CodeFoundry.app from `make gui-build`,
// then the bare gui/bin/CodeFoundry from `wails3 build`), else the
// installed app.
func runGUI(_ context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("gui")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate code-foundry: %w", err)
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	home, _ := os.UserHomeDir()
	argv, err := guiCommand(exe, home, os.Getenv, exists)
	if err != nil {
		return err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	if argv[0] != "/usr/bin/open" {
		// A dev binary without a bundle: detach it from this terminal.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		cmd.Env = append(os.Environ(), "CODE_FOUNDRY_BIN="+exe)
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start %s: %w", argv[0], err)
		}
		fmt.Fprintf(cl.stdout, "started %s\n", argv[0])
		return nil
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("open %s: %w: %s", argv[len(argv)-1], err, strings.TrimSpace(string(out)))
	}
	fmt.Fprintf(cl.stdout, "opened %s\n", argv[len(argv)-1])
	return nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// guiCommand picks what to launch for the CLI at exe and returns its argv.
func guiCommand(exe, home string, getenv func(string) string, exists func(string) bool) ([]string, error) {
	open := func(app string, extra ...string) []string {
		argv := []string{"/usr/bin/open"}
		for _, k := range guiEnv {
			if v := getenv(k); v != "" {
				argv = append(argv, "--env", k+"="+v)
			}
		}
		for _, kv := range extra {
			argv = append(argv, "--env", kv)
		}
		return append(argv, app)
	}
	if b := update.BundleOf(exe); b != "" {
		return open(b), nil
	}
	// A dev CLI (./bin/code-foundry): the dev GUI built by `make gui-build` / `wails3
	// package`, told to auto-start this CLI's daemon.
	repo := filepath.Dir(filepath.Dir(exe))
	if app := filepath.Join(repo, "gui", "bin", update.BundleName); exists(app) {
		return open(app, "CODE_FOUNDRY_BIN="+exe), nil
	}
	if bin := filepath.Join(repo, "gui", "bin", "CodeFoundry"); exists(bin) {
		return []string{bin}, nil
	}
	for _, app := range []string{filepath.Join(home, "Applications", update.BundleName), filepath.Join("/Applications", update.BundleName)} {
		if exists(app) {
			return open(app), nil
		}
	}
	return nil, errors.New("CodeFoundry.app not found: install it (scripts/install.sh) or run `make gui-build`")
}
