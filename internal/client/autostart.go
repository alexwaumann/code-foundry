package client

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// ConnectOptions configures Connect.
type ConnectOptions struct {
	// DaemonBinary is the code-foundry executable to spawn. Defaults to os.Executable(),
	// which is right for the CLI; the Wails host must set it.
	DaemonBinary string
	// StartTimeout bounds how long to wait for a spawned daemon to answer Ping.
	// Defaults to 10s.
	StartTimeout time.Duration
	// Logger receives auto-start diagnostics. Defaults to slog.Default().
	Logger *slog.Logger
	// Endpoint, when set, is used instead of the Unix socket (the CLI sets it from
	// EndpointFromEnv inside a session). Connect then only checks that the daemon
	// answers; it never starts one, since the endpoint names a daemon that is already
	// running (a new one would listen on another port with another token).
	Endpoint *Endpoint
}

const probeTimeout = time.Second

// Connect returns a client for the daemon at p, starting the daemon if its socket is
// absent or does not answer Ping. With opts.Endpoint it talks to that loopback
// endpoint instead and never starts a daemon.
func Connect(ctx context.Context, p paths.Paths, opts ConnectOptions) (*Client, error) {
	if ep := opts.Endpoint; ep != nil {
		c := NewLoopback(ep.BaseURL, ep.Token)
		pctx, cancel := context.WithTimeout(ctx, probeTimeout)
		defer cancel()
		if _, err := c.Ping(pctx); err != nil {
			return nil, fmt.Errorf("daemon at %s (%s) is not reachable; not starting one from inside a session: %w",
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

	bin := opts.DaemonBinary
	if bin == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("locate code-foundry binary: %w", err)
		}
		bin = exe
	}
	opts.Logger.Debug("daemon not reachable, starting it", "binary", bin, "home", p.Home())
	if err := spawnDaemon(p, bin); err != nil {
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
		case <-tick.C:
		}
	}
}

func (c *Client) alive(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	_, err := c.Ping(ctx)
	return err == nil
}

// spawnDaemon starts `bin daemon` in its own session, detached from the caller's
// terminal, with stdio appended to the daemon log. If two clients race, the loser's
// daemon exits on the instance lock and both end up talking to the winner.
func spawnDaemon(p paths.Paths, bin string) error {
	if err := p.Ensure(); err != nil {
		return err
	}
	logf, err := os.OpenFile(p.DaemonLog(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	defer func() { _ = logf.Close() }()
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return fmt.Errorf("open %s: %w", os.DevNull, err)
	}
	defer func() { _ = devnull.Close() }()

	cmd := exec.Command(bin, "daemon")
	cmd.Env = append(os.Environ(), paths.EnvHome+"="+p.Home())
	cmd.Dir = "/"
	cmd.Stdin = devnull
	cmd.Stdout = logf
	cmd.Stderr = logf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("start daemon: %s not found: %w", bin, err)
		}
		return fmt.Errorf("start daemon: %w", err)
	}
	// Reap the child if it exits while we are still running (e.g. lost the lock race).
	go func() { _ = cmd.Wait() }()
	return nil
}
