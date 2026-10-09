package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// An install is a directory, by default <config home>/app (paths.Paths.App), holding:
const (
	// CLIName is the daemon + CLI executable.
	CLIName = "code-foundry"
	// GUIName is the Wails GUI executable. Launch Services names a bare executable after
	// its file, so this is what the Dock and the app menu show.
	GUIName = "Code Foundry"
	// VersionFile holds the installed release tag (e.g. "v0.2.0\n"). Its presence is
	// what makes a directory an install.
	VersionFile = "VERSION"
)

// EnvAppDir overrides the default install directory (the installer reads it too).
const EnvAppDir = "CODE_FOUNDRY_APP_DIR"

// DefaultAppDir is where the installer puts a fresh install: $CODE_FOUNDRY_APP_DIR, else
// <config home>/app. "" when neither can be resolved.
func DefaultAppDir() string {
	if d := os.Getenv(EnvAppDir); d != "" {
		return d
	}
	p, err := paths.Resolve()
	if err != nil {
		return ""
	}
	return p.App()
}

// RunningDir returns the directory of the running executable, symlinks resolved
// (~/.local/bin/code-foundry links into the install), or "" when it cannot be found.
// On darwin os.Executable reports the path the process was started from, so this stays
// the install dir even after an update has swapped the directory underneath it.
func RunningDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return filepath.Dir(exe)
}

// IsInstall reports whether dir is an install (has a VERSION file).
func IsInstall(dir string) bool {
	if dir == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(dir, VersionFile))
	return err == nil && fi.Mode().IsRegular()
}

// RunningInstall returns the install the running executable belongs to, or "" when it
// does not run from one (a dev build in ./bin).
func RunningInstall() string {
	if d := RunningDir(); IsInstall(d) {
		return d
	}
	return ""
}

// InstalledVersion reads the version an install was installed as: the first line of
// its VERSION file.
func InstalledVersion(dir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, VersionFile))
	if err != nil {
		return "", fmt.Errorf("read installed version: %w", err)
	}
	line, _, _ := strings.Cut(string(b), "\n")
	v := strings.TrimSpace(line)
	if v == "" {
		return "", fmt.Errorf("read installed version: %s is empty", filepath.Join(dir, VersionFile))
	}
	return v, nil
}

// installedVersionIn returns an Options.InstalledVersion that re-reads dir's VERSION
// ("" when dir is not an install).
func installedVersionIn(dir string) func() (string, error) {
	return func() (string, error) {
		if !IsInstall(dir) {
			return "", nil
		}
		return InstalledVersion(dir)
	}
}
