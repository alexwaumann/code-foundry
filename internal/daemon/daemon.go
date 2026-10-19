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
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// shutdownTimeout bounds graceful shutdown; open streams are cut after it.
const shutdownTimeout = 5 * time.Second

// restartDelay is how long daemon.restart waits before shutting down, so its response
// is delivered.
const restartDelay = 250 * time.Millisecond

// promptSettle is how long a new shell must stay quiet after its first output before
// terminal.new --run types into it: a startup file printing ahead of the prompt, or a
// prompt drawn in pieces, gets that long to finish.
const promptSettle = 150 * time.Millisecond

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
	// Claude Code session's variables, or another daemon's endpoint.
	scrubClaudeEnv(log)
	scrubEndpointEnv(log)

	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	// daemon.restart shuts down exactly like SIGTERM; the next client auto-starts the
	// binary installed by then.
	ctx, restart := context.WithCancelCause(ctx)
	defer restart(nil)

	// The loopback listener and its token exist before the stores: every Claude
	// thread gets them in its environment (threadEnv), so the CLI inside a thread
	// reaches this daemon over TCP. Sandboxed threads cannot use the Unix socket.
	token, err := newToken()
	if err != nil {
		return err
	}
	tcpLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen loopback: %w", err)
	}
	defer func() { _ = tcpLn.Close() }() // no-op once the server has shut it down
	port := tcpLn.Addr().(*net.TCPAddr).Port

	// The GUI clients of EventService.Watch and their visibility pace the GitHub poll
	// (docs/notes/gh-poll-tiers.md). ghStore is set before any server starts, so before
	// any stream can join.
	var ghStore *gh.Store
	clients := api.NewClients(func(from, to gh.Presence) {
		if ghStore != nil {
			ghStore.PresenceChanged(from, to)
		}
	})
	st, err := openStores(ctx, log, p, threadEnv(port, token), clients.Presence)
	if err != nil {
		// In the log file too: an auto-started daemon's stderr goes nowhere a user
		// looks (db.ErrNewerSchema, say, after reinstalling an older build).
		log.Error("daemon cannot start", "err", err)
		return err
	}
	defer func() { _ = st.close() }() // after the servers have shut down
	ghStore = st.gh

	started := time.Now()
	events := st.bus
	projectAPI := api.NewProject(st.project, events).WithGitHub(st.gh, st.cloner).WithNewProjects(st.newProjects, st.gh).
		WithCleanupHold(func(w project.Worktree) string {
			return cleanupHold(w.Path, worktreeThreads(st.thread.Snapshot()), st.terminal.List(context.Background()), st.workspace.Snapshot())
		})
	terminalAPI := api.NewTerminal(st.terminal)
	threadAPI := api.NewThread(st.thread, events)
	gitopsAPI := api.NewGitOps(st.gitops, events, ctx.Done())
	ghAPI := api.NewGh(st.gh, events, ctx.Done())
	settingsAPI := api.NewSettings(st.settings)
	updateAPI := api.NewUpdate(st.update, events, ctx.Done())
	workspaceAPI := api.NewWorkspace(st.workspace, events)
	actionAPI := api.NewAction(st.action, events)
	commands := command.NewRegistry()
	facts := pluginFacts{thread: st.thread, project: st.project, gh: st.gh}
	// Plugins start once every command is registered (below), so a starting plugin's
	// host/invoke finds them; they stop before the stores close (defers run in reverse),
	// so a last host/invoke still has a registry and stores behind it.
	plugins, err := plugin.New(plugin.Options{
		Dir: p.Plugins(), DataDir: p.PluginData(), LogDir: p.PluginLogs(),
		DB: st.db, Commands: commands, Bus: events, Log: log.With("component", "plugins"),
		Home: st.home, HostVersion: opts.Version.Version, APIEnv: threadEnv(port, token),
		Facts: facts, Emitter: command.BusEmitter{Bus: events},
		Flags:   pluginFlags{threads: st.thread},
		Threads: pluginThreads{threads: st.thread, settings: st.settings}, Terminals: pluginTerminals{terminals: st.terminal},
		Registry: pluginRegistryClient(p, st.settings.Settings(), log.With("component", "plugin-registry")),
		Secrets:  plugin.Keychain{Service: pluginKeychainService(p)},
	})
	if err != nil {
		return err
	}
	defer func() { _ = plugins.Close() }()
	pluginAPI := api.NewPlugin(plugins, events).WithSurfaces(plugins).WithDirs(p.Plugins(), p.PluginData())
	// Every claude spawn gets the plugins' session environments (plugin_hooks.go), and
	// so does every new bottom-panel shell, without the add-dirs (plugin_env.go).
	st.thread.SetSpawnExtras(pluginSpawnExtras(plugins))
	st.terminal.SetSpawnExtras(pluginShellExtras(plugins, st.thread))
	eventsAPI := api.NewEvents(api.EventsDeps{Bus: events, Project: st.project, Terminal: st.terminal, Thread: st.thread, Gh: st.gh, GitOps: st.gitops, Settings: st.settings, Update: st.update, Workspace: st.workspace, Action: st.action, Plugin: plugins, Done: ctx.Done(), Clients: clients})
	// Plugins subscribe to the same events (events/subscribe).
	plugins.SetEvents(api.NewPluginFeed(eventsAPI, log.With("component", "plugins")))
	if err := all.Register(commands, all.Deps{
		Daemon: command.DaemonInfo{
			PID: os.Getpid(), Version: opts.Version, Started: started, Home: p.Home(), Socket: p.Socket(),
		},
		Emitter:  command.BusEmitter{Bus: events},
		Terminal: terminalAPI,
		IsShellTerminal: func(id string) bool {
			t, err := st.terminal.Get(context.Background(), id)
			return err == nil && termlabel.IsPanel(t.Labels)
		},
		AwaitTerminalOutput: func(ctx context.Context, id string) error {
			return terminal.AwaitOutput(ctx, st.terminal, id, promptSettle)
		},
		TerminalBracketedPaste: st.terminal.BracketedPaste,
		Project:                projectAPI,
		Clone:                  projectAPI.CloneRef,
		NewProjects: command.NewProjectDeps{
			Backend: projectAPI,
			HasOrigin: func(c command.Context) bool {
				r, ok := st.project.Snapshot().Owner(c.ActiveProjectID, c.ActiveWorktreePath)
				return ok && slices.Contains(r.Remotes, "origin")
			},
			Deletable: func(c command.Context) bool {
				r, ok := st.project.Snapshot().Owner(c.ActiveProjectID, c.ActiveWorktreePath)
				return ok && st.newProjects.Deletable(r.Path)
			},
		},
		NotGit: func(c command.Context) bool {
			r, ok := st.project.Snapshot().Owner(c.ActiveProjectID, c.ActiveWorktreePath)
			return ok && !r.Git
		},
		Thread: threadAPI,
		GitOps: command.GitOpsDeps{
			Backend:    gitopsAPI,
			GitHubSlug: func(c command.Context) string { return st.gitops.GitHubSlug(c.ActiveProjectID, c.ActiveWorktreePath) },
			LocalOnly:  func(c command.Context) bool { return st.gitops.LocalOnly(c.ActiveProjectID, c.ActiveWorktreePath) },
		},
		Gh:                ghAPI,
		Settings:          settingsAPI,
		Update:            updateAPI,
		Workspace:         workspaceAPI,
		Action:            actionAPI,
		Plugin:            pluginAPI,
		PluginSurface:     pluginAPI,
		PluginRegistry:    pluginAPI,
		PullRequestChecks: command.PullRequestChecksDeps{Gh: ghAPI, ThreadPullRequest: facts.threadPullRequest},
		Restart: func() {
			// Let the command's response reach the caller first.
			time.AfterFunc(restartDelay, func() { restart(errRestartRequested) })
		},
	}); err != nil {
		return fmt.Errorf("register commands: %w", err)
	}
	applySettings(st.settings, commands, logLevel, opts.Dev)
	if err := plugins.Start(ctx); err != nil {
		log.Error("plugins did not start", "err", err)
	}
	applyPluginRegistries(st.settings, plugins)
	defer startPluginUpdateChecks(ctx, log.With("component", "plugins"), events, st.update, plugins)()
	defer startPluginContexts(ctx, events, plugins)()
	defer startPluginEnvWatch(ctx, events, st.thread)()
	defer startPluginChecks(ctx, events, plugins)()
	defer startPluginTerminalExits(ctx, log.With("component", "plugins"), st.terminal, plugins)()
	commandAPI := api.NewCommand(commands)
	installSkills(ctx, log.With("component", "skills"), p.Claude(), opts.Version, commandAPI, settingsAPI, st.settings)
	routes := []api.Route{
		api.NewHealth(started, opts.Version).Route(),
		commandAPI.Route(),
		api.NewUI(events).Route(),
		terminalAPI.Route(),
		threadAPI.Route(),
		projectAPI.Route(),
		ghAPI.Route(),
		gitopsAPI.Route(),
		settingsAPI.Route(),
		updateAPI.Route(),
		workspaceAPI.Route(),
		actionAPI.Route(),
		pluginAPI.Route(),
		api.NewFilesystem(st.home, st.project).Route(),
		eventsAPI.Route(),
	}
	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Path, r.Handler)
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

	defer removeRuntimeFiles(log, p)
	if err := writeFileAtomic(p.Token(), []byte(token+"\n"), 0o600); err != nil {
		_ = unixLn.Close()
		return err
	}
	if err := writeFileAtomic(p.Port(), []byte(strconv.Itoa(port)+"\n"), 0o600); err != nil {
		_ = unixLn.Close()
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

// pluginKeychainService is the Keychain service of this config home's plugin secrets:
// the plain one for ~/.code-foundry, a per-home one for any other CODE_FOUNDRY_HOME.
func pluginKeychainService(p paths.Paths) string {
	def := ""
	if u, err := os.UserHomeDir(); err == nil {
		def = filepath.Join(u, paths.DirName)
	}
	return plugin.KeychainServiceFor(p.Home(), def)
}
