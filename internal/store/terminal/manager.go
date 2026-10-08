package terminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/awaumann/code-foundry/internal/bus"
)

// Options configures a Manager. Zero values take the documented defaults.
type Options struct {
	Bus    *bus.Bus     // events are published here; default: a private bus
	Logger *slog.Logger // default: slog.Default()
	// MaxScrollbackLines bounds each emulator's scrollback. Default 10,000.
	MaxScrollbackLines uint
	// MaxScrollbackBytes is a safety cap on scrollback memory, so that the line limit
	// is what normally applies. Default 64 MiB (10,000 rows at 250 columns is ~21 MiB
	// uncompressed).
	MaxScrollbackBytes uint
	// CompressAfter is how long a terminal must be idle (no output, attach, or
	// resize) before its scrollback is compressed. Default 2s.
	CompressAfter time.Duration
	// KillGrace is the delay between SIGHUP and SIGKILL. Default 3s.
	KillGrace time.Duration
	// MetadataInterval throttles title/alt-screen updates per terminal. Default 50ms
	// (at most 20 updates per second).
	MetadataInterval time.Duration
	// SubscriberBuffer is the per-Attach channel capacity in events. Default 256.
	SubscriberBuffer int
	// Now is the clock. Default time.Now.
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.Bus == nil {
		o.Bus = bus.New()
	}
	if o.Logger == nil {
		o.Logger = slog.Default()
	}
	if o.MaxScrollbackLines == 0 {
		o.MaxScrollbackLines = 10_000
	}
	if o.MaxScrollbackBytes == 0 {
		o.MaxScrollbackBytes = 64 << 20
	}
	if o.CompressAfter <= 0 {
		o.CompressAfter = 2 * time.Second
	}
	if o.KillGrace <= 0 {
		o.KillGrace = 3 * time.Second
	}
	if o.MetadataInterval <= 0 {
		o.MetadataInterval = 50 * time.Millisecond
	}
	if o.SubscriberBuffer < 2 {
		o.SubscriberBuffer = 256
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// maxDimension guards against absurd sizes from clients.
const maxDimension = 4096

// Manager is the PTY-backed Store.
type Manager struct {
	opts  Options
	drops atomic.Uint64

	mu     sync.RWMutex
	actors map[string]*actor
	closed bool
}

var _ Store = (*Manager)(nil)

// New returns an empty Manager.
func New(opts Options) *Manager {
	return &Manager{opts: opts.withDefaults(), actors: make(map[string]*actor)}
}

// DroppedSubscribers counts Attach subscribers disconnected for falling behind.
func (m *Manager) DroppedSubscribers() uint64 { return m.drops.Load() }

// Create spawns spec.Argv on a new PTY.
func (m *Manager) Create(ctx context.Context, spec Spec) (Terminal, error) {
	if err := ctx.Err(); err != nil {
		return Terminal{}, err
	}
	cmd, info, err := m.prepare(spec)
	if err != nil {
		return Terminal{}, err
	}
	master, err := startPTY(cmd, info.Cols, info.Rows)
	if err != nil {
		return Terminal{}, err
	}
	info.Pid = cmd.Process.Pid
	info.StartedAt = m.opts.Now()

	log := m.opts.Logger.With("terminal", info.ID, "pid", info.Pid)
	a := newActor(info.ID, cmd, master, info, m.opts.Bus, log, m.opts, &m.drops)
	a.observer = spec.Observer
	ready := make(chan error, 1)
	go a.run(ready)
	if err := <-ready; err != nil {
		_ = signalGroup(info.Pid, syscall.SIGKILL)
		_ = master.Close()
		go func() { _ = cmd.Wait() }()
		return Terminal{}, err
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		_ = a.call(context.Background(), func() { _ = a.remove(true) })
		return Terminal{}, ErrClosed
	}
	m.actors[info.ID] = a
	m.mu.Unlock()

	bus.Publish(m.opts.Bus, TerminalUpdated{Terminal: info})
	log.Info("terminal started", "argv", info.Argv, "cwd", info.Cwd, "size", fmt.Sprintf("%dx%d", info.Cols, info.Rows))
	return info, nil
}

// prepare validates spec and builds the command and initial metadata.
func (m *Manager) prepare(spec Spec) (*exec.Cmd, Terminal, error) {
	if len(spec.Argv) == 0 || spec.Argv[0] == "" {
		return nil, Terminal{}, fmt.Errorf("%w: empty argv", ErrInvalidSpec)
	}
	cols, rows := spec.Cols, spec.Rows
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	if cols > maxDimension || rows > maxDimension {
		return nil, Terminal{}, fmt.Errorf("%w: size %dx%d", ErrInvalidSpec, cols, rows)
	}
	cwd := spec.Cwd
	if cwd == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, Terminal{}, fmt.Errorf("default cwd: %w", err)
		}
		cwd = home
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, Terminal{}, fmt.Errorf("%w: cwd %q is not a directory", ErrInvalidSpec, cwd)
	}
	env := mergeEnv(os.Environ(), defaultEnv, spec.Env)
	path, err := lookPath(spec.Argv[0], env, isExecutable)
	if err != nil {
		return nil, Terminal{}, err
	}
	id, err := newID()
	if err != nil {
		return nil, Terminal{}, err
	}

	cmd := &exec.Cmd{Path: path, Args: slices.Clone(spec.Argv), Env: env, Dir: cwd}
	info := Terminal{
		ID:     id,
		Argv:   slices.Clone(spec.Argv),
		Cwd:    cwd,
		Cols:   cols,
		Rows:   rows,
		State:  StateRunning,
		Labels: maps.Clone(spec.Labels),
	}
	return cmd, info, nil
}

func newID() (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("terminal id: %w", err)
	}
	return "t-" + hex.EncodeToString(b[:]), nil
}

func (m *Manager) actor(id string) (*actor, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.actors[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	return a, nil
}

// List returns all terminals ordered by start time.
func (m *Manager) List(context.Context) []Terminal {
	m.mu.RLock()
	out := make([]Terminal, 0, len(m.actors))
	for _, a := range m.actors {
		out = append(out, *a.info.Load())
	}
	m.mu.RUnlock()
	slices.SortFunc(out, func(x, y Terminal) int {
		if c := x.StartedAt.Compare(y.StartedAt); c != 0 {
			return c
		}
		return strings.Compare(x.ID, y.ID)
	})
	return out
}

// Get returns one terminal.
func (m *Manager) Get(_ context.Context, id string) (Terminal, error) {
	a, err := m.actor(id)
	if err != nil {
		return Terminal{}, err
	}
	return *a.info.Load(), nil
}

// Write queues input for the PTY. It does not wait for the program to read it.
func (m *Manager) Write(_ context.Context, id string, data []byte) error {
	a, err := m.actor(id)
	if err != nil {
		return err
	}
	if err := a.input.push(data, true); err != nil {
		return err
	}
	if a.observer != nil {
		// Observers run on the actor only. Hop there without blocking the caller; the
		// queued write already happened, so a late or dropped notification is harmless.
		in := append([]byte(nil), data...)
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = a.call(ctx, func() { a.observe(ObserveEvent{Input: in}) })
		}()
	}
	return nil
}

// Resize applies a new size to the PTY (TIOCSWINSZ, which signals SIGWINCH) and the
// emulator, and emits Resized to attached subscribers.
func (m *Manager) Resize(ctx context.Context, id string, cols, rows uint16) error {
	if cols == 0 || rows == 0 || cols > maxDimension || rows > maxDimension {
		return fmt.Errorf("%w: size %dx%d", ErrInvalidSpec, cols, rows)
	}
	a, err := m.actor(id)
	if err != nil {
		return err
	}
	var rerr error
	if err := a.call(ctx, func() { rerr = a.resize(cols, rows) }); err != nil {
		return err
	}
	return rerr
}

// Kill hangs up the process group, escalating to SIGKILL after Options.KillGrace.
func (m *Manager) Kill(ctx context.Context, id string) error {
	a, err := m.actor(id)
	if err != nil {
		return err
	}
	var kerr error
	if err := a.call(ctx, func() { kerr = a.kill(m.opts.KillGrace) }); err != nil {
		return err
	}
	return kerr
}

// Remove forgets an exited terminal.
func (m *Manager) Remove(ctx context.Context, id string) error {
	a, err := m.actor(id)
	if err != nil {
		return err
	}
	var rerr error
	if err := a.call(ctx, func() { rerr = a.remove(false) }); err != nil {
		return err
	}
	if rerr != nil {
		return rerr
	}
	m.mu.Lock()
	delete(m.actors, id)
	m.mu.Unlock()
	bus.Publish(m.opts.Bus, TerminalRemoved{ID: id})
	return nil
}

// Attach subscribes to a terminal. See AttachEvent for the event sequence.
func (m *Manager) Attach(ctx context.Context, id string) (<-chan AttachEvent, error) {
	a, err := m.actor(id)
	if err != nil {
		return nil, err
	}
	var ch chan AttachEvent
	var aerr error
	if err := a.call(ctx, func() { ch, aerr = a.attach() }); err != nil {
		return nil, err
	}
	if aerr != nil {
		return nil, aerr
	}
	go func() {
		select {
		case <-ctx.Done():
			_ = a.call(context.Background(), func() { a.detach(ch) })
		case <-a.done:
		}
	}()
	return ch, nil
}

// ScreenText returns the active screen as plain text. See Store.ScreenText.
func (m *Manager) ScreenText(ctx context.Context, id string) (string, error) {
	a, err := m.actor(id)
	if err != nil {
		return "", err
	}
	var text string
	var terr error
	if err := a.call(ctx, func() { text, terr = a.screenText() }); err != nil {
		return "", err
	}
	return text, terr
}

// Watch merges TerminalUpdated and TerminalRemoved bus events into one channel.
func (m *Manager) Watch(ctx context.Context) (<-chan Event, error) {
	return watchBus(ctx, m.opts.Bus), nil
}

// watchBus is shared with terminaltest.Fake through the exported WatchBus.
func watchBus(ctx context.Context, b *bus.Bus) <-chan Event {
	updated := bus.Subscribe[TerminalUpdated](b, 256)
	removed := bus.Subscribe[TerminalRemoved](b, 256)
	out := make(chan Event, 64)
	go func() {
		defer close(out)
		defer updated.Close()
		defer removed.Close()
		for {
			var ev Event
			select {
			case <-ctx.Done():
				return
			case u := <-updated.C():
				ev.Updated = &u.Terminal
			case r := <-removed.C():
				ev.RemovedID = r.ID
			}
			select {
			case out <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// WatchBus adapts a bus carrying TerminalUpdated/TerminalRemoved to Store.Watch. It is
// exported for fakes.
func WatchBus(ctx context.Context, b *bus.Bus) <-chan Event { return watchBus(ctx, b) }

// Close hangs up every running terminal, waits up to KillGrace (bounded by ctx) for
// them to exit, kills the rest, and releases all emulators. The Manager is unusable
// afterwards.
func (m *Manager) Close(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	actors := slices.Collect(maps.Values(m.actors))
	m.actors = map[string]*actor{}
	m.mu.Unlock()

	for _, a := range actors {
		_ = a.call(ctx, func() { _ = a.kill(m.opts.KillGrace) })
	}
	deadline := time.NewTimer(m.opts.KillGrace)
	defer deadline.Stop()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
wait:
	for {
		running := 0
		for _, a := range actors {
			if a.info.Load().State == StateRunning {
				running++
			}
		}
		if running == 0 {
			break
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			break wait
		case <-ctx.Done():
			break wait
		}
	}
	var errs []error
	for _, a := range actors {
		if a.info.Load().State == StateRunning {
			_ = signalGroup(a.info.Load().Pid, syscall.SIGKILL)
		}
		if err := a.call(context.Background(), func() { _ = a.remove(true) }); err != nil && !errors.Is(err, ErrNotFound) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
