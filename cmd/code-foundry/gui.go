package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// runGUI is `code-foundry gui`: starts the GUI executable installed next to this CLI
// (<app dir>/Code Foundry), else, for a repo CLI (./bin/code-foundry), the dev build
// "gui/bin/Code Foundry" from `make gui-build`. The GUI is a bare executable, not an .app,
// so it is started directly: detached from this terminal, inheriting the environment
// (CODE_FOUNDRY_HOME and friends), and pointed at this CLI to auto-start the daemon.
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
	bin, err := guiBinary(exe, isExecutable)
	if err != nil {
		return err
	}
	// Stdio stays nil: /dev/null. Setsid: closing this terminal does not take it down.
	cmd := exec.Command(bin)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = append(os.Environ(), "CODE_FOUNDRY_BIN="+exe)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", bin, err)
	}
	fmt.Fprintf(cl.stdout, "started %s (pid %d)\n", bin, cmd.Process.Pid)
	_ = cmd.Process.Release()
	return nil
}

// isExecutable reports whether p is an executable regular file.
func isExecutable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0
}

// guiBinary picks the GUI executable for the CLI at exe (symlinks resolved).
func guiBinary(exe string, isExecutable func(string) bool) (string, error) {
	sibling := filepath.Join(filepath.Dir(exe), update.GUIName)
	if isExecutable(sibling) {
		return sibling, nil
	}
	// A repo CLI (./bin/code-foundry): the dev GUI built by `make gui-build`.
	if dev := filepath.Join(filepath.Dir(filepath.Dir(exe)), "gui", "bin", update.GUIName); isExecutable(dev) {
		return dev, nil
	}
	return "", fmt.Errorf("%s not found next to %s: install Code Foundry (install.sh) or run `make gui-build`", update.GUIName, exe)
}
