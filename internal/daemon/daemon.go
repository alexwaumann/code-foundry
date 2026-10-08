// Package daemon bootstraps the code-foundry daemon: single-instance lock, logging, and
// two listeners serving the same Connect handlers.
//
//   - A Unix socket ($HOME/daemon.sock, 0600) for the CLI and the Wails host. Access is
//     controlled by filesystem permissions.
//   - A loopback TCP listener (127.0.0.1, random port) for the GUI frontend, guarded by
//     a bearer token. The port and token are written to daemon.port and daemon.token
//     (0600) once both listeners are up, and removed on shutdown.
//
// Both listeners speak HTTP/1.1 and HTTP/2 with prior knowledge (h2c), so Connect
// streaming works over either.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/awaumann/code-foundry/internal/api"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/store/terminal"
	"github.com/awaumann/code-foundry/internal/version"
)

// shutdownTimeout bounds graceful shutdown; open streams are cut after it.
const shutdownTimeout = 5 * time.Second

// Options configures Run.
type Options struct {
	Paths   paths.Paths
	Version version.Info
	// Dev also logs text at debug level to Stderr.
	Dev    bool
	Stderr io.Writer
}

// Run starts the daemon and blocks until ctx is cancelled or the process receives
// SIGINT or SIGTERM, then shuts down gracefully. It returns ErrAlreadyRunning if
// another daemon owns the same config home.
func Run(ctx context.Context, opts Options) error {
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	p := opts.Paths
	if err := p.Ensure(); err != nil {
		return err
	}
	lock, err := acquireLock(p.Lock())
	if err != nil {
		return err
	}
	defer func() { _ = lock.release() }()

	log, logFile, err := newLogger(p.DaemonLog(), opts.Dev, opts.Stderr)
	if err != nil {
		return err
	}
	defer func() { _ = logFile.Close() }()

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	started := time.Now()
	events := bus.New()
	terminals := terminal.New(terminal.Options{Bus: events, Logger: log.With("store", "terminal")})
	// Runs after the listeners have shut down (defers are LIFO): hang up every PTY.
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
		defer cancel()
		if err := terminals.Close(closeCtx); err != nil {
			log.Warn("close terminals", "err", err)
		}
	}()
	routes := []api.Route{
		api.NewHealth(started, opts.Version).Route(),
		api.NewTerminal(terminals).Route(),
	}
	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Path, r.Handler)
	}

	token, err := newToken()
	if err != nil {
		return err
	}

	// We hold the lock, so any socket file left behind is from a dead daemon.
	if err := os.Remove(p.Socket()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	unixLn, err := net.Listen("unix", p.Socket())
	if err != nil {
		return fmt.Errorf("listen %s: %w", p.Socket(), err)
	}
	// The home dir is 0700 already; tighten the socket itself too.
	if err := os.Chmod(p.Socket(), 0o600); err != nil {
		_ = unixLn.Close()
		return fmt.Errorf("chmod socket: %w", err)
	}
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = unixLn.Close()
		return fmt.Errorf("listen loopback: %w", err)
	}
	port := tcpLn.Addr().(*net.TCPAddr).Port

	defer removeRuntimeFiles(log, p)
	if err := writeFileAtomic(p.Token(), []byte(token+"\n"), 0o600); err != nil {
		_ = unixLn.Close()
		_ = tcpLn.Close()
		return err
	}
	if err := writeFileAtomic(p.Port(), []byte(strconv.Itoa(port)+"\n"), 0o600); err != nil {
		_ = unixLn.Close()
		_ = tcpLn.Close()
		return err
	}

	unixSrv := newServer(log, "unix", logRequests(log, "unix", mux))
	tcpSrv := newServer(log, "loopback", logRequests(log, "loopback", cors(requireBearer(token, mux))))

	errc := make(chan error, 2)
	go func() { errc <- serve(unixSrv, unixLn) }()
	go func() { errc <- serve(tcpSrv, tcpLn) }()

	log.Info("daemon started",
		"pid", os.Getpid(), "version", opts.Version.Version, "commit", opts.Version.Commit,
		"socket", p.Socket(), "port", port, "home", p.Home())

	var runErr error
	select {
	case <-ctx.Done():
		log.Info("shutting down", "cause", context.Cause(ctx))
	case runErr = <-errc:
		log.Error("listener failed, shutting down", "err", runErr)
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	for _, s := range []*http.Server{unixSrv, tcpSrv} {
		if err := s.Shutdown(shutdownCtx); err != nil {
			log.Warn("graceful shutdown incomplete", "err", err)
			_ = s.Close()
		}
	}
	log.Info("daemon stopped", "uptime", time.Since(started).Round(time.Millisecond).String())
	return runErr
}

func newServer(log *slog.Logger, name string, h http.Handler) *http.Server {
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	return &http.Server{
		Handler:           h,
		Protocols:         &protocols,
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.With("listener", name).Handler(), slog.LevelWarn),
	}
}

func serve(s *http.Server, ln net.Listener) error {
	if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve %s: %w", ln.Addr(), err)
	}
	return nil
}

func removeRuntimeFiles(log *slog.Logger, p paths.Paths) {
	for _, f := range []string{p.Port(), p.Token(), p.Socket()} {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Warn("remove runtime file", "path", f, "err", err)
		}
	}
}
