// Package paths resolves the on-disk locations code-foundry uses: the config home,
// the daemon's socket, token, port and lock files, the SQLite database, logs, the
// worktrees New Worktree creates, cloned and created projects, staged prompt
// attachments, and the skills shipped to threads.
//
// The home directory is, in order of precedence:
//
//  1. $CODE_FOUNDRY_HOME, if set (used by tests and for side-by-side installs).
//  2. ~/.code-foundry.
//
// A dot-directory in the user's home, like ~/.claude, keeps every path short, free of
// spaces and well under the socket path limit. XDG_CONFIG_HOME is deliberately not
// consulted: code-foundry is macOS-only.
package paths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EnvHome overrides the config home directory.
const EnvHome = "CODE_FOUNDRY_HOME"

// The daemon sets these in every Claude session it spawns: its loopback endpoint
// (http://127.0.0.1:<port>) and bearer token. The CLI prefers them over the Unix
// socket (client.EndpointFromEnv); sandboxed threads cannot connect to sockets.
const (
	EnvEndpoint = "CODE_FOUNDRY_ENDPOINT"
	EnvToken    = "CODE_FOUNDRY_TOKEN"
)

// EnvThread is the id of the thread a process belongs to. The daemon sets it in every
// Claude process it spawns for a thread (and in a thread's action runs); the CLI sends it
// as the default --context-thread, so `code-foundry terminal new` or `action run` from a
// thread's agent lands in that thread's bottom panel.
const EnvThread = "CODE_FOUNDRY_THREAD"

// EnvThreadLegacy is EnvThread's name before threads were renamed from sessions. The CLI
// still reads it when EnvThread is unset, for one release, so a process started with the
// old name keeps its default --context-thread; the daemon sets only EnvThread and scrubs
// both. Remove it after the next stable release.
const EnvThreadLegacy = "CODE_FOUNDRY_SESSION"

// Every action run (internal/store/action) gets these: the project's main checkout and
// the worktree the run belongs to (its cwd).
const (
	EnvProjectRoot = "CODE_FOUNDRY_PROJECT_ROOT"
	EnvWorktree    = "CODE_FOUNDRY_WORKTREE"
)

// DirName is the default config home's name inside the user's home directory.
const DirName = ".code-foundry"

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
	return New(filepath.Join(userHome, DirName)), nil
}

// Home is the config home directory.
func (p Paths) Home() string { return p.home }

// App is the default install directory (scripts/install.sh): the code-foundry and
// "Code Foundry" executables and a VERSION file.
func (p Paths) App() string { return filepath.Join(p.home, "app") }

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

// Worktrees is where New Worktree puts worktrees: <Worktrees>/<owner>/<repo>/<branch>.
// git creates the directories on demand.
func (p Paths) Worktrees() string { return filepath.Join(p.home, "worktrees") }

// Projects is where projects the app creates live: clones at
// <Projects>/<owner>/<repo> (ProjectService.Clone), new projects at <Projects>/<name>.
// Not configurable. The clone store creates it (0700) on first use.
func (p Paths) Projects() string { return filepath.Join(p.home, "projects") }

// Attachments is where images and PDFs staged for a thread's messages are kept
// (ThreadService.StageAttachment). The thread store creates it on demand and
// reaps files older than thread.AttachmentMaxAge.
func (p Paths) Attachments() string { return filepath.Join(p.home, "attachments") }

// Claude is the directory every thread's claude gets as its first --add-dir: the daemon
// writes the skills it ships to threads under .claude/skills in it at every start,
// with a VERSION file (internal/skills). Wholly the daemon's: anything else in it is
// removed.
func (p Paths) Claude() string { return filepath.Join(p.home, "claude") }

// Plugins is where plugin packages live: <Plugins>/<name>/plugin.json, a directory or,
// for `plugin dev`, a symlink to the author's folder (internal/store/plugin).
func (p Paths) Plugins() string { return filepath.Join(p.home, "plugins") }

// PluginData is a plugin's own state directory (0700), outside its package so an update
// never wipes it: <PluginData>/<name>.
func (p Paths) PluginData() string { return filepath.Join(p.home, "plugin-data") }

// PluginLogs is where each plugin's log goes: <PluginLogs>/<name>.log (stderr and its
// log notifications, 1 MiB, one rotation).
func (p Paths) PluginLogs() string { return filepath.Join(p.Logs(), "plugins") }

// WindowBackground is the GUI host's own state: the window colour of each scheme, so the
// window opens in the last theme's colour before the page (and the daemon's settings)
// load (gui/windowbg.go). Not under App(): an update replaces that directory.
func (p Paths) WindowBackground() string { return filepath.Join(p.home, "window-background.json") }

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
