package plugin

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Defaults for Options (ARCHITECTURE.md §B.2 and §C.2 of the plugin design).
const (
	DefaultInitTimeout     = 5 * time.Second
	DefaultPingInterval    = 30 * time.Second
	DefaultPingTimeout     = 5 * time.Second
	DefaultShutdownTimeout = 2 * time.Second
	DefaultKillGrace       = 2 * time.Second
	DefaultBackoffBase     = time.Second
	DefaultBackoffMax      = 60 * time.Second
	DefaultDevBackoffMax   = 2 * time.Second
	// DefaultCrashLimit crashes within DefaultCrashWindow make a plugin failed.
	DefaultCrashLimit  = 5
	DefaultCrashWindow = 10 * time.Minute
	// DefaultStableAfter of running forgives earlier crashes.
	DefaultStableAfter = 10 * time.Minute
)

// CommandHost is the command registry as the plugin store uses it: the plugins'
// commands go in with ReplacePrefix, and host/invoke runs commands with Invoke.
// *command.Registry implements it.
type CommandHost interface {
	ReplacePrefix(prefix string, cmds []command.Command) error
	Invoke(ctx context.Context, uctx command.Context, name string, raw map[string]string, opts ...command.InvokeOption) (command.Result, error)
}

var _ CommandHost = (*command.Registry)(nil)

// Options configures a Manager. DB, Dir, DataDir, LogDir and Commands are required.
type Options struct {
	// Dir holds the packages (paths.Plugins), DataDir the plugins' own state
	// (paths.PluginData), LogDir their logs (paths.PluginLogs).
	Dir, DataDir, LogDir string
	DB                   *sql.DB
	Commands             CommandHost
	// Secrets keeps secret values (default Keychain{}).
	Secrets SecretStore
	Bus     *bus.Bus     // default: a private bus
	Log     *slog.Logger // default: slog.Default()
	// Home is the directory `plugin dev` folders must be inside ("" checks nothing).
	Home string
	// HostVersion is sent in initialize.
	HostVersion string
	// APIEnv ("KEY=VALUE": the loopback endpoint and token) is added to the environment of
	// a plugin granted the api permission.
	APIEnv []string
	// Environ is the daemon's environment the plugin's minimal one is taken from
	// (default os.Environ()).
	Environ []string
	Now     func() time.Time
	// Flags keeps the plugins' flags on threads (thread/setFlag; flags.go); nil refuses
	// thread/setFlag. The daemon passes the thread store.
	Flags ThreadFlags
	// Threads and Terminals keep the plugins' own threads and terminals (threads.go,
	// terminals.go); nil refuses thread/* and terminal/*. The daemon adapts its stores.
	Threads   OwnedThreads
	Terminals OwnedTerminals
	// Events is the daemon's event stream for events/subscribe (events.go); nil refuses
	// it. SetEvents sets it later (the API's handler needs the store first).
	Events EventFeed
	// EnvWait bounds how long a spawn waits for a starting plugin's session environment
	// (environment.go; default DefaultEnvWait).
	EnvWait time.Duration

	// Timing; zero values take the defaults above.
	InitTimeout, PingInterval, PingTimeout, ShutdownTimeout, KillGrace time.Duration
	BackoffBase, BackoffMax, DevBackoffMax, CrashWindow, StableAfter   time.Duration
	CrashLimit                                                         int
	LogMaxBytes                                                        int64
	LogTail                                                            int

	// Facts answers the predicates' host facts (threads, projects, pull request
	// checks); nil knows only the context's ids. Emitter sends UI intents (show
	// commands, host/invoke with confirm "ask", toasts); nil sends none.
	Facts   FactSource
	Emitter command.Emitter
	// Surface timing; zero values take DefaultSurfaceGrace, DefaultFirstViewTimeout and
	// DefaultCoalesce.
	SurfaceGrace, FirstViewTimeout, CoalesceInterval time.Duration
}

func (o *Options) defaults() {
	d := func(v *time.Duration, def time.Duration) {
		if *v <= 0 {
			*v = def
		}
	}
	d(&o.InitTimeout, DefaultInitTimeout)
	d(&o.PingInterval, DefaultPingInterval)
	d(&o.PingTimeout, DefaultPingTimeout)
	d(&o.ShutdownTimeout, DefaultShutdownTimeout)
	d(&o.KillGrace, DefaultKillGrace)
	d(&o.BackoffBase, DefaultBackoffBase)
	d(&o.BackoffMax, DefaultBackoffMax)
	d(&o.DevBackoffMax, DefaultDevBackoffMax)
	d(&o.CrashWindow, DefaultCrashWindow)
	d(&o.StableAfter, DefaultStableAfter)
	d(&o.SurfaceGrace, DefaultSurfaceGrace)
	d(&o.FirstViewTimeout, DefaultFirstViewTimeout)
	d(&o.CoalesceInterval, DefaultCoalesce)
	if o.CrashLimit <= 0 {
		o.CrashLimit = DefaultCrashLimit
	}
	if o.LogMaxBytes <= 0 {
		o.LogMaxBytes = DefaultLogMaxBytes
	}
	if o.LogTail <= 0 {
		o.LogTail = DefaultLogTail
	}
	if o.Secrets == nil {
		o.Secrets = Keychain{}
	}
	if o.Bus == nil {
		o.Bus = bus.New()
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Environ == nil {
		o.Environ = os.Environ()
	}
}

// Manager is the Store: discovery, consent, and one actor per enabled plugin.
type Manager struct {
	opts Options
	log  *slog.Logger

	// opMu serializes the operations that start and stop actors (Enable, Disable,
	// Restart, Dev, Reload, Close); they may wait for a plugin to stop.
	opMu sync.Mutex

	// mu guards entries and closed; reads use snap.
	mu      sync.Mutex
	entries map[string]*entry
	closed  bool
	snap    atomic.Pointer[Snapshot]

	// Surfaces and availability (surface.go, facts.go, show.go).
	surf     *surfaceHub
	preds    predicates
	ctxFacts contextFacts
	checks   checksCache
	avail    availabilityNotifier

	// env is the plugins' session environments (environment.go).
	env envState
}

var _ Store = (*Manager)(nil)

// entry is one known plugin. Fields are guarded by Manager.mu.
type entry struct {
	name     string
	link     string // <Dir>/<name>
	dir      string // link resolved
	dev      bool
	manifest pluginsdk.Manifest
	loadErr  string // "" when the manifest is valid
	warnings []string
	regErr   string
	row      row

	disabledReason string
	state          State
	pid            int
	startedAt      time.Time
	nextRestartAt  time.Time
	restarts       int
	lastError      string
	protocol       int
	caps           []string

	actor *actor
	logs  *logBuffer
}

// New returns a Manager with nothing loaded: Start scans the plugins dir and starts
// every enabled plugin (the daemon calls it once every command is registered, so a
// starting plugin's host/invoke finds them). Close it to stop the plugins.
func New(opts Options) (*Manager, error) {
	if opts.DB == nil || opts.Commands == nil || opts.Dir == "" || opts.DataDir == "" || opts.LogDir == "" {
		return nil, errors.New("plugin: Options.DB, Commands, Dir, DataDir and LogDir are required")
	}
	opts.defaults()
	for _, d := range []string{opts.Dir, opts.DataDir, opts.LogDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, fmt.Errorf("plugin: %w", err)
		}
	}
	m := &Manager{opts: opts, log: opts.Log, entries: map[string]*entry{}}
	m.avail.interval = availabilityInterval
	m.surf = newSurfaceHub(m)
	m.rebuildLocked()
	go m.surf.run()
	return m, nil
}

// Start scans the plugins dir, loads the user's choices and starts every enabled plugin
// (in parallel, without waiting for them).
func (m *Manager) Start(ctx context.Context) error {
	// The last session environments first: a plugin starting now may push a newer one.
	if err := m.loadEnvironments(ctx); err != nil {
		m.log.Warn("plugin: saved session environments", "err", err)
	}
	if err := m.Reload(ctx); err != nil {
		return err
	}
	m.sweep(ctx)
	return nil
}

// Bus returns the bus events are published on.
func (m *Manager) Bus() *bus.Bus { return m.opts.Bus }

// Snapshot implements Store.
func (m *Manager) Snapshot() *Snapshot { return m.snap.Load() }

// rebuildLocked publishes a new snapshot. m.mu held (or m owned exclusively).
func (m *Manager) rebuildLocked() {
	ps := make([]Plugin, 0, len(m.entries))
	for _, e := range m.entries {
		ps = append(ps, m.publicLocked(e))
	}
	slices.SortFunc(ps, func(a, b Plugin) int { return cmp.Compare(a.Name, b.Name) })
	m.snap.Store(&Snapshot{Plugins: ps})
}

// publishLocked rebuilds the snapshot and announces e. m.mu held.
func (m *Manager) publishLocked(e *entry) {
	m.rebuildLocked()
	bus.Publish[Event](m.opts.Bus, Changed{Plugin: m.publicLocked(e)})
}

func (m *Manager) publicLocked(e *entry) Plugin {
	p := Plugin{
		Name: e.name, Dir: e.dir, Dev: e.dev, Manifest: e.manifest, Enabled: e.row.Enabled,
		DisabledReason: e.disabledReason, ConsentedAt: e.row.ConsentedAt,
		State: e.state, PID: e.pid, StartedAt: e.startedAt, NextRestartAt: e.nextRestartAt,
		Restarts: e.restarts, LastError: e.lastError, Protocol: e.protocol, Capabilities: slices.Clone(e.caps),
		LogPath: e.logs.path,
	}
	if e.dev {
		p.DevPath = e.dir
	}
	if e.row.Granted != nil {
		g := *e.row.Granted
		p.Granted = &g
	}
	p.NeedsConsent = e.loadErr == "" && needsConsent(e.manifest.Permissions, e.row.Granted)
	p.Issues = slices.Clone(e.warnings)
	if e.regErr != "" {
		p.Issues = append(p.Issues, e.regErr)
	}
	p.Issues = append(p.Issues, m.predicateIssues(e.manifest)...)
	p.Issues = append(p.Issues, m.surf.issuesOf(e.name)...)
	if e.loadErr != "" {
		p.LastError = e.loadErr
	}
	return p
}

// needsConsent: never consented, or asking for more than was granted.
func needsConsent(p pluginsdk.Permissions, granted *pluginsdk.Permissions) bool {
	return granted == nil || !p.Within(*granted)
}

// update runs fn on the entry a belongs to and publishes it; nothing happens when the
// entry is gone or no longer a's (a stale actor). a nil applies to any entry.
func (m *Manager) update(name string, a *actor, fn func(e *entry)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[name]
	if e == nil || (a != nil && e.actor != a) {
		return
	}
	fn(e)
	m.publishLocked(e)
}

func (m *Manager) entry(name string) (*entry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.entries[name]
	return e, ok
}

// found is a package discovered on disk.
type found struct {
	link, dir string
	dev       bool
	manifest  pluginsdk.Manifest
	warnings  []string
	err       error
}

// discover scans Dir: every directory (or symlink to one) not starting with a dot.
func (m *Manager) discover() (map[string]found, error) {
	ents, err := os.ReadDir(m.opts.Dir)
	if err != nil {
		return nil, fmt.Errorf("plugin: scan %s: %w", m.opts.Dir, err)
	}
	out := map[string]found{}
	for _, de := range ents {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		link := filepath.Join(m.opts.Dir, name)
		fi, err := os.Stat(link)
		if err != nil || !fi.IsDir() {
			continue
		}
		f := found{link: link, dev: de.Type()&fs.ModeSymlink != 0}
		if f.dir, err = filepath.EvalSymlinks(link); err != nil {
			f.dir, f.err = link, err
		} else {
			f.manifest, f.warnings, f.err = readManifest(f.dir)
			if f.err == nil && f.manifest.Name != name {
				f.err = fmt.Errorf("the directory is %q but plugin.json names %q", name, f.manifest.Name)
			}
		}
		out[name] = f
	}
	return out, nil
}

// readManifest reads and validates dir/plugin.json.
func readManifest(dir string) (pluginsdk.Manifest, []string, error) {
	data, err := os.ReadFile(filepath.Join(dir, pluginsdk.ManifestFile))
	if err != nil {
		return pluginsdk.Manifest{}, nil, fmt.Errorf("read %s: %w", pluginsdk.ManifestFile, err)
	}
	return pluginsdk.LoadManifest(data)
}

// Reload implements Store.
func (m *Manager) Reload(ctx context.Context) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.reloadLocked(ctx)
}

// reloadLocked rescans Dir and applies what changed. opMu held.
func (m *Manager) reloadLocked(ctx context.Context) error {
	if m.isClosed() {
		return ErrClosed
	}
	pkgs, err := m.discover()
	if err != nil {
		return err
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(pkgs))
	for n := range pkgs {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, name := range names {
		m.apply(ctx, name, pkgs[name], rows[name], false)
	}
	m.mu.Lock()
	var gone []*entry
	for name, e := range m.entries {
		if _, ok := pkgs[name]; !ok {
			gone = append(gone, e)
		}
	}
	m.mu.Unlock()
	for _, e := range gone {
		m.stopActor(e, StateDisabled)
		m.unregister(e.name)
		m.forget(ctx, e.name, nil)
		m.mu.Lock()
		delete(m.entries, e.name)
		m.rebuildLocked()
		m.mu.Unlock()
		e.logs.close()
		bus.Publish[Event](m.opts.Bus, Removed{Name: e.name})
	}
	return nil
}

// apply brings the entry for name in line with what is on disk and in the database:
// it records the manifest, turns the plugin off when its manifest broke or its
// permissions grew, registers its commands, and starts, restarts (when the package
// changed, or always with restart) or leaves its actor. opMu held.
func (m *Manager) apply(ctx context.Context, name string, f found, r row, restart bool) {
	r.Name = name
	m.mu.Lock()
	e, ok := m.entries[name]
	if !ok {
		e = &entry{name: name, state: StateDisabled,
			logs: newLogBuffer(filepath.Join(m.opts.LogDir, name+".log"), m.opts.LogMaxBytes, m.opts.LogTail, m.opts.Now)}
		m.entries[name] = e
	}
	changed := e.dir != f.dir || !reflect.DeepEqual(e.manifest, f.manifest) || (e.loadErr == "") != (f.err == nil)
	e.link, e.dir, e.dev, e.manifest, e.warnings, e.row = f.link, f.dir, f.dev, f.manifest, f.warnings, r
	e.loadErr = ""
	if f.err != nil {
		e.loadErr = "manifest: " + f.err.Error()
	}
	running := e.actor != nil
	m.publishLocked(e)
	m.mu.Unlock()

	switch {
	case f.err != nil:
		m.stopActor(e, StateFailed)
		m.unregister(name)
		m.update(name, nil, func(e *entry) { e.state = StateFailed })
	case !r.Enabled:
		m.stopActor(e, StateDisabled)
		m.unregister(name)
	case needsConsent(f.manifest.Permissions, r.Granted):
		r.Enabled = false
		if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
			m.log.Warn("plugin: cannot record a permission change", "plugin", name, "err", err)
		}
		m.stopActor(e, StateDisabled)
		m.unregister(name)
		m.forget(ctx, name, e.logs)
		m.update(name, nil, func(e *entry) {
			e.row = r
			e.disabledReason = "its permissions changed: enable it again to review them"
		})
		e.logs.add("host", "", "disabled: the manifest asks for permissions that were not granted")
	default:
		m.register(e)
		if running && (changed || restart) {
			m.stopActor(e, StateStopped)
			running = false
		}
		if !running {
			m.startActor(e)
		}
	}
}

func (m *Manager) isClosed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closed
}

// startActor starts a fresh actor for e (crash counts reset). opMu held.
func (m *Manager) startActor(e *entry) {
	a := newActor(m, e.name)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	e.actor = a
	e.state, e.restarts, e.lastError, e.disabledReason, e.nextRestartAt = StateStarting, 0, "", "", time.Time{}
	m.publishLocked(e)
	m.mu.Unlock()
	go a.run()
}

// stopActor stops e's actor, if any, waits for it, and leaves e in final. opMu held.
func (m *Manager) stopActor(e *entry, final State) {
	m.mu.Lock()
	a := e.actor
	if a == nil {
		e.state = final
		m.publishLocked(e)
		m.mu.Unlock()
		return
	}
	e.state = StateStopping
	m.publishLocked(e)
	m.mu.Unlock()
	a.requestStop()
	<-a.done
	m.mu.Lock()
	if e.actor == a {
		e.actor = nil
	}
	e.state, e.pid, e.nextRestartAt = final, 0, time.Time{}
	m.publishLocked(e)
	m.mu.Unlock()
}

// Enable implements Store.
func (m *Manager) Enable(ctx context.Context, name string, consent bool) (EnableResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	return m.enableLocked(ctx, name, consent)
}

func (m *Manager) enableLocked(ctx context.Context, name string, consent bool) (EnableResult, error) {
	if m.isClosed() {
		return EnableResult{}, ErrClosed
	}
	e, ok := m.entry(name)
	if !ok {
		return EnableResult{}, fmt.Errorf("%w: no plugin %q in %s", ErrNotFound, name, m.opts.Dir)
	}
	m.mu.Lock()
	loadErr, mf, r := e.loadErr, e.manifest, e.row
	m.mu.Unlock()
	if loadErr != "" {
		return EnableResult{}, fmt.Errorf("%w: plugin %s cannot run: %s", ErrFailedPrecondition, name, loadErr)
	}
	needs := needsConsent(mf.Permissions, r.Granted)
	if needs && !consent {
		return EnableResult{Plugin: m.public(name), NeedsConsent: true, Consent: ConsentText(mf)}, nil
	}
	r.Name, r.Enabled = name, true
	if needs {
		g := mf.Permissions.Normalize()
		r.Granted, r.ConsentedAt = &g, m.opts.Now().Truncate(time.Millisecond)
	}
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return EnableResult{}, err
	}
	m.mu.Lock()
	e.row = r
	f := found{link: e.link, dir: e.dir, dev: e.dev, manifest: e.manifest, warnings: e.warnings}
	m.mu.Unlock()
	if needs {
		e.logs.add("host", "", "enabled with consent to: "+describe(mf.Permissions))
	}
	m.apply(ctx, name, f, r, false)
	return EnableResult{Plugin: m.public(name)}, nil
}

func describe(p pluginsdk.Permissions) string {
	d := p.Normalize().Describe()
	if len(d) == 0 {
		return "no permissions"
	}
	return strings.Join(d, "; ")
}

func (m *Manager) public(name string) Plugin {
	p, _ := m.Snapshot().Plugin(name)
	return p
}

// Disable implements Store.
func (m *Manager) Disable(ctx context.Context, name string) (Plugin, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return Plugin{}, ErrClosed
	}
	e, ok := m.entry(name)
	if !ok {
		return Plugin{}, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	m.mu.Lock()
	r := e.row
	m.mu.Unlock()
	r.Name, r.Enabled = name, false
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return Plugin{}, err
	}
	m.update(name, nil, func(e *entry) { e.row, e.disabledReason = r, "" })
	m.stopActor(e, StateDisabled)
	m.unregister(name)
	m.forget(ctx, name, e.logs)
	e.logs.add("host", "", "disabled")
	return m.public(name), nil
}

// Restart implements Store.
func (m *Manager) Restart(ctx context.Context, name string) (Plugin, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return Plugin{}, ErrClosed
	}
	e, ok := m.entry(name)
	if !ok {
		return Plugin{}, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	pkgs, err := m.discover()
	if err != nil {
		return Plugin{}, err
	}
	f, ok := pkgs[name]
	if !ok {
		return Plugin{}, fmt.Errorf("%w: plugin %s is no longer in %s", ErrNotFound, name, m.opts.Dir)
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return Plugin{}, err
	}
	r := rows[name]
	if !r.Enabled {
		m.apply(ctx, name, f, r, false)
		return Plugin{}, fmt.Errorf("%w: plugin %s is disabled: enable it first", ErrFailedPrecondition, name)
	}
	e.logs.add("host", "", "restart requested")
	m.apply(ctx, name, f, r, true)
	return m.public(name), nil
}

// Dev implements Store.
func (m *Manager) Dev(ctx context.Context, dir string, consent, dryRun bool) (EnableResult, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return EnableResult{}, ErrClosed
	}
	if !filepath.IsAbs(dir) {
		return EnableResult{}, fmt.Errorf("%w: %q is not an absolute path", ErrInvalidArgument, dir)
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(dir))
	if err != nil {
		return EnableResult{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	if m.opts.Home != "" && !fsx.Within(m.opts.Home, real) {
		return EnableResult{}, fmt.Errorf("%w: %s is outside your home directory", ErrInvalidArgument, real)
	}
	mf, warnings, err := readManifest(real)
	if err != nil {
		return EnableResult{}, fmt.Errorf("%w: %s: %v", ErrInvalidArgument, real, err)
	}
	name := mf.Name
	link := filepath.Join(m.opts.Dir, name)
	if fi, err := os.Lstat(link); err == nil && fi.Mode()&fs.ModeSymlink == 0 {
		return EnableResult{}, fmt.Errorf("%w: a plugin named %s is installed at %s; remove it first", ErrFailedPrecondition, name, link)
	}
	rows, err := loadRows(ctx, m.opts.DB)
	if err != nil {
		return EnableResult{}, err
	}
	r := rows[name]
	needs := needsConsent(mf.Permissions, r.Granted)
	if dryRun || (needs && !consent) {
		p := Plugin{Name: name, Dir: real, Dev: true, DevPath: real, Manifest: mf, Issues: warnings, State: StateDisabled, NeedsConsent: needs}
		if cur, ok := m.Snapshot().Plugin(name); ok {
			p.State, p.Enabled = cur.State, cur.Enabled
		}
		return EnableResult{Plugin: p, NeedsConsent: needs, Consent: ConsentText(mf)}, nil
	}
	if err := linkDir(real, link); err != nil {
		return EnableResult{}, err
	}
	r.Name, r.DevPath = name, real
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return EnableResult{}, err
	}
	if err := m.reloadLocked(ctx); err != nil {
		return EnableResult{}, err
	}
	return m.enableLocked(ctx, name, true)
}

// linkDir points link at target, replacing an existing symlink atomically.
func linkDir(target, link string) error {
	var b [4]byte
	_, _ = rand.Read(b[:])
	tmp := filepath.Join(filepath.Dir(link), ".link-"+hex.EncodeToString(b[:]))
	if err := os.Symlink(target, tmp); err != nil {
		return fmt.Errorf("plugin: link %s: %w", link, err)
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("plugin: link %s: %w", link, err)
	}
	return nil
}

// Logs implements Store.
func (m *Manager) Logs(name string, n int) ([]LogLine, error) {
	e, ok := m.entry(name)
	if !ok {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	return e.logs.tail(n), nil
}

// FollowLogs implements Store.
func (m *Manager) FollowLogs(ctx context.Context, name string, n int) (<-chan LogLine, error) {
	e, ok := m.entry(name)
	if !ok {
		return nil, fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	tail, live, cancel := e.logs.subscribe(n)
	out := make(chan LogLine, 64)
	go func() {
		defer close(out)
		defer cancel()
		for _, l := range tail {
			select {
			case out <- l:
			case <-ctx.Done():
				return
			}
		}
		for {
			select {
			case l, ok := <-live:
				if !ok {
					return
				}
				select {
				case out <- l:
				case <-ctx.Done():
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}

// Secrets implements Store.
func (m *Manager) Secrets(ctx context.Context, name string) ([]SecretInfo, error) {
	return listSecrets(ctx, m.opts.DB, name)
}

// DeleteSecret implements Store.
func (m *Manager) DeleteSecret(ctx context.Context, name, key string) error {
	if !secretKeyPattern.MatchString(key) {
		return fmt.Errorf("%w: %q is not a secret key", ErrInvalidArgument, key)
	}
	_, had, err := m.opts.Secrets.Get(ctx, name, key)
	if err != nil {
		return err
	}
	if err := m.opts.Secrets.Delete(ctx, name, key); err != nil {
		return err
	}
	recorded, err := dropSecret(ctx, m.opts.DB, name, key)
	if err != nil {
		return err
	}
	if !had && !recorded {
		return fmt.Errorf("%w: plugin %s has no secret %q", ErrNotFound, name, key)
	}
	if e, ok := m.entry(name); ok {
		e.logs.add("host", "", "secret deleted by the user: "+key)
	}
	return nil
}

// Close stops every plugin (shutdown, then SIGTERM, then SIGKILL) and waits.
func (m *Manager) Close() error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	es := make([]*entry, 0, len(m.entries))
	for _, e := range m.entries {
		es = append(es, e)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, e := range es {
		wg.Go(func() { m.stopActor(e, StateStopped) })
	}
	wg.Wait()
	m.surf.close()
	for _, e := range es {
		e.logs.close()
	}
	return nil
}
