package plugin

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/childproc"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// errPermanent marks a start failure retrying cannot fix (an unsupported protocol, a
// missing executable): the plugin fails at once unless it is a dev plugin.
var errPermanent = errors.New("cannot start")

// actor runs one enabled plugin: start, handshake, ping, restart with backoff, stop.
// One goroutine (run) owns the process; host calls arrive on the Conn's goroutines.
type actor struct {
	m    *Manager
	name string

	stopCh   chan struct{}
	stopOnce sync.Once
	done     chan struct{}
	hung     chan struct{} // the outbound queue overflowed: the plugin stopped reading

	mu      sync.Mutex
	conn    *pluginsdk.Conn
	perms   pluginsdk.Permissions // the running manifest's
	logs    *logBuffer
	ignored map[string]bool // later-protocol notifications already logged this run
	echo    rateLimiter

	// flagRate limits thread/setFlag per thread (flags.go).
	flagRate flagLimiter
	// events is the run's subscriptions (events.go); nil until the first subscribe.
	events *eventPump
	// envReady closes when the run first pushes its session environment, settles
	// without one, or ends (environment.go): a spawn waits for it.
	envReady chan struct{}

	crashes []time.Time // only run's goroutine touches it
}

func newActor(m *Manager, name string) *actor {
	return &actor{m: m, name: name, stopCh: make(chan struct{}), done: make(chan struct{}), hung: make(chan struct{}, 1),
		envReady: make(chan struct{})}
}

func (a *actor) requestStop() { a.stopOnce.Do(func() { close(a.stopCh) }) }

func (a *actor) stopping() bool {
	select {
	case <-a.stopCh:
		return true
	default:
		return false
	}
}

// running returns the live Conn, nil when the plugin is not running.
func (a *actor) running() *pluginsdk.Conn {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.conn
}

func (a *actor) permissions() pluginsdk.Permissions {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.perms
}

// spawnInfo is what one attempt needs, read from the entry at the attempt.
type spawnInfo struct {
	dir      string
	dev      bool
	manifest pluginsdk.Manifest
	granted  pluginsdk.Permissions
	logs     *logBuffer
}

func (m *Manager) spawnInfo(a *actor) (spawnInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[a.name]
	if e == nil || e.actor != a || e.loadErr != "" {
		return spawnInfo{}, false
	}
	info := spawnInfo{dir: e.dir, dev: e.dev, manifest: e.manifest, logs: e.logs}
	if e.row.Granted != nil {
		info.granted = *e.row.Granted
	}
	return info, true
}

// run starts the plugin and restarts it after a crash with exponential backoff, until
// it is stopped or fails.
func (a *actor) run() {
	defer close(a.done)
	o := a.m.opts
	for !a.stopping() {
		info, ok := a.m.spawnInfo(a)
		if !ok {
			return
		}
		started := o.Now()
		err := a.once(info)
		if a.stopping() {
			return
		}
		if err == nil {
			err = errors.New("stopped")
		}
		now := o.Now()
		if now.Sub(started) >= o.StableAfter {
			a.crashes = nil
		}
		a.crashes = slices.DeleteFunc(append(a.crashes, now), func(t time.Time) bool { return now.Sub(t) > o.CrashWindow })
		permanent := errors.Is(err, errPermanent)
		msg := err.Error()
		info.logs.add("host", "", msg)
		if !info.dev && (permanent || len(a.crashes) >= o.CrashLimit) {
			reason := msg
			if !permanent {
				reason = fmt.Sprintf("crashed %d times in %s, last: %s", len(a.crashes), shortDuration(o.CrashWindow), msg)
			}
			a.m.log.Warn("plugin failed", "plugin", a.name, "err", reason)
			info.logs.add("host", "", "failed: run `code-foundry plugin restart "+a.name+"` to try again")
			a.m.update(a.name, a, func(e *entry) {
				e.state, e.lastError, e.pid, e.nextRestartAt = StateFailed, reason, 0, time.Time{}
				e.restarts++
			})
			return
		}
		delay := backoff(len(a.crashes), o.BackoffBase, o.BackoffMax)
		if info.dev {
			delay = min(delay, o.DevBackoffMax)
		}
		a.m.log.Info("plugin crashed", "plugin", a.name, "err", msg, "retry_in", delay.String())
		info.logs.add("host", "", "restarting in "+delay.String())
		a.m.update(a.name, a, func(e *entry) {
			e.state, e.lastError, e.pid, e.nextRestartAt = StateCrashed, msg, 0, now.Add(delay)
			e.restarts++
		})
		t := time.NewTimer(delay)
		select {
		case <-a.stopCh:
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// shortDuration drops a duration's zero tail: 10m, 1h30m, 2s.
func shortDuration(d time.Duration) string {
	s := d.String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

// backoff is base·2^(n-1), at most ceiling.
func backoff(n int, base, ceiling time.Duration) time.Duration {
	d := base
	for i := 1; i < n && d < ceiling; i++ {
		d *= 2
	}
	return min(d, ceiling)
}

// once runs the plugin until it exits, hangs or is stopped. nil means stopped on
// request.
func (a *actor) once(info spawnInfo) (err error) {
	defer func() {
		if r := recover(); r != nil {
			a.m.log.Error("plugin actor panicked", "plugin", a.name, "panic", r, "stack", string(debug.Stack()))
			err = fmt.Errorf("internal error: %v", r)
		}
	}()
	o := a.m.opts
	mf := info.manifest
	// A spawn may wait for this run's session environment (environment.go): ready once
	// it pushes, settles or ends.
	a.mu.Lock()
	envReady := a.envReady
	select {
	case <-envReady: // an earlier run's
		envReady = make(chan struct{})
		a.envReady = envReady
	default:
	}
	a.mu.Unlock()
	defer closeOnce(envReady)
	if mf.Protocol != pluginsdk.ProtocolVersion {
		return fmt.Errorf("%w: it speaks protocol %d, this Code Foundry speaks %d", errPermanent, mf.Protocol, pluginsdk.ProtocolVersion)
	}
	argv, err := resolveExec(info.dir, mf.Exec)
	if err != nil {
		return fmt.Errorf("%w: %v", errPermanent, err)
	}
	dataDir := filepath.Join(o.DataDir, a.name)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}
	a.mu.Lock()
	a.perms, a.logs, a.ignored = mf.Permissions, info.logs, map[string]bool{}
	a.mu.Unlock()
	a.m.update(a.name, a, func(e *entry) { e.state = StateStarting })

	proc, err := childproc.Start(childproc.Spec{
		Argv: argv, BaseEnv: a.m.pluginEnv(a.name, info, dataDir), Dir: info.dir, Name: "plugin " + a.name,
		StderrLine: func(l string) { info.logs.add("stderr", "", l) },
	})
	if err != nil {
		return fmt.Errorf("%w: %v", errPermanent, err)
	}
	conn := pluginsdk.NewConn(proc.Stdout(), proc.Stdin(), pluginsdk.ConnOptions{
		Handle: a.handle,
		Notify: a.notify,
		OnIssue: func(msg string) {
			info.logs.add("host", "", "protocol: "+msg)
			if strings.Contains(msg, "queue full") {
				select {
				case a.hung <- struct{}{}:
				default:
				}
			}
		},
	})
	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()
	defer func() {
		a.closeEvents()
		a.mu.Lock()
		a.conn = nil
		a.mu.Unlock()
		_ = conn.Close()
		_ = proc.Signal(syscall.SIGKILL)
		select {
		case <-proc.Done():
		case <-time.After(o.KillGrace):
		}
		proc.CloseOutput()
	}()
	info.logs.add("host", "", fmt.Sprintf("starting %s %s (pid %d)", a.name, mf.Version, proc.Pid()))
	a.m.update(a.name, a, func(e *entry) { e.pid = proc.Pid() })

	ictx, cancel := context.WithTimeout(context.Background(), o.InitTimeout)
	var res pluginsdk.InitializeResult
	err = conn.Call(ictx, pluginsdk.MethodInitialize, pluginsdk.InitializeParams{
		Protocol: pluginsdk.ProtocolVersion,
		Host:     pluginsdk.HostInfo{Version: o.HostVersion, Capabilities: hostCapabilities},
		Plugin:   pluginsdk.PluginInfo{Name: a.name, Dir: info.dir, DataDir: dataDir, Granted: info.granted, Dev: info.dev},
		Flags:    a.m.liveFlags(a.name),
	}, &res)
	cancel()
	if err != nil {
		select {
		case <-proc.Done():
			return a.exitError(proc, "")
		case <-time.After(stderrSettle):
		}
		return a.exitError(proc, fmt.Sprintf("did not answer initialize: %v", err))
	}
	if res.Protocol != pluginsdk.ProtocolVersion {
		return fmt.Errorf("%w: initialize answered protocol %d, this Code Foundry speaks %d", errPermanent, res.Protocol, pluginsdk.ProtocolVersion)
	}
	if err := conn.Notify(pluginsdk.MethodInitialized, struct{}{}); err != nil {
		return a.exitError(proc, err.Error())
	}
	now := o.Now()
	a.m.update(a.name, a, func(e *entry) {
		e.state, e.startedAt, e.protocol, e.caps, e.nextRestartAt = StateRunning, now, res.Protocol, res.Capabilities, time.Time{}
	})
	info.logs.add("host", "", "running")
	// Its Init (which pushes its session environment) runs now; a spawn waits a moment.
	settle := time.AfterFunc(envSettle, func() { closeOnce(envReady) })
	defer settle.Stop()

	ping := time.NewTicker(o.PingInterval)
	defer ping.Stop()
	misses := 0
	for {
		select {
		case <-proc.Done():
			return a.exitError(proc, "")
		case <-conn.Done():
			// stdout closed: the process is exiting (or closed it on purpose).
			select {
			case <-proc.Done():
				return a.exitError(proc, "")
			case <-time.After(o.KillGrace):
				return errors.New("closed its stdout")
			case <-a.stopCh:
				a.shutdown(conn, proc)
				return nil
			}
		case <-a.hung:
			return errors.New("stopped reading its stdin (the outbound queue is full)")
		case <-a.stopCh:
			a.shutdown(conn, proc)
			info.logs.add("host", "", "stopped")
			return nil
		case <-ping.C:
			pctx, cancel := context.WithTimeout(context.Background(), o.PingTimeout)
			err := conn.Call(pctx, pluginsdk.MethodPing, struct{}{}, nil)
			cancel()
			if err == nil {
				misses = 0
				continue
			}
			misses++
			info.logs.add("host", "", fmt.Sprintf("missed ping %d: %v", misses, err))
			if misses >= 2 {
				return errors.New("not answering pings")
			}
		}
	}
}

// stderrSettle is how long a failed initialize waits for the process's exit, so a plugin
// that died on start reports its exit and last stderr line.
const stderrSettle = 300 * time.Millisecond

// hostCapabilities are what this host announces in initialize.
var hostCapabilities = []string{"invoke", "secrets", "log"}

// exitError describes how the process ended (or why it is being ended).
func (a *actor) exitError(proc *childproc.Process, why string) error {
	if why != "" {
		if l := proc.LastStderrLine(); l != "" {
			why += " (stderr: " + l + ")"
		}
		return errors.New(why)
	}
	msg := fmt.Sprintf("exited with status %d", proc.ExitCode())
	if proc.ExitCode() < 0 {
		msg = "was killed by a signal"
	}
	if l := proc.LastStderrLine(); l != "" {
		msg += ": " + l
	}
	return errors.New(msg)
}

// shutdown asks the plugin to stop, then closes stdin, then SIGTERM, then SIGKILL to
// its process group, each after the grace.
func (a *actor) shutdown(conn *pluginsdk.Conn, proc *childproc.Process) {
	o := a.m.opts
	ctx, cancel := context.WithTimeout(context.Background(), o.ShutdownTimeout)
	_ = conn.Call(ctx, pluginsdk.MethodShutdown, struct{}{}, nil)
	cancel()
	_ = proc.Stdin().Close()
	wait := func(d time.Duration) bool {
		select {
		case <-proc.Done():
			return true
		case <-time.After(d):
			return false
		}
	}
	if wait(o.ShutdownTimeout) {
		return
	}
	_ = proc.Signal(syscall.SIGTERM)
	if wait(o.KillGrace) {
		return
	}
	_ = proc.Signal(syscall.SIGKILL)
	wait(o.KillGrace)
}

// resolveExec makes the manifest's exec runnable: exec[0] with a slash must be an
// executable file inside the package directory; a bare name is looked up on PATH at
// start.
func resolveExec(dir string, exec []string) ([]string, error) {
	if len(exec) == 0 || exec[0] == "" {
		return nil, errors.New("plugin.json has no exec")
	}
	argv := slices.Clone(exec)
	if !strings.Contains(argv[0], "/") {
		return argv, nil
	}
	p := filepath.Join(dir, argv[0])
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return nil, fmt.Errorf("exec %s: %w", argv[0], err)
	}
	if !fsx.Within(dir, real) {
		return nil, fmt.Errorf("exec %s leaves the package directory", argv[0])
	}
	fi, err := os.Stat(real)
	if err != nil {
		return nil, fmt.Errorf("exec %s: %w", argv[0], err)
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o111 == 0 {
		return nil, fmt.Errorf("exec %s is not an executable file", argv[0])
	}
	argv[0] = real
	return argv, nil
}

// minimalEnv are the daemon's variables a plugin inherits; everything else is left out
// (never a thread's or the daemon's endpoint unless the api permission is granted).
var minimalEnv = []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"}

// pluginEnv is the plugin process's whole environment.
func (m *Manager) pluginEnv(name string, info spawnInfo, dataDir string) []string {
	var env []string
	for _, kv := range m.opts.Environ {
		k, _, _ := strings.Cut(kv, "=")
		if slices.Contains(minimalEnv, k) || strings.HasPrefix(k, "LC_") {
			env = append(env, kv)
		}
	}
	env = append(env,
		pluginsdk.EnvPlugin+"="+name,
		pluginsdk.EnvPluginDir+"="+info.dir,
		pluginsdk.EnvPluginData+"="+dataDir,
	)
	if info.manifest.Permissions.API && info.granted.API {
		env = append(env, m.opts.APIEnv...)
	}
	return env
}

// rateLimiter allows n events per second.
type rateLimiter struct {
	mu     sync.Mutex
	window time.Time
	count  int
}

func (r *rateLimiter) allow(now time.Time, n int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.window) >= time.Second {
		r.window, r.count = now, 0
	}
	r.count++
	return r.count <= n
}
