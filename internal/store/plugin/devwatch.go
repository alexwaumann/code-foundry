package plugin

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// `plugin dev --watch` (docs/notes/plugin-dev-watch.md): one goroutine per watched dev
// plugin polls its folder, and after an edit runs its build (devbuild.go) and restarts
// it. Polling, not FSEvents: the cgo stream belongs to the project store, which this
// store may not import, and a dev folder is small.

const (
	// DefaultDevWatchInterval is how often a watched dev folder is scanned.
	DefaultDevWatchInterval = 500 * time.Millisecond
	// devWatchMaxFiles caps a watched folder: over it the watch stops.
	devWatchMaxFiles = 5000
	// devStartWait bounds how long a build's restart is waited for beyond InitTimeout.
	devStartWait = 2 * time.Second
)

// DevBuildState is where a watched dev plugin's last build is.
type DevBuildState int

const (
	// DevBuildNone: nothing built since the watch began.
	DevBuildNone DevBuildState = iota
	DevBuildRunning
	DevBuildOK
	DevBuildFailed
)

// DevBuild is a watched dev plugin's build command and its last build.
type DevBuild struct {
	Command    string
	State      DevBuildState
	ExitCode   int // the failed build's exit status; -1 when it timed out or did not start
	FinishedAt time.Time
}

// devSkipped are names never scanned, at any depth (dot entries are skipped too).
var devSkipped = map[string]bool{"bin": true, "dist": true, "node_modules": true}

// fileSig is one scanned file.
type fileSig struct {
	size  int64
	mtime time.Time
	hash  [sha256.Size]byte
}

// devScan is a folder's files by relative path.
type devScan map[string]fileSig

// sameContent: the same files with the same contents (mtimes do not matter, so an
// identical rewrite is no change).
func (s devScan) sameContent(o devScan) bool {
	return maps.EqualFunc(s, o, func(a, b fileSig) bool { return a.hash == b.hash })
}

var errTooManyFiles = fmt.Errorf("over %d files", devWatchMaxFiles)

// scanDev walks dir, hashing a file only when its size or mtime differs from prev.
// skip is a top-level name left out (the folder of the manifest's exec).
func scanDev(dir, skip string, prev devScan) (devScan, error) {
	out := devScan{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == dir {
				return err
			}
			return nil // gone mid-walk, or unreadable: as if absent
		}
		if p == dir {
			return nil
		}
		name := d.Name()
		rel, _ := filepath.Rel(dir, p)
		if strings.HasPrefix(name, ".") || devSkipped[name] || (skip != "" && rel == skip) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // directories are walked; symlinks and the rest are not followed
		}
		if len(out) >= devWatchMaxFiles {
			return errTooManyFiles
		}
		fi, err := d.Info()
		if err != nil {
			return nil
		}
		sig := fileSig{size: fi.Size(), mtime: fi.ModTime()}
		if old, ok := prev[rel]; ok && old.size == sig.size && old.mtime.Equal(sig.mtime) {
			sig.hash = old.hash
		} else if sig.hash, err = hashFile(p); err != nil {
			return nil
		}
		out[rel] = sig
		return nil
	})
	return out, err
}

func hashFile(p string) ([sha256.Size]byte, error) {
	var sum [sha256.Size]byte
	f, err := os.Open(p)
	if err != nil {
		return sum, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return sum, err
	}
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

// execSkip is the top-level name of the manifest's exec[0] when it is in the package
// ("bin/x" → "bin", "x.sh" with a slash prefix → "x.sh"); "" for a PATH lookup.
func execSkip(exec []string) string {
	if len(exec) == 0 || !strings.Contains(exec[0], "/") {
		return ""
	}
	p := filepath.Clean(exec[0])
	if filepath.IsAbs(p) || strings.HasPrefix(p, "..") {
		return ""
	}
	top, _, _ := strings.Cut(p, string(filepath.Separator))
	return top
}

// devWatchState is the Manager's watchers.
type devWatchState struct {
	mu     sync.Mutex
	w      map[string]*devWatcher
	closed bool
	wg     sync.WaitGroup
	// ticker makes a watcher's scan ticks (tests send their own); ticked, when set, hears
	// of each tick once it is handled (a build included).
	ticker func(d time.Duration) (<-chan time.Time, func())
	ticked chan struct{}
}

func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// devWatchConfig is what a watcher reads from its entry.
type devWatchConfig struct {
	dir, build, skip string
}

// devWatcher watches one dev plugin's folder.
type devWatcher struct {
	m      *Manager
	name   string
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	reqs   chan devRequest

	mu  sync.Mutex
	cfg devWatchConfig
	// rebase: the folder changed, take the next scan as it is.
	rebase bool
}

// devRequest is a settle (force false) or a build now (force true).
type devRequest struct {
	force bool
	reply chan error
}

// syncDevWatch starts, updates or stops name's watcher to match its entry: a dev
// plugin, enabled, with the watch on. It never waits for a watcher to stop (the
// watcher itself restarts the plugin, which lands here).
func (m *Manager) syncDevWatch(name string) {
	m.mu.Lock()
	e := m.entries[name]
	want := e != nil && e.dev && e.row.DevWatch && e.row.Enabled && !m.closed
	var cfg devWatchConfig
	if want {
		cfg = devWatchConfig{dir: e.dir, build: devBuildCommand(e.row.DevBuild), skip: execSkip(e.manifest.Exec)}
	}
	m.mu.Unlock()
	dw := &m.devw
	dw.mu.Lock()
	defer dw.mu.Unlock()
	w := dw.w[name]
	switch {
	case want && w == nil && !dw.closed:
		ctx, cancel := context.WithCancel(context.Background())
		w = &devWatcher{m: m, name: name, ctx: ctx, cancel: cancel, done: make(chan struct{}), reqs: make(chan devRequest), cfg: cfg}
		if dw.w == nil {
			dw.w = map[string]*devWatcher{}
		}
		dw.w[name] = w
		ticks, stop := dw.ticker(m.opts.DevWatchInterval)
		m.update(name, nil, func(e *entry) { e.devWatchOff = "" })
		dw.wg.Go(func() {
			defer stop()
			w.run(ticks)
		})
	case want && w != nil:
		w.mu.Lock()
		if w.cfg.dir != cfg.dir || w.cfg.skip != cfg.skip {
			w.rebase = true
		}
		w.cfg = cfg
		w.mu.Unlock()
	case !want && w != nil:
		w.cancel()
		delete(dw.w, name)
	}
}

// stopDevWatches stops every watcher and waits for them; none starts after it. It is
// called without opMu: a watcher may be restarting its plugin.
func (m *Manager) stopDevWatches() {
	dw := &m.devw
	dw.mu.Lock()
	dw.closed = true
	for name, w := range dw.w {
		w.cancel()
		delete(dw.w, name)
	}
	dw.mu.Unlock()
	dw.wg.Wait()
}

// syncDevWatchGone stops the watcher of a plugin whose package is gone.
func (m *Manager) syncDevWatchGone(name string) {
	m.devw.mu.Lock()
	defer m.devw.mu.Unlock()
	if w := m.devw.w[name]; w != nil {
		w.cancel()
		delete(m.devw.w, name)
	}
}

func (m *Manager) devWatcher(name string) *devWatcher {
	m.devw.mu.Lock()
	defer m.devw.mu.Unlock()
	return m.devw.w[name]
}

// ask sends r to the watcher and waits for its answer.
func (w *devWatcher) ask(ctx context.Context, force bool) error {
	r := devRequest{force: force, reply: make(chan error, 1)}
	select {
	case w.reqs <- r:
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-r.reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DevSettle implements Surfaces: for a watched dev plugin, scan its folder now and
// wait for the build and restart of any change (one in flight included). It fails when
// that build, or the last one with nothing changed since, failed. A plugin not watched
// returns at once.
func (m *Manager) DevSettle(ctx context.Context, name string) error {
	w := m.devWatcher(name)
	if w == nil {
		return nil
	}
	return w.ask(ctx, false)
}

// SetDevWatch turns the watch of dev plugin name on or off and sets its build command
// ("" keeps the one it has; with the watch on, "" is DefaultDevBuild). Turning it on (or
// on again) builds and restarts the plugin now and waits: a failed build is an error
// quoting its last lines, and the running plugin is left as it was.
func (m *Manager) SetDevWatch(ctx context.Context, name string, on bool, build string) (Plugin, error) {
	if err := m.setDevWatchRow(ctx, name, on, build); err != nil {
		return Plugin{}, err
	}
	if !on {
		return m.public(name), nil
	}
	w := m.devWatcher(name)
	if w == nil {
		p := m.public(name)
		return p, fmt.Errorf("%w: plugin %s is not watched (state %s): enable it first", ErrFailedPrecondition, name, p.State)
	}
	if err := w.ask(ctx, true); err != nil {
		return m.public(name), err
	}
	return m.public(name), nil
}

func (m *Manager) setDevWatchRow(ctx context.Context, name string, on bool, build string) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if m.isClosed() {
		return ErrClosed
	}
	e, ok := m.entry(name)
	if !ok {
		return fmt.Errorf("%w: no plugin %q", ErrNotFound, name)
	}
	m.mu.Lock()
	dev, r := e.dev, e.row
	m.mu.Unlock()
	if !dev {
		return fmt.Errorf("%w: plugin %s is not a dev plugin (link it with `code-foundry plugin dev <folder>`)", ErrFailedPrecondition, name)
	}
	r.Name, r.DevWatch = name, on
	if b := strings.TrimSpace(build); b != "" {
		r.DevBuild = b
	}
	if err := saveRow(ctx, m.opts.DB, r, m.opts.Now()); err != nil {
		return err
	}
	m.update(name, nil, func(e *entry) {
		e.row = r
		if !on {
			e.devBuild = DevBuild{}
		}
	})
	if on {
		e.logs.add("host", "", "watching "+e.dir+" (build: "+devBuildCommand(r.DevBuild)+")")
	} else {
		e.logs.add("host", "", "stopped watching")
	}
	m.syncDevWatch(name)
	return nil
}

// run scans on every tick and builds once a change holds for two scans in a row;
// requests scan at once.
func (w *devWatcher) run(ticks <-chan time.Time) {
	defer close(w.done)
	logs := w.logs()
	if logs == nil {
		return
	}
	var cache, base, pending devScan
	var lastErr error
	scan := func() (devScan, bool) {
		w.mu.Lock()
		cfg, rebase := w.cfg, w.rebase
		w.rebase = false
		w.mu.Unlock()
		s, err := scanDev(cfg.dir, cfg.skip, cache)
		switch {
		case errors.Is(err, errTooManyFiles):
			logs.add("host", "", fmt.Sprintf("stopped watching %s: it has over %d files (bin, dist, node_modules and dot entries are skipped)", cfg.dir, devWatchMaxFiles))
			w.m.update(w.name, nil, func(e *entry) { e.devWatchOff = "over " + fmt.Sprint(devWatchMaxFiles) + " files" })
			return nil, false
		case err != nil:
			s = cache // the folder is unreadable for now: no change
		}
		cache = s
		if rebase || base == nil {
			base = s
		}
		return s, true
	}
	if _, ok := scan(); !ok {
		return
	}
	for {
		select {
		case <-w.ctx.Done():
			return
		case r := <-w.reqs:
			cur, ok := scan()
			if !ok {
				r.reply <- nil
				return
			}
			if r.force || !cur.sameContent(base) {
				base, pending = cur, nil
				var reply error
				reply, lastErr = w.build()
				if r.force {
					r.reply <- reply
					continue
				}
			}
			r.reply <- lastErr
		case <-ticks:
			cur, ok := scan()
			if !ok {
				return
			}
			switch {
			case cur.sameContent(base):
				pending = nil
			case pending != nil && cur.sameContent(pending):
				base, pending = cur, nil
				_, lastErr = w.build()
			default:
				pending = cur
			}
			if t := w.m.devw.ticked; t != nil {
				t <- struct{}{}
			}
		}
	}
}

func (w *devWatcher) logs() *logBuffer {
	e, ok := w.m.entry(w.name)
	if !ok {
		return nil
	}
	return e.logs
}

// build runs the build and, when it succeeds, restarts the plugin and waits for it to
// start. Both errors are nil on success; on a failure first quotes the build's last
// lines (SetDevWatch's answer) and settle points at the log (DevSettle's, until the next
// build).
func (w *devWatcher) build() (first, settle error) {
	m := w.m
	logs := w.logs()
	if logs == nil {
		return nil, nil
	}
	w.mu.Lock()
	cfg := w.cfg
	w.mu.Unlock()
	m.update(w.name, nil, func(e *entry) { e.devBuild.State = DevBuildRunning })
	logs.add("host", "", "building: "+cfg.build)
	res := m.runDevBuild(w.ctx, cfg.dir, cfg.build, logs)
	if w.ctx.Err() != nil {
		return nil, nil // the watch stopped (the daemon closing, the watch turned off)
	}
	now := m.opts.Now()
	if !res.ok() {
		msg := res.summary(m.opts.DevBuildTimeout) + "; the running plugin is unchanged"
		logs.add("host", "", msg)
		m.update(w.name, nil, func(e *entry) {
			e.devBuild = DevBuild{State: DevBuildFailed, ExitCode: res.exit, FinishedAt: now}
		})
		return fmt.Errorf("%w: %s:\n%s", ErrFailedPrecondition, msg, strings.Join(res.tail, "\n")),
			fmt.Errorf("%w: plugin %s: %w: code-foundry plugin logs %s", ErrFailedPrecondition, w.name, errDevBuildFailed, w.name)
	}
	m.update(w.name, nil, func(e *entry) {
		e.devBuild = DevBuild{State: DevBuildOK, FinishedAt: now}
	})
	sub := bus.Subscribe[Event](m.opts.Bus, 64)
	defer sub.Close()
	p, err := m.Restart(w.ctx, w.name)
	if err != nil {
		logs.add("host", "", fmt.Sprintf("build ok in %s; restart failed: %v", roundDuration(res.took), err))
		return err, err
	}
	if !p.Enabled {
		dir := cfg.dir
		if p.DevPath != "" {
			dir = p.DevPath
		}
		grew := fmt.Sprintf("its permissions grew, so it was disabled: run `code-foundry plugin dev %s --yes` to review them and enable it again", dir)
		logs.add("host", "", "build ok in "+roundDuration(res.took)+"; "+grew)
		err := fmt.Errorf("%w: plugin %s: %s", ErrFailedPrecondition, w.name, grew)
		return err, err
	}
	logs.add("host", "", fmt.Sprintf("build ok in %s; restarted", roundDuration(res.took)))
	w.waitStarted(sub)
	return nil, nil
}

// waitStarted waits until the restarted plugin is no longer starting (running, crashed
// or failed), at most InitTimeout and a little.
func (w *devWatcher) waitStarted(sub *bus.Subscription[Event]) {
	limit := time.NewTimer(w.m.opts.InitTimeout + devStartWait)
	defer limit.Stop()
	settled := func() bool {
		p, ok := w.m.Snapshot().Plugin(w.name)
		return !ok || (p.State != StateStarting && p.State != StateStopping)
	}
	for !settled() {
		select {
		case <-sub.C():
		case <-limit.C:
			return
		case <-w.ctx.Done():
			return
		}
	}
}

// roundDuration is d to a tenth of a second (1.4s), or to the millisecond under one
// (42ms).
func roundDuration(d time.Duration) string {
	if d < time.Second {
		return d.Round(time.Millisecond).String()
	}
	return d.Round(100 * time.Millisecond).String()
}
