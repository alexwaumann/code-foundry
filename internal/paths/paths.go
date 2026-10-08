// Package paths resolves the on-disk locations code-foundry uses: the config home,
// the daemon's socket, token, port and lock files, the SQLite database, and logs.
//
// The home directory is, in order of precedence:
//
//  1. $CODE_FOUNDRY_HOME, if set (used by tests and for side-by-side installs).
//  2. ~/Library/Application Support/code-foundry (the macOS-native location).
//
// XDG_CONFIG_HOME is deliberately not consulted: code-foundry is macOS-only and the
// Application Support directory is where macOS apps keep this kind of state.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EnvHome overrides the config home directory.
const EnvHome = "CODE_FOUNDRY_HOME"

// MaxSocketPath is the longest Unix socket path macOS accepts (sun_path is 104 bytes
// including the trailing NUL).
const MaxSocketPath = 103

// Paths is a resolved config home. The zero value is not usable; use Resolve or New.
type Paths struct {
	home string
}

// New returns Paths rooted at home.
func New(home string) Paths { return Paths{home: home} }

// Resolve returns Paths for the current user, honouring $CODE_FOUNDRY_HOME.
func Resolve() (Paths, error) {
	if h := os.Getenv(EnvHome); h != "" {
		abs, err := filepath.Abs(h)
		if err != nil {
			return Paths{}, fmt.Errorf("resolve %s: %w", EnvHome, err)
		}
		return New(abs), nil
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("resolve user home: %w", err)
	}
	return New(filepath.Join(userHome, "Library", "Application Support", "code-foundry")), nil
}

// Home is the config home directory.
func (p Paths) Home() string { return p.home }

// Socket is the daemon's Unix socket.
func (p Paths) Socket() string { return filepath.Join(p.home, "daemon.sock") }

// Token is the file holding the loopback HTTP bearer token (hex).
func (p Paths) Token() string { return filepath.Join(p.home, "daemon.token") }

// Port is the file holding the loopback HTTP port (decimal).
func (p Paths) Port() string { return filepath.Join(p.home, "daemon.port") }

// Lock is the single-instance lock file.
func (p Paths) Lock() string { return filepath.Join(p.home, "daemon.lock") }

// DB is the SQLite database.
func (p Paths) DB() string { return filepath.Join(p.home, "db.sqlite") }

// Logs is the log directory.
func (p Paths) Logs() string { return filepath.Join(p.home, "logs") }

// DaemonLog is the daemon's JSON log file.
func (p Paths) DaemonLog() string { return filepath.Join(p.Logs(), "daemon.log") }

// Ensure creates the home and logs directories with 0700 permissions and checks that
// the socket path fits in sun_path.
func (p Paths) Ensure() error {
	if p.home == "" {
		return errors.New("paths: empty home")
	}
	if n := len(p.Socket()); n > MaxSocketPath {
		return fmt.Errorf("paths: socket path %q is %d bytes, macOS allows %d; set %s to a shorter directory",
			p.Socket(), n, MaxSocketPath, EnvHome)
	}
	for _, dir := range []string{p.home, p.Logs()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("paths: create %s: %w", dir, err)
		}
	}
	return nil
}
