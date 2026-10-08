package main

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// launchdPath is the PATH launchd gives apps opened from Finder, the Dock or `open`.
const launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin"

// pathMarker brackets PATH in the login shell's output, which may also carry noise from
// shell startup files.
const pathMarker = "__CODE_FOUNDRY_PATH__"

// adoptLoginShellPath replaces launchd's minimal PATH with the user's login-shell PATH
// when the app was opened from Finder. The daemon this app auto-starts inherits it, and
// the daemon spawns `claude`, `git` and `gh` by name. A terminal-launched app already
// has the user's PATH and is left alone.
func adoptLoginShellPath(log *slog.Logger) {
	if os.Getenv("PATH") != launchdPath {
		return
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// -i -l: .zprofile (Homebrew's shellenv) and .zshrc (~/.local/bin from install.sh).
	cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '`+pathMarker+`%s`+pathMarker+`' "$PATH"`)
	cmd.Stdin = nil
	cmd.Dir = os.Getenv("HOME")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		log.Warn("read login shell PATH", "shell", shell, "err", err)
	}
	p := parseMarkedPath(out.String())
	if p == "" {
		p = fallbackPath()
	}
	_ = os.Setenv("PATH", p)
	log.Info("using login shell PATH", "path", p)
}

// parseMarkedPath extracts the PATH printed between pathMarkers.
func parseMarkedPath(s string) string {
	_, rest, ok := strings.Cut(s, pathMarker)
	if !ok {
		return ""
	}
	p, _, ok := strings.Cut(rest, pathMarker)
	if !ok {
		return ""
	}
	return strings.TrimSpace(p)
}

// fallbackPath is launchd's PATH plus the usual user tool locations.
func fallbackPath() string {
	home, _ := os.UserHomeDir()
	return strings.Join([]string{
		filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", launchdPath,
	}, ":")
}
