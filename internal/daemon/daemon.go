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

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// shutdownTimeout bounds graceful shutdown; open streams are cut after it.
const shutdownTimeout = 5 * time.Second

// restartDelay is how long daemon.restart waits before shutting down, so its response
// is delivered.
const restartDelay = 250 * time.Millisecond

// errRestartRequested is the shutdown cause for daemon.restart.
var errRestartRequested = errors.New("daemon.restart requested")

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

	log, logLevel, logFile, err := newLogger(p.DaemonLog(), opts.Dev, opts.Stderr)
	if err != nil {
		return err
	}
	defer func() { _ = logFile.Close() }()

	// Before any store starts a process: children must not inherit an enclosing
	// Claude Code session's variables.
	scrubClaudeEnv(log)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	// daemon.restart shuts down exactly like SIGTERM; the next client auto-starts the
	// binary installed by then.
	ctx, restart := context.WithCancelCause(ctx)
	defer restart(nil)

	st, err := openStores(ctx, log, p)
	if err != nil {
		return err
	}
	defer func() { _ = st.close() }() // after the servers have shut down

	started := time.Now()
	events := st.bus
	repoAPI := api.NewRepo(st.repo, events)
	terminalAPI := api.NewTerminal(st.terminal)
	sessionAPI := api.NewSession(st.session, events)
	gitopsAPI := api.NewGitOps(st.gitops, events, ctx.Done())
	ghAPI := api.NewGh(st.gh, events, ctx.Done())
	settingsAPI := api.NewSettings(st.settings)
	updateAPI := api.NewUpdate(st.update, events, ctx.Done())
	commands := command.NewRegistry()
	if err := all.Register(commands, all.Deps{
		Daemon: command.DaemonInfo{
			PID: os.Getpid(), Version: opts.Version, Started: started, Home: p.Home(), Socket: p.Socket(),
		},
		Emitter:  command.BusEmitter{Bus: events},
		Terminal: terminalAPI,
		Repo:     worktreeDirRepo{RepoBackend: repoAPI, repos: st.repo, settings: st.settings},
		Session:  sessionAPI,
		GitOps: command.GitOpsDeps{
			Backend:    gitopsAPI,
			GitHubSlug: func(c command.Context) string { return st.gitops.GitHubSlug(c.ActiveRepoID, c.ActiveWorktreePath) },
			LocalOnly:  func(c command.Context) bool { return st.gitops.LocalOnly(c.ActiveRepoID, c.ActiveWorktreePath) },
		},
		Gh:       ghAPI,
		Settings: settingsAPI,
		Update:   updateAPI,
		Restart: func() {
			// Let the command's response reach the caller first.
			time.AfterFunc(restartDelay, func() { restart(errRestartRequested) })
		},
	}); err != nil {
		return fmt.Errorf("register commands: %w", err)
	}
	applySettings(st.settings, commands, logLevel, opts.Dev)
	routes := []api.Route{
		api.NewHealth(started, opts.Version).Route(),
		api.NewCommand(commands).Route(),
		api.NewUI(events).Route(),
		terminalAPI.Route(),
		sessionAPI.Route(),
		repoAPI.Route(),
		ghAPI.Route(),
		gitopsAPI.Route(),
		settingsAPI.Route(),
		updateAPI.Route(),
		api.NewEvents(api.EventsDeps{Bus: events, Repo: st.repo, Terminal: st.terminal, Session: st.session, Gh: st.gh, GitOps: st.gitops, Settings: st.settings, Update: st.update, Done: ctx.Done()}).Route(),
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

	// Request contexts derive from reqCtx, cancelled before Shutdown, so long-lived
	// server streams (Watch, Attach) return instead of holding shutdown for its timeout.
	reqCtx, cancelRequests := context.WithCancel(ctx)
	defer cancelRequests()
	unixSrv := newServer(reqCtx, log, "unix", logRequests(log, "unix", mux))
	tcpSrv := newServer(reqCtx, log, "loopback", logRequests(log, "loopback", cors(requireBearer(token, mux))))

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

	cancelRequests()
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

func newServer(ctx context.Context, log *slog.Logger, name string, h http.Handler) *http.Server {
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	return &http.Server{
		BaseContext:       func(net.Listener) context.Context { return ctx },
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
