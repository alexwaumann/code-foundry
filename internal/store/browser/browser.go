// Package browser is the experimental Chrome surface's store (docs/notes/chrome-surface.md):
// one headless system Chrome per daemon, driven over --remote-debugging-pipe, and one page
// per surface, a side-panel tab the GUI draws from screencast frames.
//
// The store owns the process and never renders. A Viewer is one stream's view of a surface,
// and only the newest frame matters to it: frames that find the last one untaken replace it,
// and Chrome is acked for what a viewer took, so nothing queues behind a slow client.
//
// Everything here is off unless Options.Enabled says otherwise. Off means no process, no
// target and no viewer, and turning it off stops what ran.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"
)

// DefaultIdle is how long Chrome outlives the last visible surface.
const DefaultIdle = 10 * time.Minute

// startTimeout bounds a launch, from the process to the first answer.
const startTimeout = 20 * time.Second

// callTimeout bounds one protocol call that is not a navigation.
const callTimeout = 10 * time.Second

// navigateTimeout bounds a navigation up to the first byte of the page.
const navigateTimeout = time.Minute

// closeTimeout bounds asking Chrome to exit.
const closeTimeout = 2 * time.Second

// ErrDisabled refuses everything while the setting is off.
var ErrDisabled = errors.New("the Chrome surface is off (experimental.chrome_surface)")

// ErrClosed refuses everything once the daemon is stopping.
var ErrClosed = errors.New("the browser store is closed")

// ErrCrashed is a surface's state after Chrome died under it, until the user relaunches.
var ErrCrashed = errors.New("Chrome stopped unexpectedly")

// ErrNoSurface is a call for a surface nothing has opened.
var ErrNoSurface = errors.New("no such browser surface")

// ErrNotPending is an answer to something that is no longer asked.
var ErrNotPending = errors.New("that request is no longer waiting")

// Options configures a Store.
type Options struct {
	// Dir holds the profile and the downloads (<home>/browser).
	Dir string
	// Launch starts Chrome.
	Launch Launcher
	// Enabled reads the setting, live.
	Enabled func() bool
	// Idle is how long Chrome stays after the last viewer. Zero: DefaultIdle.
	Idle time.Duration
	// StartTimeout bounds a launch, from the process to its first answer. Zero: 20 s.
	StartTimeout time.Duration
	// Reveal shows a file in Finder.
	Reveal func(path string) error
	// SetClipboard writes the Mac's clipboard.
	SetClipboard func(ctx context.Context, text string) error
	Log          *slog.Logger
}

// Store owns the one Chrome and its surfaces.
type Store struct {
	opts Options
	log  *slog.Logger

	mu       sync.Mutex
	chrome   *instance
	starting chan struct{} // closed when the launch in progress has ended
	crashed  bool
	closed   bool
	surfaces map[string]*surface
	viewers  int
	idle     *time.Timer
}

// New returns a Store. Nothing runs until a surface is opened.
func New(opts Options) *Store {
	if opts.Idle <= 0 {
		opts.Idle = DefaultIdle
	}
	if opts.StartTimeout <= 0 {
		opts.StartTimeout = startTimeout
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Store{opts: opts, log: opts.Log, surfaces: map[string]*surface{}}
}

// Profile is the dedicated profile: the sign-ins live here, never in the user's own Chrome.
func (s *Store) Profile() string { return filepath.Join(s.opts.Dir, "profile") }

// Downloads is where a surface's downloads land.
func (s *Store) Downloads() string { return filepath.Join(s.opts.Dir, "downloads") }

// Running reports whether a Chrome is up.
func (s *Store) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.chrome != nil
}

// instance is one running Chrome.
type instance struct {
	proc     Process
	conn     *conn
	stopping bool
	targets  map[string]*target // by target id
	sessions map[string]*target // by session id
	clip     clipboard
}

// call is a protocol call bounded by callTimeout.
func (in *instance) call(ctx context.Context, session, method string, params, out any) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	return in.conn.call(ctx, session, method, params, out)
}

// running returns the Chrome, launching it on first use. Only one launch runs at a time; the
// others wait for it.
func (s *Store) running(ctx context.Context) (*instance, error) {
	for {
		s.mu.Lock()
		switch {
		case s.closed:
			s.mu.Unlock()
			return nil, ErrClosed
		case !s.opts.Enabled():
			s.mu.Unlock()
			return nil, ErrDisabled
		case s.crashed:
			s.mu.Unlock()
			return nil, ErrCrashed
		case s.chrome != nil:
			in := s.chrome
			s.mu.Unlock()
			return in, nil
		case s.starting != nil:
			wait := s.starting
			s.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		s.starting = done
		s.mu.Unlock()

		in, err := s.launch(ctx)

		s.mu.Lock()
		s.starting = nil
		close(done)
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		if s.closed || !s.opts.Enabled() {
			s.mu.Unlock()
			s.stop(in)
			continue
		}
		s.chrome = in
		s.mu.Unlock()
		return in, nil
	}
}

// launch starts a Chrome and readies it. Detached from the caller, which may be a stream that
// goes while Chrome comes up.
func (s *Store) launch(_ context.Context) (*instance, error) {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.StartTimeout)
	defer cancel()
	proc, err := s.opts.Launch(ctx, s.Profile())
	if err != nil {
		return nil, err
	}
	in := &instance{proc: proc, targets: map[string]*target{}, sessions: map[string]*target{}}
	w, r := proc.Pipes()
	in.conn = newConn(w, r,
		func(method, session string, params json.RawMessage) { s.event(in, method, session, params) },
		func(err error) { s.gone(in, err) })
	go func() {
		<-proc.Done()
		in.conn.close()
	}()
	var version struct {
		Product string `json:"product"`
	}
	if err := in.conn.call(ctx, "", "Browser.getVersion", nil, &version); err != nil {
		s.stop(in)
		return nil, fmt.Errorf("Chrome did not answer over its pipe, so it was stopped: %w%s", err, tailNote(proc))
	}
	if err := in.conn.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil); err != nil {
		s.stop(in)
		return nil, err
	}
	if err := in.conn.call(ctx, "", "Browser.setDownloadBehavior", map[string]any{
		"behavior": "allow", "downloadPath": s.Downloads(), "eventsEnabled": true,
	}, nil); err != nil {
		s.stop(in)
		return nil, err
	}
	s.log.Info("chrome started", "version", version.Product)
	return in, nil
}

func tailNote(p Process) string {
	if t := p.Tail(); t != "" {
		return ": " + t
	}
	return ""
}

// stop ends a Chrome on purpose. It never reports as a crash.
func (s *Store) stop(in *instance) {
	s.mu.Lock()
	in.stopping = true
	if s.chrome == in {
		s.chrome = nil
	}
	s.mu.Unlock()
	// Asked, Chrome is gone in a second and has written its profile. The pipe closing alone
	// also ends it, but takes five.
	ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
	defer cancel()
	_ = in.conn.call(ctx, "", "Browser.close", nil, nil)
	in.conn.close()
	in.proc.Stop()
}

// gone is the end of a connection, ours or not. A Chrome that ended on its own leaves every
// surface saying so, and stays down until Relaunch: restarting one that crashes on start
// would loop out of sight.
func (s *Store) gone(in *instance, cause error) {
	s.mu.Lock()
	expected := in.stopping
	if s.chrome == in {
		s.chrome = nil
	}
	for _, sf := range s.surfaces {
		sf.detach()
		if !expected {
			sf.state.Phase = PhaseCrashed
			sf.state.Message = "Chrome stopped unexpectedly."
			sf.publish()
		}
	}
	if !expected {
		s.crashed = true
	}
	s.mu.Unlock()
	if !expected {
		s.log.Warn("chrome stopped unexpectedly", "err", cause)
		s.log.Debug("chrome stderr", "tail", in.proc.Tail())
		go in.proc.Stop() // reaps any helper left in its group
	}
}

// ConfigChanged follows the setting: off stops Chrome and ends every viewer.
func (s *Store) ConfigChanged() {
	if s.opts.Enabled() {
		return
	}
	s.mu.Lock()
	in := s.chrome
	s.crashed = false
	for _, sf := range s.surfaces {
		sf.end(ErrDisabled)
	}
	s.surfaces = map[string]*surface{}
	s.viewers = 0
	s.stopIdleTimer()
	s.mu.Unlock()
	if in != nil {
		s.stop(in)
	}
}

// Relaunch is the way back from a crash: Chrome starts again and each surface shown returns
// to its last page.
func (s *Store) Relaunch(ctx context.Context) error {
	if !s.opts.Enabled() {
		return ErrDisabled
	}
	s.mu.Lock()
	s.crashed = false
	var shown []*surface
	for _, sf := range s.surfaces {
		if len(sf.viewers) > 0 {
			sf.state.Phase, sf.state.Message = PhaseStarting, ""
			sf.publish()
			shown = append(shown, sf)
		}
	}
	s.mu.Unlock()
	if _, err := s.running(ctx); err != nil {
		return err
	}
	for _, sf := range shown {
		go s.bringUp(sf)
	}
	return nil
}

// stopIdleTimer needs s.mu.
func (s *Store) stopIdleTimer() {
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
}

// startIdleTimer needs s.mu: no viewer is left anywhere.
func (s *Store) startIdleTimer() {
	s.stopIdleTimer()
	s.idle = time.AfterFunc(s.opts.Idle, s.idleStop)
}

// idleStop ends a Chrome nobody has looked at for Options.Idle. Its surfaces keep their last
// address, and the next view starts Chrome again.
func (s *Store) idleStop() {
	s.mu.Lock()
	in := s.chrome
	if s.viewers > 0 || in == nil {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.log.Info("chrome stopped: no surface shown")
	s.stop(in)
}

// Close stops Chrome for good, and every viewer with it. Safe to call twice.
func (s *Store) Close() {
	s.mu.Lock()
	s.closed = true
	in := s.chrome
	for _, sf := range s.surfaces {
		sf.end(ErrClosed)
	}
	s.stopIdleTimer()
	s.mu.Unlock()
	if in != nil {
		s.stop(in)
	}
}
