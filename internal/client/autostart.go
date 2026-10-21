package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// ConnectOptions configures Connect.
type ConnectOptions struct {
	// DaemonBinary is the code-foundry executable to spawn. Defaults to os.Executable(),
	// which is right for the CLI; the Wails host must set it (or set NoAutoStart).
	DaemonBinary string
	// NoAutoStart makes Connect fail instead of spawning a daemon when none answers.
	// The Wails host sets it when it cannot find the CLI: falling back to
	// os.Executable() there would spawn the GUI itself, which spawns another, forever.
	NoAutoStart bool
	// StartTimeout bounds how long to wait for a spawned daemon to answer Ping.
	// Defaults to 10s.
	StartTimeout time.Duration
	// Logger receives auto-start diagnostics. Defaults to slog.Default().
	Logger *slog.Logger
	// Endpoint, when set, is used instead of the Unix socket (the CLI sets it from
	// EndpointFromEnv inside a thread). Connect then only checks that the daemon
	// answers; it never starts one, since the endpoint names a daemon that is already
	// running (a new one would listen on another port with another token).
	Endpoint *Endpoint
}

const probeTimeout = time.Second

// ErrDaemonNotRunning is returned by Connect with NoAutoStart when no daemon answers.
var ErrDaemonNotRunning = errors.New("daemon is not running")

// ErrDaemonExited matches Connect's error when the daemon it started exited before it
// answered (the error itself says why).
var ErrDaemonExited = errors.New("the daemon exited at start")

// ExitLockHeld is `code-foundry daemon`'s exit status when another process holds
// daemon.lock (after --wait-lock): Connect then names that process.
const ExitLockHeld = 3

// FlagWaitLock is the daemon flag spawnDaemon passes: how long the new daemon waits for
// a previous one that no longer answers but still holds the lock (shutting down).
const FlagWaitLock = "--wait-lock"

// Connect returns a client for the daemon at p, starting the daemon if its socket is
// absent or does not answer Ping. With opts.Endpoint it talks to that loopback
// endpoint instead and never starts a daemon.
func Connect(ctx context.Context, p paths.Paths, opts ConnectOptions) (*Client, error) {
	if ep := opts.Endpoint; ep != nil {
		c := NewLoopback(ep.BaseURL, ep.Token)
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		if _, err := c.Ping(pctx); err != nil {
			return nil, fmt.Errorf("daemon at %s (%s) is not reachable; not starting one from inside a thread: %w",
				ep.BaseURL, EnvEndpoint, err)
		}
		return c, nil
	}
	if opts.StartTimeout <= 0 {
		opts.StartTimeout = 10 * time.Second
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	c := New(p)
	if c.alive(ctx) {
		return c, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	if opts.NoAutoStart {
		return nil, ErrDaemonNotRunning
	}
	bin := opts.DaemonBinary
	if bin == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("locate code-foundry binary: %w", err)
		}
		bin = exe
	}
	opts.Logger.Debug("daemon not reachable, starting it", "binary", bin, "home", p.Home())
	logFrom := fileSize(p.DaemonLog())
	exited, err := spawnDaemon(p, bin, lockWait(opts.StartTimeout))
	if err != nil {
		return nil, err
	}

	waitCtx, cancel := context.WithTimeout(ctx, opts.StartTimeout)
	defer cancel()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if c.alive(waitCtx) {
			return c, nil
		}
		select {
		case <-waitCtx.Done():
			return nil, fmt.Errorf("daemon did not become ready within %s (see %s): %w",
				opts.StartTimeout, p.DaemonLog(), waitCtx.Err())
		case err := <-exited:
			// It lost the lock to a daemon another client started at the same time,
			// which answers by now; or it could not start.
			if c.alive(waitCtx) {
				return c, nil
			}
			return nil, startFailure(p, err, logFrom)
		case <-tick.C:
		}
	}
}

// lockWait is how long a spawned daemon waits for the previous one's lock: most of the
// client's own wait, leaving it time to report why the daemon gave up.
func lockWait(start time.Duration) time.Duration {
	return max(start-2*time.Second, start/2)
}

// startError is Connect's error for a spawned daemon that exited before it answered.
type startError struct{ msg string }

func (e *startError) Error() string        { return e.msg }
func (e *startError) Is(target error) bool { return target == ErrDaemonExited }

// startFailure explains why the daemon Connect spawned exited (waitErr is its exit):
// the process holding daemon.lock, or the daemon's last error from the log lines
// written since logFrom.
func startFailure(p paths.Paths, waitErr error, logFrom int64) error {
	var exit *exec.ExitError
	if errors.As(waitErr, &exit) && exit.ExitCode() == ExitLockHeld {
		pid := lockPID(p.Lock())
		if pid == 0 {
			return &startError{fmt.Sprintf("daemon cannot start: another process holds %s but no daemon answers", p.Lock())}
		}
		return &startError{fmt.Sprintf("daemon cannot start: a daemon (pid %d, from %s) holds the lock but does not answer; if it is hung, run `kill %d`",
			pid, p.Lock(), pid)}
	}
	reason := lastLogError(p.DaemonLog(), logFrom)
	if reason == "" {
		reason = "exited"
		if waitErr != nil {
			reason = waitErr.Error()
		}
	}
	return &startError{fmt.Sprintf("daemon cannot start: %s (see %s)", reason, p.DaemonLog())}
}

// lockPID is the pid daemon.lock records (0 when unreadable).
func lockPID(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid
}

func fileSize(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return fi.Size()
}

// logTailMax bounds how much of daemon.log lastLogError reads.
const logTailMax = 64 << 10

// lastLogError returns the last error the daemon log has after offset from: a JSON
// line at level ERROR (its err, else its msg), or the CLI's own "code-foundry: ..."
// line on stderr (which the auto-start redirect appends to the same file). A log
// shorter than from was rotated by the new daemon and is read from its start.
func lastLogError(path string, from int64) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	size := fileSize(path)
	if size < from {
		from = 0
	}
	from = max(from, size-logTailMax)
	buf := make([]byte, size-from)
	n, _ := f.ReadAt(buf, from)
	var last string
	for line := range strings.Lines(string(buf[:n])) {
		line = strings.TrimSpace(line)
		if r, ok := strings.CutPrefix(line, "code-foundry: "); ok {
			last = r
			continue
		}
		var rec struct {
			Level string `json:"level"`
			Msg   string `json:"msg"`
			Err   string `json:"err"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil || rec.Level != slog.LevelError.String() {
			continue
		}
		if last = rec.Err; last == "" {
			last = rec.Msg
		}
	}
	return last
}

func (c *Client) alive(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	_, err := c.Ping(ctx)
	return err == nil
}

// spawnDaemon starts `bin daemon --wait-lock <lockWait>` in its own session, detached
// from the caller's terminal, with stdio appended to the daemon log. The channel gets
// the child's exit (nil or *exec.ExitError) if it exits while we are still running. If
// two clients race, the loser's daemon exits on the instance lock and both end up
// talking to the winner.
func spawnDaemon(p paths.Paths, bin string, lockWait time.Duration) (<-chan error, error) {
	if err := p.Ensure(); err != nil {
		return nil, err
	}
	logf, err := os.OpenFile(p.DaemonLog(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open daemon log: %w", err)
	}
	defer func() { _ = logf.Close() }()
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", os.DevNull, err)
	}
	defer func() { _ = devnull.Close() }()

	cmd := exec.Command(bin, "daemon", FlagWaitLock, lockWait.String())
	cmd.Env = append(os.Environ(), paths.EnvHome+"="+p.Home())
	cmd.Dir = "/"
	cmd.Stdin = devnull
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("start daemon: %s not found: %w", bin, err)
		}
		return nil, fmt.Errorf("start daemon: %w", err)
	}
	// Reap the child if it exits while we are still running (it lost the lock race,
	// or it could not start), and tell Connect.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return exited, nil
}
